const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { requireAuth, requireAdmin } = require("../utils/auth");

const router = express.Router();
const ordersCol = db.collection("orders");
const poolsCol = db.collection("pools");
const settingsDoc = db.collection("settings").doc("config");
const DEFAULT_MIN_POOL = 600;
const DEFAULT_CANCEL_WINDOW_MIN = 15;

/* All orders for a calendar day (IST, since that's the restaurant's
   timezone) pool together. Orders sit as status "held" — shown to the
   customer as "Pending" — until the combined total of the day's orders
   reaches the admin's configured minimum. The order that crosses the line
   confirms itself AND every other held order from that day, in one batch,
   so nobody's food gets started until the kitchen has a worthwhile batch.

   Order status lifecycle: held -> confirmed -> preparing -> delivered
   (or -> cancelled from held/confirmed/preparing). "confirmed" means the
   pool minimum was met and the kitchen has accepted the order; "preparing"
   is a separate, later stage the admin sets once the kitchen actually
   starts cooking it. */
function istDateKey(d = new Date()) {
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

async function getSettings() {
  try {
    const doc = await settingsDoc.get();
    const data = doc.exists ? doc.data() : {};
    const minN = Number(data.minOrderPoolAmount);
    const cancelN = Number(data.cancelWindowMinutes);
    return {
      minOrderPoolAmount: Number.isFinite(minN) && minN >= 0 ? minN : DEFAULT_MIN_POOL,
      cancelWindowMinutes: Number.isFinite(cancelN) && cancelN >= 0 ? cancelN : DEFAULT_CANCEL_WINDOW_MIN,
      deliveryWindowStart: data.deliveryWindowStart || "20:30",
      deliveryWindowEnd: data.deliveryWindowEnd || "20:45",
    };
  } catch {
    return {
      minOrderPoolAmount: DEFAULT_MIN_POOL,
      cancelWindowMinutes: DEFAULT_CANCEL_WINDOW_MIN,
      deliveryWindowStart: "20:30",
      deliveryWindowEnd: "20:45",
    };
  }
}

/* Self-healing pool recalculation. Rather than trusting an incrementally
   maintained running total (which drifts whenever a cancellation, a
   crashed request, or a concurrent write is missed), this recomputes the
   day's pool total FROM THE ORDERS THEMSELVES every time it's called —
   the orders collection is the single source of truth. It then:
     1) Corrects the pool doc's `total` to match reality.
     2) If the real total has reached the minimum and there are still
        "held" orders sitting around (e.g. a race between two orders
        landing at nearly the same moment, or the minimum being lowered
        by the admin after some orders were placed), it sweeps them all
        to "confirmed" right now instead of leaving them stuck.
   This is safe to call as often as needed — on every order placed,
   every cancellation, and defensively on every pool-status read — since
   it never revives a cancelled order or un-confirms one that already
   started cooking. */
async function reconcilePool(dateKey, minPoolOverride) {
  const minPool = typeof minPoolOverride === "number" ? minPoolOverride : (await getSettings()).minOrderPoolAmount;
  const snap = await ordersCol.where("dateKey", "==", dateKey).get();
  const activeOrders = [];
  let activeTotal = 0;
  snap.forEach((doc) => {
    const o = doc.data();
    if (o.status !== "cancelled") {
      activeTotal += o.total || 0;
      activeOrders.push(doc);
    }
  });

  const met = activeTotal >= minPool;
  const poolRef = poolsCol.doc(dateKey);

  await db.runTransaction(async (tx) => {
    const poolSnap = await tx.get(poolRef);
    const pool = poolSnap.exists ? poolSnap.data() : {};
    tx.set(
      poolRef,
      {
        dateKey,
        total: activeTotal,
        minAmount: minPool,
        met: !!(pool.met || met),
        reachedAt: pool.reachedAt || (met ? new Date().toISOString() : null),
      },
      { merge: true }
    );
  });

  if (met) {
    const stillHeld = activeOrders.filter((doc) => doc.data().status === "held");
    if (stillHeld.length) {
      const batch = db.batch();
      stillHeld.forEach((doc) => batch.update(doc.ref, { status: "confirmed" }));
      await batch.commit();
    }
  }

  return { total: activeTotal, minAmount: minPool, met: met || false };
}

router.post("/", requireAuth, async (req, res) => {
  try {
    const { customerName, customerPhone, address, items, total } = req.body || {};
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "Cart is empty." });
    if (typeof total !== "number") return res.status(400).json({ error: "Missing order total." });

    const id = "ORD-" + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString("hex").toUpperCase();
    const dateKey = istDateKey();
    const settings = await getSettings();
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
      // Snapshot the delivery window at order time so a later admin change
      // to the default window doesn't retroactively rewrite what a
      // customer was already told for an order in flight.
      deliveryWindowStart: settings.deliveryWindowStart,
      deliveryWindowEnd: settings.deliveryWindowEnd,
      cancelWindowMinutes: settings.cancelWindowMinutes,
      createdAt: new Date().toISOString(),
    };

    await db.runTransaction(async (tx) => {
      const poolSnap = await tx.get(poolRef);
      const pool = poolSnap.exists ? poolSnap.data() : { total: 0, met: false, minAmount: settings.minOrderPoolAmount };
      const newTotal = (pool.total || 0) + total;

      if (pool.met || newTotal >= settings.minOrderPoolAmount) {
        order.status = "confirmed";
      }

      tx.set(
        poolRef,
        {
          dateKey,
          total: newTotal,
          minAmount: settings.minOrderPoolAmount,
          met: pool.met || newTotal >= settings.minOrderPoolAmount,
          reachedAt: !pool.met && newTotal >= settings.minOrderPoolAmount ? new Date().toISOString() : pool.reachedAt || null,
        },
        { merge: true }
      );
      tx.set(ordersCol.doc(id), order);
    });

    // Reconcile against the real orders collection right after writing —
    // catches the case where this order's own write pushed the total over
    // the line but a concurrent request's held order hasn't been swept yet.
    await reconcilePool(dateKey, settings.minOrderPoolAmount);
    const freshDoc = await ordersCol.doc(id).get();

    res.json({ ok: true, order: freshDoc.exists ? freshDoc.data() : order });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't place the order." });
  }
});

/* Public: lets the site show "₹340 of ₹600 reached today" without
   exposing anyone's individual order details. Reconciles first so the
   number shown is always self-corrected against the real orders, even if
   an earlier write raced or a cancellation happened moments ago. */
router.get("/pool-status", async (req, res) => {
  try {
    const dateKey = istDateKey();
    const settings = await getSettings();
    const pool = await reconcilePool(dateKey, settings.minOrderPoolAmount);
    res.json({
      ok: true,
      dateKey,
      minAmount: pool.minAmount,
      total: pool.total,
      met: pool.met,
      remaining: Math.max(0, pool.minAmount - pool.total),
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

/* Admin moves an order through the kitchen stages. "preparing" is only
   reachable from "confirmed" (the pool minimum must already be met before
   the kitchen starts cooking); "delivered" is reachable from either
   "confirmed" or "preparing" (small/simple orders may skip a separately
   tracked preparing stage). Never reachable from "held" — an order that
   hasn't even been confirmed yet can't be cooking or delivered. */
router.patch("/:id/status", requireAdmin, async (req, res) => {
  const { status } = req.body || {};
  if (!["preparing", "delivered"].includes(status)) {
    return res.status(400).json({ error: "status must be 'preparing' or 'delivered'." });
  }
  const ref = ordersCol.doc(req.params.id);
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ error: "Order not found." });
  const current = doc.data().status;
  if (current === "held") {
    return res.status(400).json({ error: "This order is still pending — today's minimum order pool hasn't been reached yet." });
  }
  if (current === "cancelled") {
    return res.status(400).json({ error: "This order was cancelled." });
  }
  if (status === "preparing" && current !== "confirmed") {
    return res.status(400).json({ error: `Can't move to preparing from '${current}'.` });
  }
  if (status === "delivered" && !["confirmed", "preparing"].includes(current)) {
    return res.status(400).json({ error: `Can't mark delivered from '${current}'.` });
  }
  await ref.update({ status, [`${status}At`]: new Date().toISOString() });
  res.json({ ok: true });
});

/* Kept for backwards compatibility with older clients — same effect as
   PATCH /:id/status with { status: "delivered" }. */
router.patch("/:id/deliver", requireAdmin, async (req, res) => {
  const ref = ordersCol.doc(req.params.id);
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ error: "Order not found." });
  const current = doc.data().status;
  if (current === "held") {
    return res.status(400).json({ error: "This order is still pending — today's minimum order pool hasn't been reached yet." });
  }
  if (current === "cancelled") {
    return res.status(400).json({ error: "This order was cancelled." });
  }
  await ref.update({ status: "delivered", deliveredAt: new Date().toISOString() });
  res.json({ ok: true });
});

/* Customer cancels their own order. Allowed only within the admin-set
   cancelWindowMinutes counted from when the order was placed — the
   front-end hides the Cancel button once that window closes, but this
   endpoint enforces it regardless of what the client sends. */
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

    const cancelWindowMinutes = Number.isFinite(Number(order.cancelWindowMinutes))
      ? Number(order.cancelWindowMinutes)
      : (await getSettings()).cancelWindowMinutes;
    const placedAt = new Date(order.createdAt).getTime();
    const deadline = placedAt + cancelWindowMinutes * 60 * 1000;
    if (Number.isFinite(placedAt) && Date.now() > deadline) {
      return res.status(400).json({ error: `The ${cancelWindowMinutes}-minute cancellation window for this order has closed.` });
    }

    await ref.update({ status: "cancelled", cancelledAt: new Date().toISOString() });

    // Re-derive the day's pool total from the real (now one-fewer-active)
    // set of orders — this is what keeps "held" orders correctly pending
    // (or correctly confirmed) no matter how many other cancellations
    // happen around them. "met" only ever moves forward: once the kitchen
    // has committed to a batch, a later cancellation doesn't un-confirm
    // orders that were already told they're on.
    if (order.dateKey) await reconcilePool(order.dateKey);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't cancel the order." });
  }
});

/* Clears every order AND every day's pool record. The pool banner
   ("₹970 of ₹600 reached") lives in a separate `pools` collection keyed
   by calendar date — wiping only `orders` left that collection untouched,
   so the banner kept showing stale totals forever after a clear, no
   matter what today's date was. Deleting every doc in `pools` (not just
   today's) means the very next order placed — on any date — starts the
   count fresh from ₹0. */
router.delete("/", requireAdmin, async (req, res) => {
  const snap = await ordersCol.get();
  const batch = db.batch();
  snap.forEach((doc) => batch.delete(doc.ref));

  const poolsSnap = await poolsCol.get();
  poolsSnap.forEach((doc) => batch.delete(doc.ref));

  await batch.commit();
  res.json({ ok: true });
});

module.exports = router;
         
