const express = require("express");
const db = require("../db");
const { requireAdmin } = require("../utils/auth");

const router = express.Router();
const usersCol = db.collection("users");
const ordersCol = db.collection("orders");

/* Pulls every user + every order once and folds them together in memory.
   Fine at this app's scale (a single college's worth of accounts/orders);
   if that ever changes, this is the one place that would need to move to
   per-user aggregate counters instead of a full-collection scan. */
async function loadUsersWithStats() {
  const [usersSnap, ordersSnap] = await Promise.all([usersCol.get(), ordersCol.get()]);

  const statsByMobile = new Map();
  ordersSnap.forEach((doc) => {
    const o = doc.data();
    const key = o.userMobile;
    if (!key) return;
    const cur = statsByMobile.get(key) || { ordersPlaced: 0, cancelledOrders: 0, totalSpent: 0 };
    cur.ordersPlaced += 1;
    if (o.status === "cancelled") {
      cur.cancelledOrders += 1;
    } else {
      cur.totalSpent += o.total || 0;
    }
    statsByMobile.set(key, cur);
  });

  const users = [];
  usersSnap.forEach((doc) => {
    const u = doc.data();
    const stats = statsByMobile.get(u.mobile) || { ordersPlaced: 0, cancelledOrders: 0, totalSpent: 0 };
    users.push({
      id: doc.id,
      username: u.username,
      mobile: u.mobile,
      email: u.email,
      createdAt: u.createdAt || null,
      blocked: !!u.blocked,
      ordersPlaced: stats.ordersPlaced,
      cancelledOrders: stats.cancelledOrders,
      activeOrders: stats.ordersPlaced - stats.cancelledOrders,
      totalSpent: stats.totalSpent,
    });
  });
  return users;
}

/* Top-of-panel counters: total registered accounts, and how many of them
   have placed at least one order (each user counted once, regardless of
   how many orders they've placed). */
router.get("/stats", requireAdmin, async (req, res) => {
  try {
    const users = await loadUsersWithStats();
    const totalRegistered = users.length;
    const totalOrderedUsers = users.filter((u) => u.ordersPlaced > 0).length;
    res.json({ ok: true, totalRegistered, totalOrderedUsers });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't load customer stats." });
  }
});

/* Searchable, sortable customer list.
   - q: matched case-insensitively against username, email, and mobile.
        The response's `matched` count is exactly how many accounts match
        — e.g. searching "o21" tells the admin how many registered users
        have "o21" anywhere in their name/email/mobile, not just the page
        of results shown.
   - sort: "recent" (default, newest first), "orders" (most orders placed,
     cancelled ones excluded), or "spent" (highest total amount ordered,
     cancelled ones excluded). */
router.get("/", requireAdmin, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().toLowerCase();
    const sort = String(req.query.sort || "recent");

    let users = await loadUsersWithStats();
    const totalRegistered = users.length;

    if (q) {
      users = users.filter((u) =>
        (u.username || "").toLowerCase().includes(q) ||
        (u.email || "").toLowerCase().includes(q) ||
        (u.mobile || "").toLowerCase().includes(q)
      );
    }
    const matched = users.length;

    if (sort === "orders") {
      users.sort((a, b) => b.activeOrders - a.activeOrders || b.totalSpent - a.totalSpent);
    } else if (sort === "spent") {
      users.sort((a, b) => b.totalSpent - a.totalSpent || b.activeOrders - a.activeOrders);
    } else {
      users.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    }

    res.json({ ok: true, totalRegistered, matched, users });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't load customers." });
  }
});

router.get("/:id", requireAdmin, async (req, res) => {
  try {
    const doc = await usersCol.doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: "Customer not found." });
    const u = doc.data();

    const ordersSnap = await ordersCol.where("userMobile", "==", u.mobile).get();
    let ordersPlaced = 0, cancelledOrders = 0, totalSpent = 0;
    const orders = [];
    ordersSnap.forEach((odoc) => {
      const o = odoc.data();
      ordersPlaced += 1;
      if (o.status === "cancelled") cancelledOrders += 1;
      else totalSpent += o.total || 0;
      orders.push({ id: o.id, total: o.total, status: o.status, createdAt: o.createdAt });
    });
    orders.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

    res.json({
      ok: true,
      customer: {
        id: doc.id,
        username: u.username,
        mobile: u.mobile,
        email: u.email,
        createdAt: u.createdAt || null,
        blocked: !!u.blocked,
        ordersPlaced,
        cancelledOrders,
        activeOrders: ordersPlaced - cancelledOrders,
        totalSpent,
        recentOrders: orders.slice(0, 10),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't load that customer." });
  }
});

/* Blocks a customer's account: they can no longer log in, and (via
   requireAuth's own blocked check) any session they already hold stops
   working on the very next request. Doesn't touch their order history. */
router.patch("/:id/block", requireAdmin, async (req, res) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: "You can't block your own account." });
    }
    const ref = usersCol.doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "Customer not found." });
    await ref.update({ blocked: true, blockedAt: new Date().toISOString(), blockedBy: req.user.mobile });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't block that customer." });
  }
});

router.patch("/:id/unblock", requireAdmin, async (req, res) => {
  try {
    const ref = usersCol.doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "Customer not found." });
    await ref.update({ blocked: false, blockedAt: null, blockedBy: null });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't unblock that customer." });
  }
});

/* Resets a customer back to a blank slate: wipes their entire order
   history and lifts any block, but keeps the login itself (mobile,
   email, password) so they don't have to sign up again — the account
   behaves exactly like a brand-new registration afterward. */
router.patch("/:id/clear-data", requireAdmin, async (req, res) => {
  try {
    const ref = usersCol.doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "Customer not found." });
    const u = doc.data();

    const ordersSnap = await ordersCol.where("userMobile", "==", u.mobile).get();
    const batch = db.batch();
    ordersSnap.forEach((odoc) => batch.delete(odoc.ref));
    batch.update(ref, { blocked: false, blockedAt: null, blockedBy: null });
    await batch.commit();

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't clear that customer's data." });
  }
});

/* Permanently removes the account. Their past orders are left untouched
   (they're the restaurant's own historical records, not the account's),
   so this only deletes the login/profile itself. */
router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: "You can't remove your own account." });
    }
    const ref = usersCol.doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "Customer not found." });
    await ref.delete();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't remove that customer." });
  }
});

module.exports = router;
       
