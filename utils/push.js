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

/* Returns true if the subscription is still good, false if the push
   service says it's gone and should be removed. */
async function sendOne(subscription, payload) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return true;
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) return false;
    console.error("Push send failed:", err.statusCode || err.message);
    return true; // transient failure (network, rate limit) — keep the subscription
  }
}

/**
 * Sends a notification to every device a specific customer (by mobile
 * number, matching how orders are stored) has opted into push on.
 * payload: { title, body, tag?, url? }
 */
async function notifyCustomer(mobile, payload) {
  if (!configured || !mobile) return;
  try {
    const snap = await usersCol.where("mobile", "==", mobile).limit(1).get();
    if (snap.empty) return;
    const doc = snap.docs[0];
    const subs = doc.data().pushSubscriptions || [];
    if (!subs.length) return;
    const results = await Promise.all(subs.map((s) => sendOne(s, payload)));
    const stillGood = subs.filter((_, i) => results[i]);
    if (stillGood.length !== subs.length) {
      await doc.ref.update({ pushSubscriptions: stillGood });
    }
  } catch (err) {
    console.error("notifyCustomer failed:", err);
  }
}

/**
 * Sends a notification to every device currently subscribed for admin
 * new-order alerts.
 */
async function notifyAllAdmins(payload) {
  if (!configured) return;
  try {
    const snap = await adminSubsCol.get();
    if (snap.empty) return;
    const dead = [];
    await Promise.all(
      snap.docs.map(async (doc) => {
        const ok = await sendOne(doc.data().subscription, payload);
        if (!ok) dead.push(doc.ref);
      })
    );
    if (dead.length) {
      const batch = db.batch();
      dead.forEach((ref) => batch.delete(ref));
      await batch.commit();
    }
  } catch (err) {
    console.error("notifyAllAdmins failed:", err);
  }
}

module.exports = { notifyCustomer, notifyAllAdmins, endpointKey, VAPID_PUBLIC, configured };
