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
const DEFAULT_CLOSING_TIME = "19:15";
const DEFAULT_GRACE_MIN = 3;

/* All orders for a calendar day (IST, since that's the restaurant's
   timezone) pool together. Orders sit as status "held" — shown to the
   customer as "Pending" — until the combined total of the day's orders
   reaches the admin's configured minimum. The order that crosses the line
   confirms itself AND every other held order from that day, in one batch,
   so nobody's food gets started until the kitchen has a worthwhile batch.

   Order status lifecycle: held -> confirmed -> preparing -> delivered
   (or -> cancelled from held/confirmed — not from preparing, since the
   kitchen has already started by then). "confirmed" means the pool
   minimum is CURRENTLY met; that's re-evaluated continuously, so if
   enough cancellations drag the day's total back under the minimum, any
   order still sitting at "confirmed" (i.e. not yet "preparing") drops
   back to "held" automatically. "preparing" is a separate, later stage
   the admin sets once the kitchen actually starts cooking a specific
   order — once there, it's locked in and pool changes no longer affect
   it. */
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
    const graceN = Number(data.graceMinutes);
    return {
      minOrderPoolAmount: Number.isFinite(minN) && minN >= 0 ? minN : DEFAULT_MIN_POOL,
      cancelWindowMinutes: Number.isFinite(cancelN) && cancelN >= 0 ? cancelN : DEFAULT_CANCEL_WINDOW_MIN,
      deliveryWindowStart: data.deliveryWindowStart || "20:30",
      deliveryWindowEnd: data.deliveryWindowEnd || "20:45",
      closingTime: data.closingTime || DEFAULT_CLOSING_TIME,
      graceMinutes: Number.isFinite(graceN) && graceN >= 0 ? graceN : DEFAULT_GRACE_MIN,
      cancellationMode: data.cancellationMode === "timeRange" ? "timeRange" : "afterClosing",
      cancelWindowStart: data.cancelWindowStart || "18:00",
      cancelWindowEnd: data.cancelWindowEnd || "19:00",
    };
  } catch {
    return {
      minOrderPoolAmount: DEFAULT_MIN_POOL,
      cancelWindowMinutes: DEFAULT_CANCEL_WINDOW_MIN,
      deliveryWindowStart: "20:30",
      deliveryWindowEnd: "20:45",
      closingTime: DEFAULT_CLOSING_TIME,
      graceMinutes: DEFAULT_GRACE_MIN,
      cancellationMode: "afterClosing",
      cancelWindowStart: "18:00",
      cancelWindowEnd: "19:00",
    };
  }
}

/* Cancellation is a single shared clock deadline for the whole day:
   closing time + extra/grace time + the admin's cancellation allowance,
   all added together. E.g. closing 7:30 PM + 3 min grace + 10 min
   cancellation allowance = every order placed that day can be cancelled
   up until 7:43 PM, full stop — not "10 minutes after I personally
   placed it".

   This is always computed from the CURRENT live settings (not a value
   frozen on the order at creation time) — if the admin changes the
   closing time (or grace/allowance/mode) mid-day, every still-open
   order's cancellation deadline moves with it immediately, both for the
   customer-facing countdown/terms text and for this endpoint's own
   enforcement. The closingTime/graceMinutes/etc fields still stored on
   each order are kept only as a historical record of what was in effect
   when it was placed — they are no longer used to compute the deadline.

   Two admin-selectable ways to decide the cancellation deadline:
   - "afterClosing" (default): a single shared clock deadline for the
     whole day — closing time + grace + the admin's cancellation
     allowance. Open from the moment the order is placed.
   - "timeRange": cancellation is only allowed inside a fixed daily
     clock-time window (e.g. 6:00 PM – 7:00 PM), independent of the
     closing time. Orders placed before the window opens must wait;
     once it closes, cancellation is locked out for the rest of the day.

   dateKey is an IST calendar date ("YYYY-MM-DD"), taken from the order
   itself (so the window still applies to the day the order was actually
   placed on); the various *Time fields are IST clock times ("HH:MM")
   read live from settings. Combining them with an explicit +05:30 offset
   gives an unambiguous instant regardless of the server's own timezone. */
function getCancelWindow(order, settings) {
  const dateKey = order.dateKey || istDateKey();
  const toMs = (hhmm) => new Date(`${dateKey}T${hhmm}:00+05:30`).getTime();

  if (settings.cancellationMode === "timeRange") {
    const start = settings.cancelWindowStart || "18:00";
    const end = settings.cancelWindowEnd || "19:00";
    return { mode: "timeRange", opensAtMs: toMs(start), closesAtMs: toMs(end) };
  }

  const closingTime = settings.closingTime || DEFAULT_CLOSING_TIME;
  const graceMinutes = Number.isFinite(Number(settings.graceMinutes)) ? Number(settings.graceMinutes) : DEFAULT_GRACE_MIN;
  const cancelWindowMinutes = Number.isFinite(Number(settings.cancelWindowMinutes)) ? Number(settings.cancelWindowMinutes) : DEFAULT_CANCEL_WINDOW_MIN;
  const closingMs = toMs(closingTime);
  return {
    mode: "afterClosing",
    opensAtMs: null, // open from the moment the order is placed
    closesAtMs: closingMs + (graceMinutes + cancelWindowMinutes) * 60 * 1000,
  };
}

/* Self-healing pool recalculation — and the single source of truth for
   every order's status. Rather than trusting an incrementally maintained
   running total or a "once true, always true" met flag (which is what
   caused orders to stay stuck showing "Confirmed" after a cancellation
   dragged the day's real total back below the minimum), this recomputes
   the day's pool total FROM THE ORDERS THEMSELVES every time it's
   called, decides met/not-met fresh each time, and then moves orders
   BOTH directions to match:
     - met AND still "held"      -> sweep up to "confirmed"
     - not met AND still "confirmed" (not yet "preparing")
                                  -> sweep back down to "held"
   Orders already "preparing" or "delivered" are never touched — once the
   kitchen has actually started on a specific order, a later cancellation
   elsewhere shouldn't erase that. Only orders still sitting at
   "confirmed" (i.e. the kitchen hasn't started them yet) are eligible to
   fall back to pending if the batch that justified confirming them no
   longer holds up.
   Safe to call as often as needed — on every order placed, every
   cancellation, and defensively on every pool-status read. */
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
  let deliveryArrivedAt = null;

  await db.runTransaction(async (tx) => {
    const poolSnap = await tx.get(poolRef);
    const pool = poolSnap.exists ? poolSnap.data() : {};
    // deliveryArrivedAt is only ever set by the admin's "mark delivery
    // arrived" broadcast (see /deliver-today below) — merge:true here
    // means we never touch it while just reconciling totals, so it
    // naturally carries forward for the rest of that day and just as
    // naturally starts unset on a fresh day's pool doc.
    deliveryArrivedAt = pool.deliveryArrivedAt || null;
    tx.set(
      poolRef,
      {
        dateKey,
        total: activeTotal,
        minAmount: minPool,
        met,
        // Purely informational — the moment the pool most recently
        // crossed the line. Not used to decide anything, since met is
        // now recomputed fresh every time rather than latched.
        reachedAt: met ? (pool.met ? pool.reachedAt || new Date().toISOString() : new Date().toISOString()) : null,
      },
      { merge: true }
    );
  });

  const toFlip = activeOrders.filter((doc) => {
    const status = doc.data().status;
    return met ? status === "held" : status === "confirmed";
  });
  if (toFlip.length) {
    const batch = db.batch();
    toFlip.forEach((doc) => batch.update(doc.ref, { status: met ? "confirmed" : "held" }));
    await batch.commit();
  }

  return { total: activeTotal, minAmount: minPool, met, deliveryArrivedAt };
}

router.post("/", requireAuth, async (req, res) => {
  try {
    const { customerName, customerPhone, address, items, total } = req.body || {};
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "Cart is empty." });
    if (typeof total !== "number") return res.status(400).json({ error: "Missing order total." });

    const id = "ORD-" + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString("hex").toUpperCase();
    const dateKey = istDateKey();
    const settings = await getSettings();

    // Always written as "held" — reconcilePool (called right below) is the
    // one and only place that decides whether it should actually be
    // "confirmed", based on the real, current total of everyone's active
    // orders for the day. That keeps order creation and cancellation
    // using the exact same decision logic instead of two separate copies
    // of the pool math that could drift apart.
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
      // Snapshot the delivery window — and everything the cancellation
      // deadline is computed from — at order time, so a later admin
      // settings change doesn't retroactively rewrite what a customer was
      // already told, or move an in-flight order's cancel deadline.
      deliveryWindowStart: settings.deliveryWindowStart,
      deliveryWindowEnd: settings.deliveryWindowEnd,
      closingTime: settings.closingTime,
      graceMinutes: settings.graceMinutes,
      cancelWindowMinutes: settings.cancelWindowMinutes,
      cancellationMode: settings.cancellationMode,
      cancelWindowStart: settings.cancelWindowStart,
      cancelWindowEnd: settings.cancelWindowEnd,
      createdAt: new Date().toISOString(),
    };

    await ordersCol.doc(id).set(order);
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
      deliveryArrivedAt: pool.deliveryArrivedAt || null,
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

/* Admin's single "Delivery arrived" broadcast for the day. Rather than
   the admin clicking "deliver" on every order one at a time, this moves
   EVERY of today's still-open orders (status "confirmed" or "preparing"
   — "held" orders never reached the kitchen, so they're left alone) to
   "delivered" in one batch, and stamps today's pool doc with
   deliveryArrivedAt so every customer's live poll (GET /pool-status,
   already running every few seconds) picks it up and shows a
   below-header "delivery has arrived" notification — without needing a
   push-notification service. Matches the front-end's rule that the last
   8-10% of an order's progress bar only closes once the admin explicitly
   confirms the order has reached the customer; this is that
   confirmation, applied to the whole day's batch at once. */
router.post("/deliver-today", requireAdmin, async (req, res) => {
  try {
    const dateKey = istDateKey();
    const snap = await ordersCol.where("dateKey", "==", dateKey).get();
    const toDeliver = [];
    snap.forEach((doc) => {
      const status = doc.data().status;
      if (status === "confirmed" || status === "preparing") toDeliver.push(doc);
    });

    const now = new Date().toISOString();
    if (toDeliver.length) {
      const batch = db.batch();
      toDeliver.forEach((doc) => batch.update(doc.ref, { status: "delivered", deliveredAt: now }));
      await batch.commit();
    }

    await poolsCol.doc(dateKey).set({ dateKey, deliveryArrivedAt: now }, { merge: true });

    res.json({ ok: true, deliveredCount: toDeliver.length, deliveryArrivedAt: now });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't mark today's delivery as arrived." });
  }
});

/* Customer cancels their own order. Allowed until the shared daily
   deadline computed by getCancelWindow() from the CURRENT live settings
   — either closing time + extra time + the admin's cancellation
   allowance, or a fixed daily time range, depending on the admin's
   chosen mode — not a per-order countdown from when it was placed, and
   not a value frozen from when the order was placed. The front-end
   hides the Cancel button once that deadline passes, but this endpoint
   enforces it regardless of what the client sends. */
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
    if (order.status === "preparing") {
      return res.status(400).json({ error: "The kitchen has already started preparing this order — it can't be cancelled anymore." });
    }

    const settings = await getSettings();
    const window = getCancelWindow(order, settings);
    const now = Date.now();
    const fmt = (ms) => new Date(ms).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });
    if (window.opensAtMs && now < window.opensAtMs) {
      return res.status(400).json({ error: `Cancellation opens at ${fmt(window.opensAtMs)} for today's orders.` });
    }
    if (now > window.closesAtMs) {
      return res.status(400).json({ error: `The cancellation window for today's orders closed at ${fmt(window.closesAtMs)}.` });
    }

    await ref.update({ status: "cancelled", cancelledAt: new Date().toISOString() });

    // Re-derive the day's pool total from the real (now one-fewer-active)
    // set of orders. If that drags the total back below the minimum,
    // reconcilePool will also flip any other still-"confirmed" (not yet
    // "preparing") orders from today back to "held" — the batch that
    // justified confirming them no longer holds up, so their status
    // should honestly reflect that instead of staying stuck on
    // "Confirmed". Orders already "preparing" or "delivered" are left
    // alone since the kitchen has already committed to them specifically.
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
              
