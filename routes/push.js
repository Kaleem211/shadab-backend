const express = require("express");
const db = require("../db");
const { requireAuth, requireAdmin } = require("../utils/auth");
const { VAPID_PUBLIC, endpointKey, configured } = require("../utils/push");

const router = express.Router();
const usersCol = db.collection("users");
const adminSubsCol = db.collection("adminPushSubscriptions");

/* Public — the frontend needs this to call PushManager.subscribe().
   No secret in it; it's meant to be public (that's how VAPID works). */
router.get("/public-key", (req, res) => {
  if (!configured) return res.status(503).json({ error: "Push notifications aren't configured on the server yet." });
  res.json({ publicKey: VAPID_PUBLIC });
});

/* A logged-in customer's device registering for THEIR OWN order-status
   updates. Subscriptions live on the user doc itself (an array, since
   the same person may have several devices), de-duplicated by endpoint
   so re-registering the same device/browser just refreshes it. */
router.post("/subscribe-customer", requireAuth, async (req, res) => {
  const subscription = req.body && req.body.subscription;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: "Missing push subscription." });
  }
  try {
    const ref = usersCol.doc(req.user.id);
    const doc = await ref.get();
    const existing = (doc.exists && doc.data().pushSubscriptions) || [];
    const deduped = existing.filter((s) => s.endpoint !== subscription.endpoint);
    deduped.push(subscription);
    await ref.set({ pushSubscriptions: deduped }, { merge: true });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't save your notification subscription." });
  }
});

router.post("/unsubscribe-customer", requireAuth, async (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  try {
    const ref = usersCol.doc(req.user.id);
    const doc = await ref.get();
    const existing = (doc.exists && doc.data().pushSubscriptions) || [];
    await ref.set({ pushSubscriptions: existing.filter((s) => s.endpoint !== endpoint) }, { merge: true });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't remove that subscription." });
  }
});

/* An admin device registering for new-order alerts. Kept in a separate
   top-level collection (rather than on a user doc) since being an admin
   is a per-device/session thing (the shared admin password), not tied
   to one customer account — keyed by a hash of the endpoint so the same
   device re-subscribing overwrites cleanly instead of piling up. */
router.post("/subscribe-admin", requireAdmin, async (req, res) => {
  const subscription = req.body && req.body.subscription;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: "Missing push subscription." });
  }
  try {
    const key = endpointKey(subscription.endpoint);
    await adminSubsCol.doc(key).set({ subscription, savedAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't save this device for admin alerts." });
  }
});

router.post("/unsubscribe-admin", requireAdmin, async (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  if (!endpoint) return res.status(400).json({ error: "Missing endpoint." });
  try {
    await adminSubsCol.doc(endpointKey(endpoint)).delete();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't remove this device." });
  }
});

module.exports = router;
