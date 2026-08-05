/* =========================================================
   WEB PUSH NOTIFICATIONS
   Sends real browser/OS notifications — the same channel used by
   native apps — via the Push API. Works even when the site isn't
   open, as long as the browser supports it:
     - Android Chrome/Firefox: works for any visited site.
     - iPhone Safari: only works if the site has been "Added to
       Home Screen" (iOS 16.4+) — Apple does not allow push for a
       plain browser tab. See frontend's push.js for the prompt
       that asks iPhone users to do this once.

   Every send is best-effort: a failure here NEVER throws back into
   the caller (order placement, status changes, etc. must succeed
   regardless of whether a push happened to fail). Subscriptions that
   the push service reports as gone (410) or not-found (404) — e.g.
   the user uninstalled/revoked notifications — are pruned so we stop
   wasting sends and Firestore reads on dead devices.
   ========================================================= */

const webpush = require("web-push");
const crypto = require("crypto");
const db = require("../db");

const usersCol = db.collection("users");
const adminSubsCol = db.collection("adminPushSubscriptions");

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_CONTACT = process.env.VAPID_CONTACT_EMAIL || "mailto:admin@example.com";

const configured = !!(VAPID_PUBLIC && VAPID_PRIVATE);
if (configured) {
  webpush.setVapidDetails(VAPID_CONTACT, VAPID_PUBLIC, VAPID_PRIVATE);
} else {
  // Not fatal — the site works fine without push configured, it just
  // silently skips sending. See README for how to generate + set these.
  console.warn("VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — push notifications are disabled.");
}

function endpointKey(endpoint) {
  return crypto.createHash("sha256").update(endpoint).digest("hex");
}

/* Turns an order's item list into a short, readable phrase for push
   notifications — e.g. "Chicken Biryani", "Chicken Biryani x2",
   "Chicken Biryani & Paneer Tikka", or "Chicken Biryani & 2 more items" —
   instead of a bare order id, which meant nothing to a customer glancing
   at a notification. */
function itemSummary(items) {
  if (!Array.isArray(items) || !items.length) return "order";
  const names = items.map((i) => (i.qty && i.qty > 1 ? `${i.name} x${i.qty}` : i.name));
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  const rest = names.length - 1;
  return `${names[0]} & ${rest} more item${rest > 1 ? "s" : ""}`;
}

/* Returns true if the subscription is still good, false if the push
   service says it's gone and should be removed. */
async function sendOne(subscription, payload) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return true;
  } catch (err) {
    // 404/410 = the push service says the subscription itself is gone
    // (uninstalled, permission revoked, etc). 403/400 here almost always
    // means a VAPID key mismatch — the subscription was created against a
    // DIFFERENT public key than the one this server is currently signing
    // with (e.g. the keys were regenerated after someone already
    // subscribed). That's not transient: every future send against it
    // will keep failing the exact same way forever, so it's pruned here
    // too instead of being retried indefinitely. The frontend's subscribe()
    // now detects this key mismatch and creates a fresh subscription, so
    // pruning the dead one here just lets that replacement take over
    // cleanly instead of both existing side by side.
    if ([404, 410, 403, 400].includes(err.statusCode)) return false;
    console.error("Push send failed:", err.statusCode || err.message);
    return true; // genuinely transient failure (network, rate limit) — keep the subscription
  }
}

/**
 * Sends a notification to every device a specific customer (by mobile
 * number, matching how orders are stored) has opted into push on.
 * payload: { title, body, tag?, url? }
 */
async function notifyCustomer(mobile, payload) {
  if (!configured) { console.log("[push] notifyCustomer skipped — VAPID not configured"); return; }
  if (!mobile) { console.log("[push] notifyCustomer skipped — no mobile number on this order"); return; }
  try {
    const snap = await usersCol.where("mobile", "==", mobile).limit(1).get();
    if (snap.empty) { console.log(`[push] notifyCustomer: no user doc found for mobile ${mobile}`); return; }
    const doc = snap.docs[0];
    const subs = doc.data().pushSubscriptions || [];
    if (!subs.length) { console.log(`[push] notifyCustomer: user ${mobile} has 0 saved subscriptions`); return; }
    const results = await Promise.all(subs.map((s) => sendOne(s, payload)));
    const stillGood = subs.filter((_, i) => results[i]);
    console.log(`[push] notifyCustomer ${mobile}: sent to ${stillGood.length}/${subs.length} subscription(s)`);
    if (stillGood.length !== subs.length) {
      await doc.ref.update({ pushSubscriptions: stillGood });
    }
  } catch (err) {
    console.error("notifyCustomer failed:", err);
  }
}

/**
 * Sends a notification to every device currently subscribed for admin
 * new-order alerts — but ONLY devices that unlocked admin with the
 * CENTRAL password. A device that unlocked with the local (per-session)
 * password is deliberately excluded: local unlocks are meant for
 * occasional/one-off access, not for being paged about every new order.
 * Each subscription doc records which password unlocked it at
 * subscribe-admin time (see routes/push.js), so this is a plain
 * Firestore filter rather than anything computed here.
 */
async function notifyAllAdmins(payload) {
  if (!configured) { console.log("[push] notifyAllAdmins skipped — VAPID not configured"); return; }
  try {
    const snap = await adminSubsCol.where("passwordType", "==", "central").get();
    if (snap.empty) { console.log("[push] notifyAllAdmins: 0 central-admin devices subscribed"); return; }
    const dead = [];
    await Promise.all(
      snap.docs.map(async (doc) => {
        const ok = await sendOne(doc.data().subscription, payload);
        if (!ok) dead.push(doc.ref);
      })
    );
    console.log(`[push] notifyAllAdmins: sent to ${snap.size - dead.length}/${snap.size} central-admin device(s)`);
    if (dead.length) {
      const batch = db.batch();
      dead.forEach((ref) => batch.delete(ref));
      await batch.commit();
    }
  } catch (err) {
    console.error("notifyAllAdmins failed:", err);
  }
}

module.exports = { notifyCustomer, notifyAllAdmins, itemSummary, endpointKey, VAPID_PUBLIC, configured };
