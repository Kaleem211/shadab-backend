const express = require("express");
const db = require("../db");
const {
  requireAdmin, getAdminSecurity, invalidateAdminSecurityCache,
  hashPassword, checkPassword, assertStrongEnough, passwordStrength,
} = require("../utils/auth");
const { invalidate } = require("../utils/cache");

const router = express.Router();
const adminsCol = db.collection("admins");
const adminSecurityDoc = db.collection("adminSecurity").doc("config");
// Development Mode — see utils/push.js's getDevMode() for how this doc
// is read (and cached) when deciding whether to send a notification.
const devModeDoc = db.collection("appConfig").doc("devMode");

/* Tells the front-end which of the two admin passwords was just used to
   unlock this request — requireAdmin already did the actual verification
   (and the identity/block check, and recorded this device in the
   `admins` collection); this just surfaces the result. The admin gate
   calls this instead of a generic admin route the moment the password
   form is submitted, purely to learn "central" vs "local" so it knows
   whether to remember the password forever (localStorage) or only for
   this browser session (sessionStorage, with an inactivity timeout). */
router.get("/verify", requireAdmin, (req, res) => {
  res.json({ ok: true, type: req.adminPasswordType, name: req.user.username });
});

/* =========================================================
   DEVELOPMENT MODE 🚧
   A single shared on/off switch, gated to the CENTRAL password only,
   for testing the live site without disturbing anyone else:
     - GET  /dev-mode          — current status (any admin can read it)
     - POST /dev-mode/enable   — turns it on, recording WHO (by mobile —
       the customer account that unlocked admin) turned it on
     - POST /dev-mode/disable  — turns it off
   utils/push.js's notifyCustomer/notifyAllAdmins read this same doc to
   silently skip every notification except the ones addressed to the
   developer's own mobile number, so real customers and other admins
   never see test traffic while this is on. It never blocks ordering
   itself — only notifications. */
router.get("/dev-mode", requireAdmin, async (req, res) => {
  try {
    const doc = await devModeDoc.get();
    const data = doc.exists ? doc.data() : {};
    const enabled = !!data.enabled;
    res.json({
      ok: true,
      enabled,
      developerName: enabled ? (data.developerName || data.developerMobile || null) : null,
      isYou: enabled && data.developerMobile === req.user.mobile,
      canToggle: req.adminPasswordType === "central",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't load Development Mode status." });
  }
});

router.post("/dev-mode/enable", requireAdmin, async (req, res) => {
  if (req.adminPasswordType !== "central") {
    return res.status(403).json({ error: "Unlock admin with the central password to turn on Development Mode." });
  }
  try {
    const developerName = req.user.username || req.user.mobile;
    await devModeDoc.set({
      enabled: true,
      developerMobile: req.user.mobile,
      developerName,
      enabledAt: new Date().toISOString(),
    });
    invalidate("dev-mode-doc");
    res.json({ ok: true, enabled: true, developerName });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't turn on Development Mode." });
  }
});

router.post("/dev-mode/disable", requireAdmin, async (req, res) => {
  if (req.adminPasswordType !== "central") {
    return res.status(403).json({ error: "Unlock admin with the central password to turn off Development Mode." });
  }
  try {
    await devModeDoc.set(
      { enabled: false, developerMobile: null, developerName: null, disabledAt: new Date().toISOString() },
      { merge: true }
    );
    invalidate("dev-mode-doc");
    res.json({ ok: true, enabled: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't turn off Development Mode." });
  }
});

/* Change the CENTRAL (master) admin password. Requires the CURRENT
   central password specifically — not just any valid admin password —
   so someone who only knows the local/normal password can't silently
   take over the master one. */
router.post("/password/central", requireAdmin, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const security = await getAdminSecurity();
    const ok = currentPassword && (await checkPassword(currentPassword, security.centralPasswordHash));
    if (!ok) return res.status(401).json({ error: "Current central password is incorrect." });

    try {
      assertStrongEnough(newPassword);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }

    const newHash = await hashPassword(newPassword);
    await adminSecurityDoc.set({ centralPasswordHash: newHash, updatedAt: new Date().toISOString() }, { merge: true });
    invalidateAdminSecurityCache();
    res.json({ ok: true, message: "Central password updated." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't update the central password." });
  }
});

/* Change the LOCAL (normal, session-only) admin password. Requires the
   current LOCAL password specifically. */
router.post("/password/local", requireAdmin, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const security = await getAdminSecurity();
    const ok = currentPassword && (await checkPassword(currentPassword, security.localPasswordHash));
    if (!ok) return res.status(401).json({ error: "Current local admin password is incorrect." });

    try {
      assertStrongEnough(newPassword);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }

    const newHash = await hashPassword(newPassword);
    await adminSecurityDoc.set({ localPasswordHash: newHash, updatedAt: new Date().toISOString() }, { merge: true });
    invalidateAdminSecurityCache();
    res.json({ ok: true, message: "Local admin password updated." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't update the local admin password." });
  }
});

/* Lightweight, no-auth-required strength check the front-end's live
   meter can optionally confirm against as someone types a new password
   (the real, authoritative check still happens in the two routes above
   at submit time). */
router.post("/password/strength", (req, res) => {
  res.json({ ok: true, ...passwordStrength((req.body || {}).password) });
});

/* List every account that has ever unlocked admin, most recently active
   first. Used to power the "Active Admins" panel in the dashboard. */
router.get("/", requireAdmin, async (req, res) => {
  try {
    const snap = await adminsCol.get();
    const admins = [];
    snap.forEach((doc) => admins.push(doc.data()));
    admins.sort((a, b) => (a.lastAccess < b.lastAccess ? 1 : -1));
    res.json({ ok: true, admins, currentMobile: req.user.mobile });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't load admins." });
  }
});

/* Block a specific mobile number from unlocking admin. An admin can't
   block themselves — that would risk locking everyone out if they're the
   only one currently signed in. */
router.patch("/:mobile/block", requireAdmin, async (req, res) => {
  try {
    const { mobile } = req.params;
    if (mobile === req.user.mobile) {
      return res.status(400).json({ error: "You can't block your own admin access." });
    }
    const ref = adminsCol.doc(mobile);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "That admin wasn't found." });
    await ref.update({ blocked: true, blockedAt: new Date().toISOString(), blockedBy: req.user.mobile });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't block that admin." });
  }
});

router.patch("/:mobile/unblock", requireAdmin, async (req, res) => {
  try {
    const ref = adminsCol.doc(req.params.mobile);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "That admin wasn't found." });
    await ref.update({ blocked: false, blockedAt: null, blockedBy: null });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't unblock that admin." });
  }
});

module.exports = router;
