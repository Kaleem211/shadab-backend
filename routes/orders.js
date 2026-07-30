const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { requireAuth, requireAdmin } = require("../utils/auth");

const router = express.Router();
const ordersCol = db.collection("orders");
const poolsCol = db.collection("pools");
const settingsDoc = db.collection("settings").doc("config");
const DEFAULT_MIN_POOL = 600;

/* All orders for a calendar day (IST, since that's the restaurant's
   timezone) pool together. Orders sit as status "held" — shown to the
   customer as "Pending" — until the combined total of the day's orders
   reaches the admin's configured minimum. The order that crosses the line
   confirms itself AND every other held order from that day, in one batch,
   so nobody's food gets started until the kitchen has a worthwhile batch. */
function istDateKey(d = new Date()) {
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

async function getMinPoolAmount() {
  try {
    const doc = await settingsDoc.get();
    const n = Number(doc.exists ? doc.data().minOrderPoolAmount : undefined);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_POOL;
  } catch {
    return DEFAULT_MIN_POOL;
  }
}

router.post("/", requireAuth, async (req, res) => {
  try {
    const { customerName, customerPhone, address, items, total } = req.body || {};
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "Cart is empty." });
    if (typeof total !== "number") return res.status(400).json({ error: "Missing order total." });

    const id = "ORD-" + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString("hex").toUpperCase();
    const dateKey = istDateKey();
    const minPool = await getMinPoolAmount();
    const poolRef = poolsCol.doc(dateKey);

    const order = {
      id,
      userMobile: req.user.mobile,
      customerName: customerName || req.user.username,
      customerPhone: customerPhone || req.user.mobile,
      address: address || "",
      items,
      total,
      dateKey,
      status: "held",
      createdAt: new Date().toISOString(),
    };

    let justReachedPool = false;

    await db.runTransaction(async (tx) => {
      const poolSnap = await tx.get(poolRef);
      const pool = poolSnap.exists ? poolSnap.data() : { total: 0, met: false, minAmount: minPool };
      const newTotal = (pool.total || 0) + total;

      if (pool.met) {
        // Today's minimum was already reached earlier — confirm instantly.
        order.status = "confirmed";
      } else if (newTotal >= minPool) {
        order.status = "confirmed";
        justReachedPool = true;
      }

      tx.set(
        poolRef,
        {
          dateKey,
          total: newTotal,
          minAmount: minPool,
          met: pool.met || newTotal >= minPool,
          reachedAt: !pool.met && newTotal >= minPool ? new Date().toISOString() : pool.reachedAt || null,
        },
        { merge: true }
      );
      tx.set(ordersCol.doc(id), order);
    });

    // Threshold just crossed with this order — sweep up every other order
    // that was held today and confirm them all in one batch.
    if (justReachedPool) {
      const heldSnap = await ordersCol.where("dateKey", "==", dateKey).where("status", "==", "held").get();
      if (!heldSnap.empty) {
        const batch = db.batch();
        heldSnap.forEach((doc) => {
          if (doc.id !== id) batch.update(doc.ref, { status: "confirmed" });
        });
        await batch.commit();
      }
    }

    res.json({ ok: true, order });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't place the order." });
  }
});

/* Public: lets the site show "₹340 of ₹600 reached today" without
   exposing anyone's individual order details. */
router.get("/pool-status", async (req, res) => {
  try {
    const dateKey = istDateKey();
    const minPool = await getMinPoolAmount();
    const doc = await poolsCol.doc(dateKey).get();
    const pool = doc.exists ? doc.data() : { total: 0, met: false };
    res.json({
      ok: true,
      dateKey,
      minAmount: minPool,
      total: pool.total || 0,
      met: !!pool.met,
      remaining: Math.max(0, minPool - (pool.total || 0)),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't load today's pool status." });
  }
});

router.get("/mine", requireAuth, async (req, res) => {
  const snap = await ordersCol.where("userMobile", "==", req.user.mobile).get();
  const orders = [];
  snap.forEach((doc) => orders.push(doc.data()));
  orders.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json({ ok: true, orders });
});

router.get("/", requireAdmin, async (req, res) => {
  const snap = await ordersCol.get();
  const orders = [];
  snap.forEach((doc) => orders.push(doc.data()));
  orders.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json({ ok: true, orders });
});

router.patch("/:id/deliver", requireAdmin, async (req, res) => {
  const ref = ordersCol.doc(req.params.id);
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ error: "Order not found." });
  if (doc.data().status === "held") {
    return res.status(400).json({ error: "This order is still pending — today's minimum order pool hasn't been reached yet." });
  }
  await ref.update({ status: "delivered" });
  res.json({ ok: true });
});

/* Customer cancels their own order. Allowed any time before it's been
   delivered — the front-end only shows the Cancel button while ordering
   is still open (closing time + admin's extra/grace minutes) for the day,
   but this endpoint enforces ownership + status regardless. */
router.patch("/:id/cancel", requireAuth, async (req, res) => {
  try {
    const ref = ordersCol.doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "Order not found." });
    const order = doc.data();
    if (order.userMobile !== req.user.mobile) {
      return res.status(403).json({ error: "You can only cancel your own orders." });
    }
    if (order.status === "delivered") {
      return res.status(400).json({ error: "This order has already been delivered and can't be cancelled." });
    }
    if (order.status === "cancelled") {
      return res.status(400).json({ error: "This order is already cancelled." });
    }

    // If this order was still "held" (not yet pooled past the minimum),
    // its value no longer counts toward today's pool total.
    if (order.status === "held" && order.dateKey) {
      const poolRef = poolsCol.doc(order.dateKey);
      await db.runTransaction(async (tx) => {
        const poolSnap = await tx.get(poolRef);
        if (!poolSnap.exists) return;
        const pool = poolSnap.data();
        if (pool.met) return; // threshold already crossed for the day, leave it be
        tx.update(poolRef, { total: Math.max(0, (pool.total || 0) - order.total) });
      });
    }

    await ref.update({ status: "cancelled", cancelledAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't cancel the order." });
  }
});

router.delete("/", requireAdmin, async (req, res) => {
  const snap = await ordersCol.get();
  const batch = db.batch();
  snap.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
  res.json({ ok: true });
});

module.exports = router;
  
