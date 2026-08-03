const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { requireAuth, requireAdmin } = require("../utils/auth");
const { getOrderableMenu } = require("../utils/menuCatalog");
const { getOrFetch, invalidate } = require("../utils/cache");
const { notifyCustomer, notifyAllAdmins } = require("../utils/push");

const router = express.Router();
const ordersCol = db.collection("orders");
const poolsCol = db.collection("pools");
const settingsDoc = db.collection("settings").doc("config");
// Single doc that tracks the ADMIN DASHBOARD's own "clear" cutoff — kept
// completely separate from the `orders` collection itself. See
// getAdminDashboardState()/clearAdminDashboard() below for why: clearing
// the dashboard must never touch a customer's real order data.
const adminStateDoc = db.collection("adminState").doc("dashboard");
const DEFAULT_MIN_POOL = 600;
const DEFAULT_CANCEL_WINDOW_MIN = 15;
const DEFAULT_CLOSING_TIME = "19:15";
const DEFAULT_GRACE_MIN = 3;

/* The admin's "Clear Orders" button used to hard-delete every order
   document — wiping customers' own order history along with the admin's
   view of it. It now only clears the ADMIN DASHBOARD's view: this doc
   stores a `clearedAt` cutoff, and the admin's GET /orders endpoint hides
   any order placed at or before it. Nothing in the `orders` collection is
   ever touched, so a customer's "My Orders" always shows their real,
   complete history regardless of what the admin has cleared.
   `previousClearedAt` remembers the cutoff that was in effect just before
   the most recent clear (manual or automatic), so a single "Restore" can
   undo it — same one-level-undo pattern as /deliver-today/undo. */
async function getAdminDashboardState() {
  try {
    const doc = await adminStateDoc.get();
    const data = doc.exists ? doc.data() : {};
    return { clearedAt: data.clearedAt || null, previousClearedAt: data.previousClearedAt || null };
  } catch {
    return { clearedAt: null, previousClearedAt: null };
  }
}
async function clearAdminDashboard() {
  const state = await getAdminDashboardState();
  const now = new Date().toISOString();
  await adminStateDoc.set({ clearedAt: now, previousClearedAt: state.clearedAt || null }, { merge: true });
  return now;
}
/* Runs after any action that could finish off the day's kitchen work
   (marking an order delivered, or the deliver-today broadcast). If every
   order currently visible on the admin dashboard is now either delivered
   or cancelled — and at least one was actually delivered, so this never
   fires on a dashboard that's already empty — the dashboard clears itself
   automatically, exactly as if the admin had tapped Clear Orders by hand.
   Being routed through clearAdminDashboard() means an automatic clear is
   just as restorable as a manual one. */
async function maybeAutoClearDashboard() {
  try {
    const state = await getAdminDashboardState();
    const snap = await ordersCol.get();
    const visible = [];
    snap.forEach((doc) => {
      const o = doc.data();
      if (!state.clearedAt || !o.createdAt || o.createdAt > state.clearedAt) visible.push(o);
    });
    if (!visible.length) return;
    const stillActive = visible.some((o) => !["delivered", "cancelled"].includes(o.status));
    const hasDelivered = visible.some((o) => o.status === "delivered");
    if (!stillActive && hasDelivered) await clearAdminDashboard();
  } catch (err) {
    console.error("Auto-clear check failed:", err);
  }
}


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
    const doc = await getOrFetch("settings-doc", 10000, () => settingsDoc.get());
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
async function reconcilePool(dateKey, minPoolOverride, settingsOverride) {
  const settings = settingsOverride || (await getSettings());
  const minPool = typeof minPoolOverride === "number" ? minPoolOverride : settings.minOrderPoolAmount;
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
    // confirmedAt is stamped the moment an order actually crosses
    // held -> confirmed, and is what the front-end's progress tracker
    // uses to animate the "Confirmed" segment continuously across the
    // order's real confirmed lifetime — not just the tail end of the
    // cancellation window. Cleared (set back to null) on the reverse
    // confirmed -> held sweep so a later re-confirmation gets an honest,
    // fresh timestamp instead of reusing a stale one.
    const nowIso = new Date().toISOString();
    const batch = db.batch();
    toFlip.forEach((doc) =>
      batch.update(doc.ref, {
        status: met ? "confirmed" : "held",
        confirmedAt: met ? nowIso : null,
      })
    );
    await batch.commit();
    if (met) {
      toFlip.forEach((doc) => {
        const o = doc.data();
        notifyCustomer(o.userMobile, {
          title: "Order confirmed! 🎉",
          body: `Your order ${o.id} is confirmed — the kitchen will start soon.`,
          tag: `order-${o.id}`,
          url: "/#orders",
        }).catch((err) => console.error("Confirm push failed:", err));
      });
    }
  }
  // Auto-promote "confirmed" -> "preparing" the moment an order's own
  // cancellation window has closed, instead of waiting on the admin to flip
  // it by hand. This is what makes the customer-facing progress tracker
  // actually reach the "Preparing" stage on its own — previously an order
  // could sit at "confirmed" forever until someone in the admin panel
  // manually changed its status, even though cancellation was long over.
  // Orders that were just swept held->confirmed above haven't had a chance
  // to open a cancel window yet, so they're naturally excluded (their
  // in-memory status here is still "held").
  const now = Date.now();
  const toPromote = activeOrders.filter((doc) => {
    const o = doc.data();
    if (o.status !== "confirmed") return false;
    const window = getCancelWindow(o, settings);
    return now > window.closesAtMs;
  });
  if (toPromote.length) {
    const nowIso = new Date(now).toISOString();
    const batch = db.batch();
    toPromote.forEach((doc) => batch.update(doc.ref, { status: "preparing", preparingAt: nowIso }));
    await batch.commit();
    toPromote.forEach((doc) => {
      const o = doc.data();
      notifyCustomer(o.userMobile, {
        title: "Your order is being prepared 👨‍🍳",
        body: `Order ${o.id} has started cooking — get ready!`,
        tag: `order-${o.id}`,
        url: "/#orders",
      }).catch((err) => console.error("Preparing push failed:", err));
    });
  }

  const result = { total: activeTotal, minAmount: minPool, met, deliveryArrivedAt };
  maybeNotifyPoolFailure(dateKey, settings, result).catch((err) => console.error("Pool-failure check failed:", err));
  return result;
}

/* If today's minimum order pool STILL hasn't been reached once the day's
   ordering deadline (closing time + extra/grace time) has passed, every
   customer with a still-"held" (pending) order today is notified that
   the restaurant can't deliver today — instead of their order just
   silently sitting at "Pending" forever with no explanation.

   Fires at most once per day: the moment it fires, `poolFailedAt` is
   stamped on that day's pool doc, and every later call short-circuits on
   that flag so nobody gets the same notification twice. Never touches
   order status — the admin can decide what to do with the held orders
   (e.g. contact those customers) with the full picture still intact.
   Safe to call as often as reconcilePool itself is called. */
async function maybeNotifyPoolFailure(dateKey, settings, poolState) {
  try {
    if (poolState.met) return;
    const closingTime = settings.closingTime || DEFAULT_CLOSING_TIME;
    const graceMinutes = Number.isFinite(Number(settings.graceMinutes)) ? Number(settings.graceMinutes) : DEFAULT_GRACE_MIN;
    const deadlineMs = new Date(`${dateKey}T${closingTime}:00+05:30`).getTime() + graceMinutes * 60 * 1000;
    if (Date.now() < deadlineMs) return;

    const poolRef = poolsCol.doc(dateKey);
    const poolSnap = await poolRef.get();
    const pool = poolSnap.exists ? poolSnap.data() : {};
    if (pool.poolFailedAt) return; // already notified for today

    const now = new Date().toISOString();
    // Stamp first (before sending) so two near-simultaneous callers
    // (e.g. two customers polling at once) can't both slip through and
    // double-send the notification.
    await poolRef.set({ dateKey, poolFailedAt: now }, { merge: true });

    const snap = await ordersCol.where("dateKey", "==", dateKey).where("status", "==", "held").get();
    snap.forEach((doc) => {
      const o = doc.data();
      notifyCustomer(o.userMobile, {
        title: "😞 Sorry, today's order pool wasn't reached",
        body: `Today's minimum order pool of ₹${poolState.minAmount} wasn't reached in time, so the restaurant can't deliver today. Sorry for the inconvenience!`,
        tag: `pool-failed-${dateKey}`,
        url: "/#orders",
      }).catch((err) => console.error("Pool-failed push failed:", err));
    });
  } catch (err) {
    console.error("maybeNotifyPoolFailure failed:", err);
  }
}

/* Rebuilds the order's items/total from the server's own menu catalog
   instead of trusting whatever the client sent. Previously `items` and
   `total` came straight from req.body — anyone with devtools (or curl)
   could submit total: 1 for a full cart, or add items that don't exist,
   and the order would be saved and confirmed exactly as sent. Now only
   the item id + quantity from the client are used; name, price and note
   always come from the live catalog (BASE_MENU + admin overrides), so
   the price actually charged always matches what's really on the menu.
   Throws with a user-facing message on any bad input; callers should
   catch and turn that into a 400. */
async function priceOrderItems(rawItems) {
  if (!Array.isArray(rawItems) || !rawItems.length) {
    throw Object.assign(new Error("Cart is empty."), { status: 400 });
  }
  const catalog = await getOrderableMenu();
  const priced = [];
  let total = 0;

  for (const raw of rawItems) {
    const id = raw && raw.id;
    const qty = Number(raw && raw.qty);
    if (!id || typeof id !== "string") {
      throw Object.assign(new Error("Invalid item in cart."), { status: 400 });
    }
    if (!Number.isInteger(qty) || qty <= 0 || qty > 50) {
      throw Object.assign(new Error("Invalid quantity for one of the items."), { status: 400 });
    }
    const item = catalog.get(id);
    if (!item) {
      throw Object.assign(
        new Error("One or more items in your cart are no longer available. Please refresh the menu and try again."),
        { status: 409 }
      );
    }
    priced.push({ id: item.id, name: item.name, note: item.note || "", price: item.price, qty });
    total += item.price * qty;
  }

  return { items: priced, total };
}

// Trims, coerces to string, and caps length on free-text fields the
// customer controls (name/address) — belt-and-suspenders alongside the
// frontend's HTML-escaping so no single rendering context has to be the
// only thing standing between this input and a security bug.
const cleanText = (v, max) => String(v || "").trim().slice(0, max);

router.post("/", requireAuth, async (req, res) => {
  try {
    const customerName = cleanText(req.body && req.body.customerName, 80);
    const customerPhone = cleanText(req.body && req.body.customerPhone, 20);
    const address = cleanText(req.body && req.body.address, 300);

    let items, total;
    try {
      ({ items, total } = await priceOrderItems(req.body && req.body.items));
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }

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
    await reconcilePool(dateKey, settings.minOrderPoolAmount, settings);
    const freshDoc = await ordersCol.doc(id).get();

    notifyAllAdmins({
      title: "New order 🧾",
      body: `${order.customerName} — ₹${order.total} (${items.reduce((s, i) => s + i.qty, 0)} item${items.length > 1 ? "s" : ""})`,
      tag: "new-order",
      url: "/#admin",
    }).catch((err) => console.error("Admin new-order push failed:", err));

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
    const pool = await reconcilePool(dateKey, settings.minOrderPoolAmount, settings);
    const poolDoc = await poolsCol.doc(dateKey).get();
    res.json({
      ok: true,
      dateKey,
      minAmount: pool.minAmount,
      total: pool.total,
      met: pool.met,
      remaining: Math.max(0, pool.minAmount - pool.total),
      deliveryArrivedAt: pool.deliveryArrivedAt || null,
      poolFailedAt: (poolDoc.exists && poolDoc.data().poolFailedAt) || null,
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
  const state = await getAdminDashboardState();
  // Orders placed at or before the dashboard's clearedAt cutoff stay out
  // of the admin's view (they're still fully intact in Firestore, and
  // still visible to the customer on their own My Orders) until the admin
  // restores. See clearAdminDashboard() above for how the cutoff is set.
  //
  // This used to fetch the ENTIRE orders collection on every single call
  // (this route is polled every ~20s from any open admin tab) and filter
  // client-side — meaning read cost grew with the restaurant's all-time
  // order count forever. Once clearedAt is set, we instead query only
  // orders created after that cutoff directly in Firestore, so a poll
  // only ever costs reads proportional to what's actually still visible
  // on the dashboard, not the full history.
  const snap = state.clearedAt
    ? await ordersCol.where("createdAt", ">", state.clearedAt).get()
    : await ordersCol.get();
  const visible = [];
  snap.forEach((doc) => visible.push(doc.data()));
  visible.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  // The admin dashboard's pool banner used to always show the real,
  // day-wide pool total (same figure reconcilePool uses to decide order
  // confirmation) — which meant it kept reading "₹640 of ₹600 reached"
  // even right after Clear Orders, sitting above a completely empty list
  // with "0 Active orders". That's not actually a data bug: those earlier
  // orders are still real and still count toward today's minimum for
  // confirmation purposes, they've just been hidden from THIS view. But
  // shown next to an empty dashboard it reads as broken. So the banner
  // now gets its own total computed only from what's currently VISIBLE
  // on the dashboard (i.e. respecting the clearedAt cutoff) — purely a
  // display figure. The real, authoritative total used to confirm orders
  // (GET /orders/pool-status, what customers see) is completely
  // unaffected by this and keeps accumulating across the whole day
  // regardless of what the admin has cleared from their own view.
  const dateKey = istDateKey();
  const settings = await getSettings();
  const visibleTodayTotal = visible
    .filter((o) => o.status !== "cancelled" && (o.dateKey || dateKey) === dateKey)
    .reduce((sum, o) => sum + (o.total || 0), 0);
  const poolDocForBanner = await poolsCol.doc(dateKey).get();
  const adminPool = {
    total: visibleTodayTotal,
    minAmount: settings.minOrderPoolAmount,
    met: visibleTodayTotal >= settings.minOrderPoolAmount,
    poolFailedAt: (poolDocForBanner.exists && poolDocForBanner.data().poolFailedAt) || null,
  };

  res.json({ ok: true, orders: visible, dashboardClearedAt: state.clearedAt, canRestore: !!state.clearedAt, adminPool });
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
  const update = { status, [`${status}At`]: new Date().toISOString() };
  // Remember exactly what the order was before it became "delivered" so a
  // single per-order "undeliver" (PATCH /:id/undeliver below) can restore
  // it honestly instead of guessing "confirmed" for every case.
  if (status === "delivered") update.preDeliveryStatus = current;
  await ref.update(update);
  if (status === "delivered") await maybeAutoClearDashboard();
  const o = doc.data();
  notifyCustomer(o.userMobile, status === "delivered"
    ? { title: "Order arrived! ✅", body: `Your order ${o.id} has been delivered. Enjoy your meal!`, tag: `order-${o.id}`, url: "/#orders" }
    : { title: "Your order is being prepared 👨‍🍳", body: `Order ${o.id} has started cooking — get ready!`, tag: `order-${o.id}`, url: "/#orders" }
  ).catch((err) => console.error("Status push failed:", err));
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
  await ref.update({ status: "delivered", deliveredAt: new Date().toISOString(), preDeliveryStatus: current });
  await maybeAutoClearDashboard();
  const o = doc.data();
  notifyCustomer(o.userMobile, {
    title: "Order arrived! ✅",
    body: `Your order ${o.id} has been delivered. Enjoy your meal!`,
    tag: `order-${o.id}`,
    url: "/#orders",
  }).catch((err) => console.error("Delivered push failed:", err));
  res.json({ ok: true });
});

/* Reverses a single order's "delivered" status — the per-order companion
   to /deliver-today/undo below. Without this, unticking the "Delivered"
   checkbox in the admin's Verify Orders panel had nothing to actually call
   on the backend: the very next poll re-fetched the order still sitting at
   status "delivered", and the checkbox visibly snapped back to checked a
   moment after the admin unchecked it — the reported "verification
   glitch". This restores whatever status the order was in immediately
   before it was marked delivered (stamped as preDeliveryStatus the instant
   that happened), falling back to "confirmed" for any older order placed
   before this field existed. */
router.patch("/:id/undeliver", requireAdmin, async (req, res) => {
  try {
    const ref = ordersCol.doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "Order not found." });
    const order = doc.data();
    if (order.status !== "delivered") {
      return res.status(400).json({ error: "This order isn't marked delivered." });
    }
    const restoredStatus = order.preDeliveryStatus || "confirmed";
    await ref.update({ status: restoredStatus, deliveredAt: null, preDeliveryStatus: null });
    res.json({ ok: true, status: restoredStatus });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't undo delivery for this order." });
  }
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
    // Remember exactly what this broadcast touched (which orders, and what
    // each one's status was right before) so a single "Undo" can cleanly
    // reverse it later — see /deliver-today/undo below. previousStatuses is
    // keyed by order id rather than assumed to be uniform, since a mixed
    // batch of "confirmed" and "preparing" orders is normal.
    const previousStatuses = {};
    toDeliver.forEach((doc) => { previousStatuses[doc.id] = doc.data().status; });

    if (toDeliver.length) {
      const batch = db.batch();
      toDeliver.forEach((doc) => batch.update(doc.ref, { status: "delivered", deliveredAt: now }));
      await batch.commit();
      toDeliver.forEach((doc) => {
        const o = doc.data();
        notifyCustomer(o.userMobile, {
          title: "Order arrived! ✅",
          body: `Your order ${o.id} has been delivered. Enjoy your meal!`,
          tag: `order-${o.id}`,
          url: "/#orders",
        }).catch((err) => console.error("Deliver-today push failed:", err));
      });
    }

    await poolsCol.doc(dateKey).set(
      {
        dateKey,
        deliveryArrivedAt: now,
        lastDeliveryBroadcast: { at: now, orderIds: toDeliver.map((d) => d.id), previousStatuses },
      },
      { merge: true }
    );

    await maybeAutoClearDashboard();
    res.json({ ok: true, deliveredCount: toDeliver.length, deliveryArrivedAt: now });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't mark today's delivery as arrived." });
  }
});

/* Reverses the most recent /deliver-today broadcast for the current day —
   the admin dashboard's "Undo" action. Only reverts orders that are still
   exactly as that broadcast left them (status "delivered" with a matching
   deliveredAt timestamp); an order a customer or admin touched separately
   since then is left alone rather than silently rewound. Available until
   the admin broadcasts delivery again or a new day's pool doc starts fresh
   with no lastDeliveryBroadcast recorded. */
router.post("/deliver-today/undo", requireAdmin, async (req, res) => {
  try {
    const dateKey = istDateKey();
    const poolRef = poolsCol.doc(dateKey);
    const poolSnap = await poolRef.get();
    const pool = poolSnap.exists ? poolSnap.data() : {};

    // The only thing that actually decides whether there's something to
    // undo is whether the "delivery arrived" notification is currently
    // live — NOT whether the broadcast happened to move any orders. A
    // broadcast can legitimately touch zero orders (e.g. the admin had
    // already delivered every order individually before tapping the
    // broadcast button) while still setting deliveryArrivedAt and showing
    // the notice to customers. Gating on orderIds.length here was the bug:
    // it left that notice permanently un-undoable whenever the batch was
    // empty, even though the button (driven by the same deliveryArrivedAt
    // flag) told the admin an undo was available.
    if (!pool.deliveryArrivedAt) {
      return res.status(400).json({ error: "There's nothing to undo." });
    }

    const broadcast = pool.lastDeliveryBroadcast;
    let revertedCount = 0;
    if (broadcast && Array.isArray(broadcast.orderIds) && broadcast.orderIds.length) {
      const docs = await Promise.all(broadcast.orderIds.map((id) => ordersCol.doc(id).get()));
      const toRevert = docs.filter((doc) => {
        if (!doc.exists) return false;
        const o = doc.data();
        return o.status === "delivered" && o.deliveredAt === broadcast.at;
      });

      if (toRevert.length) {
        const batch = db.batch();
        toRevert.forEach((doc) => {
          const restoredStatus = broadcast.previousStatuses[doc.id] || "confirmed";
          batch.update(doc.ref, { status: restoredStatus, deliveredAt: null });
        });
        await batch.commit();
      }
      revertedCount = toRevert.length;
    }

    await poolRef.set({ dateKey, deliveryArrivedAt: null, lastDeliveryBroadcast: null }, { merge: true });

    res.json({ ok: true, revertedCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't undo today's delivery broadcast." });
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
/* Lets a customer edit their own still-editable order (items, delivery
   address, contact number) — the counterpart to /:id/cancel below, and
   gated by the exact same rules: only while the order hasn't been
   delivered/cancelled/started ("preparing"), and only while today's
   shared cancellation window is still open. That mirrors the frontend's
   own gating for showing the "Edit order" button in the first place, but
   this is what actually enforces it — this route did not exist before,
   which is why every "Save changes" tap in the edit-order modal failed.
   Items are re-priced from the live menu catalog exactly like order
   creation does (priceOrderItems) — the client's own total is never
   trusted. Since the total can change, reconcilePool runs afterward so
   an edit that pushes the day's pool over (or back under) the minimum is
   reflected immediately, for this order and every other order that day. */
router.patch("/:id", requireAuth, async (req, res) => {
  try {
    const ref = ordersCol.doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "Order not found." });
    const order = doc.data();
    if (order.userMobile !== req.user.mobile) {
      return res.status(403).json({ error: "You can only edit your own orders." });
    }
    if (order.status === "delivered") {
      return res.status(400).json({ error: "This order has already been delivered and can't be edited." });
    }
    if (order.status === "cancelled") {
      return res.status(400).json({ error: "This order is cancelled and can't be edited." });
    }
    if (order.status === "preparing") {
      return res.status(400).json({ error: "The kitchen has already started preparing this order — it can't be edited anymore." });
    }

    const settings = await getSettings();
    const window = getCancelWindow(order, settings);
    const now = Date.now();
    const fmt = (ms) => new Date(ms).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });
    if (window.opensAtMs && now < window.opensAtMs) {
      return res.status(400).json({ error: `Editing opens at ${fmt(window.opensAtMs)} for today's orders.` });
    }
    if (now > window.closesAtMs) {
      return res.status(400).json({ error: `The edit window for today's orders closed at ${fmt(window.closesAtMs)}.` });
    }

    let items, total;
    try {
      ({ items, total } = await priceOrderItems(req.body && req.body.items));
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }

    const address = cleanText(req.body && req.body.address, 300);
    const phone = cleanText(req.body && req.body.phone, 20);
    if (!address) {
      return res.status(400).json({ error: "Please add a delivery address." });
    }
    if (!/^\d{10}$/.test(phone)) {
      return res.status(400).json({ error: "Enter a valid 10-digit contact number." });
    }

    await ref.update({
      items,
      total,
      address,
      customerPhone: phone,
      updatedAt: new Date().toISOString(),
    });

    if (order.dateKey) await reconcilePool(order.dateKey, undefined, settings);

    const freshDoc = await ref.get();
    res.json({ ok: true, order: freshDoc.exists ? freshDoc.data() : order });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't save changes — try again." });
  }
});

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
    if (order.dateKey) await reconcilePool(order.dateKey, undefined, settings);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't cancel the order." });
  }
});

/* Clears the ADMIN DASHBOARD only — see clearAdminDashboard() above. This
   used to hard-delete every order (and every pool record) permanently,
   which meant an admin's accidental tap wiped customers' own order
   history along with it. Now it just stamps a clearedAt cutoff: no order
   document and no pool record is ever deleted. Customers keep their full
   "My Orders" history no matter how many times the admin clears. */
router.delete("/", requireAdmin, async (req, res) => {
  try {
    const clearedAt = await clearAdminDashboard();
    res.json({ ok: true, clearedAt });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't clear the dashboard." });
  }
});

/* Undoes the most recent dashboard clear — manual (the button above) or
   automatic (maybeAutoClearDashboard, once every order's verified
   delivered) — bringing back exactly the orders it hid. One level deep,
   same as /deliver-today/undo: restoring twice with no clear in between
   has no further effect. */
router.post("/clear-dashboard/undo", requireAdmin, async (req, res) => {
  try {
    const state = await getAdminDashboardState();
    if (!state.clearedAt) return res.status(400).json({ error: "There's nothing to restore." });
    await adminStateDoc.set({ clearedAt: state.previousClearedAt || null, previousClearedAt: null }, { merge: true });
    res.json({ ok: true, clearedAt: state.previousClearedAt || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't restore the dashboard." });
  }
});

module.exports = router;
