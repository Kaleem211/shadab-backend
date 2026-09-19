const express = require("express");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const { sendOtpEmail } = require("../mailer");
const {
  requireAdmin, getPinSecurity, invalidatePinSecurityCache,
  hashPassword, checkPassword, genOtp, isValidPin, signPinToken,
} = require("../utils/auth");

const router = express.Router();

/* =========================================================
   PRIVACY PIN 🔏
   A second, narrower gate in front of the admin dashboard's most
   sensitive screens — Customers and Revenue (and, per menu item, the
   profit margin) — on top of the admin password that unlocks the
   dashboard itself. See utils/auth.js for the token/verification
   internals; this file is just the HTTP surface:

     GET   /pin/status              — is a PIN configured (always true
                                       after the first read seeds one)
     POST  /pin/verify              — check a PIN, get a short-lived
                                       (20 min) Privacy PIN token back
     POST  /pin/change              — set a new PIN (requires the
                                       current one)
     GET   /pin/access              — everyone who has ever unlocked
                                       the PIN, for the "who's using it
                                       / block them" panel
     PATCH /pin/access/:mobile/block(/unblock)
     POST  /pin/forgot              — emails a recovery code to the
                                       fixed recovery addresses below
     POST  /pin/forgot/verify       — redeem that code for a one-time
                                       reset token
     POST  /pin/reset               — set a new PIN using that token
   ========================================================= */

const pinAccessCol = db.collection("pinAccess");
const otpsCol = db.collection("otps");
const pinResetTokensCol = db.collection("pinResetTokens");
const pinSecurityDoc = db.collection("adminSecurity").doc("pinConfig");

// Fixed recovery inboxes for "forgot PIN" — both receive the same code,
// so either can confirm the reset. Not configurable from the dashboard
// on purpose: this is the owner's own recovery path, not something a
// compromised admin session should be able to repoint at itself.
const PIN_RECOVERY_EMAILS = ["kaleem.shaik.ai@gmail.com", "o210418@rguktong.ac.in"];

// PINs are valid for 1 minute 30 seconds — same TTL as every other OTP
// in this app (see routes/auth.js).
const OTP_TTL_MS = 90 * 1000;

// Generous enough for a genuine attempt with a typo or two, tight enough
// to make brute-forcing a 6-digit PIN impractical over the network.
const pinLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 12,
  message: { error: "Too many attempts, please wait a few minutes." },
});

/* Lets the front-end know a PIN exists before it bothers asking for one
   (it always does, once this route has been hit once — see
   getPinSecurity's seeding). Deliberately never returns the hash or
   anything that reveals the PIN's value. */
router.get("/status", requireAdmin, async (req, res) => {
  try {
    await getPinSecurity(); // ensures the doc is seeded
    res.json({ ok: true, configured: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't check the Privacy PIN status." });
  }
});

/* Verify a PIN and, on success, issue the short-lived Privacy PIN token
   the front-end attaches to Customers/Revenue/menu-margin requests.
   Also records (and time-stamps) this account in `pinAccess`, exactly
   like requireAdmin does in the `admins` collection — that's what
   powers "who's using the PIN / block them". */
router.post("/verify", requireAdmin, pinLimiter, async (req, res) => {
  try {
    const { pin } = req.body || {};
    if (!isValidPin(pin)) return res.status(400).json({ error: "Enter the 6-digit Privacy PIN." });

    const accessRef = pinAccessCol.doc(req.user.mobile);
    const accessDoc = await accessRef.get();
    if (accessDoc.exists && accessDoc.data().blocked) {
      return res.status(403).json({ error: "Your Privacy PIN access has been blocked by another admin.", code: "pin_blocked" });
    }

    const security = await getPinSecurity();
    const ok = await checkPassword(pin, security.pinHash);
    if (!ok) return res.status(401).json({ error: "Incorrect PIN.", code: "pin_incorrect" });

    const now = new Date().toISOString();
    if (accessDoc.exists) {
      await accessRef.update({
        name: req.user.username,
        email: req.user.email,
        lastAccess: now,
        accessCount: (accessDoc.data().accessCount || 0) + 1,
      });
    } else {
      await accessRef.set({
        mobile: req.user.mobile,
        name: req.user.username,
        email: req.user.email,
        firstAccess: now,
        lastAccess: now,
        accessCount: 1,
        blocked: false,
      });
    }

    const pinToken = signPinToken(req.user);
    res.json({ ok: true, pinToken, expiresInSeconds: 20 * 60 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't verify the PIN." });
  }
});

/* List every account that has ever unlocked the Privacy PIN — mirrors
   GET /admins for the shared admin password. Admin-gated only (not
   PIN-gated) so this management screen isn't stuck behind itself. */
router.get("/access", requireAdmin, async (req, res) => {
  try {
    const snap = await pinAccessCol.get();
    const access = [];
    snap.forEach((doc) => access.push(doc.data()));
    access.sort((a, b) => (a.lastAccess < b.lastAccess ? 1 : -1));
    res.json({ ok: true, access, currentMobile: req.user.mobile });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't load the Privacy PIN access list." });
  }
});

/* Block a specific mobile number from ever unlocking the Privacy PIN
   again, without rotating the PIN for everyone else. Can't block
   yourself — same reasoning as blockAdmin in routes/admins.js. */
router.patch("/access/:mobile/block", requireAdmin, async (req, res) => {
  try {
    const { mobile } = req.params;
    if (mobile === req.user.mobile) {
      return res.status(400).json({ error: "You can't block your own Privacy PIN access." });
    }
    const ref = pinAccessCol.doc(mobile);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "That account hasn't used the Privacy PIN." });
    await ref.update({ blocked: true, blockedAt: new Date().toISOString(), blockedBy: req.user.mobile });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't block that account." });
  }
});

router.patch("/access/:mobile/unblock", requireAdmin, async (req, res) => {
  try {
    const ref = pinAccessCol.doc(req.params.mobile);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "That account hasn't used the Privacy PIN." });
    await ref.update({ blocked: false, blockedAt: null, blockedBy: null });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't unblock that account." });
  }
});

/* Change the PIN — requires the CURRENT PIN, same pattern as changing
   either admin password in routes/admins.js. */
router.post("/change", requireAdmin, pinLimiter, async (req, res) => {
  try {
    const { currentPin, newPin } = req.body || {};
    if (!isValidPin(newPin)) return res.status(400).json({ error: "New PIN must be exactly 6 digits." });

    const security = await getPinSecurity();
    const ok = currentPin && (await checkPassword(currentPin, security.pinHash));
    if (!ok) return res.status(401).json({ error: "Current PIN is incorrect." });

    const newHash = await hashPassword(newPin);
    await pinSecurityDoc.set({ pinHash: newHash, updatedAt: new Date().toISOString() }, { merge: true });
    invalidatePinSecurityCache();
    res.json({ ok: true, message: "Privacy PIN updated." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't update the Privacy PIN." });
  }
});

/* Forgot PIN, step 1: email a one-time recovery code to BOTH fixed
   recovery addresses (either one can complete the reset). Any earlier,
   unconsumed pin-reset codes are invalidated first so only the latest
   one works — same pattern as /auth/forgot-password. */
router.post("/forgot", requireAdmin, pinLimiter, async (req, res) => {
  try {
    const code = genOtp();
    const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();

    const oldSnap = await otpsCol.where("purpose", "==", "pin-reset").where("consumed", "==", false).get();
    const batch = db.batch();
    oldSnap.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();

    await otpsCol.add({
      email: PIN_RECOVERY_EMAILS.join(","),
      code,
      purpose: "pin-reset",
      expiresAt,
      consumed: false,
      createdAt: new Date().toISOString(),
      requestedBy: req.user.mobile,
    });

    await Promise.all(PIN_RECOVERY_EMAILS.map((addr) => sendOtpEmail(addr, code, "pin-reset")));

    res.json({ ok: true, message: "A recovery code was sent to the registered recovery email addresses." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't send the recovery email. Please try again shortly." });
  }
});

/* Forgot PIN, step 2: redeem the code from either recovery inbox for a
   one-time, 10-minute reset token — mirrors /auth/forgot-password/verify. */
router.post("/forgot/verify", requireAdmin, pinLimiter, async (req, res) => {
  try {
    const otp = String((req.body || {}).otp || "").trim();

    const snap = await otpsCol.where("purpose", "==", "pin-reset").where("consumed", "==", false).get();
    if (snap.empty) return res.status(400).json({ error: "Request a new recovery code.", code: "otp_missing" });

    let latest = null;
    snap.forEach((doc) => {
      const data = { id: doc.id, ...doc.data() };
      if (!latest || data.createdAt > latest.createdAt) latest = data;
    });

    if (new Date(latest.expiresAt) < new Date()) {
      return res.status(400).json({ error: "Code expired. Request a new one.", code: "otp_expired" });
    }
    if (latest.code !== otp) {
      return res.status(400).json({ error: "Incorrect code. Try again.", code: "otp_incorrect" });
    }

    await otpsCol.doc(latest.id).update({ consumed: true });

    const token = crypto.randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await pinResetTokensCol.doc(token).set({ expiresAt, used: false, requestedBy: req.user.mobile });

    res.json({ ok: true, resetToken: token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong verifying that code." });
  }
});

/* Forgot PIN, step 3: actually set the new PIN using the reset token —
   mirrors /auth/reset-password. Doesn't require knowing the old PIN at
   all, since the OTP to the recovery inboxes already proved ownership. */
router.post("/reset", requireAdmin, async (req, res) => {
  try {
    const { resetToken, newPin } = req.body || {};
    if (!isValidPin(newPin)) return res.status(400).json({ error: "New PIN must be exactly 6 digits." });

    const tokenDoc = await pinResetTokensCol.doc(resetToken || "").get();
    if (!tokenDoc.exists) return res.status(400).json({ error: "Recovery session expired. Start again." });
    const row = tokenDoc.data();
    if (row.used || new Date(row.expiresAt) < new Date()) {
      return res.status(400).json({ error: "Recovery session expired. Start again." });
    }

    const newHash = await hashPassword(newPin);
    await pinSecurityDoc.set({ pinHash: newHash, updatedAt: new Date().toISOString() }, { merge: true });
    invalidatePinSecurityCache();
    await pinResetTokensCol.doc(resetToken).update({ used: true });

    res.json({ ok: true, message: "Privacy PIN reset. Use your new PIN to unlock." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't reset the Privacy PIN." });
  }
});

module.exports = router;
