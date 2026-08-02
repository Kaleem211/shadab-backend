const express = require("express");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const { sendOtpEmail } = require("../mailer");
const { signToken, hashPassword, checkPassword, genOtp, requireAuth } = require("../utils/auth");
const { validateCampusEmail } = require("../utils/campusEmail");

const router = express.Router();

const otpLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 8, message: { error: "Too many attempts, please wait a few minutes." } });

// OTPs are valid for 1 minute 30 seconds.
const OTP_TTL_MS = 90 * 1000;

const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const isValidMobile = (m) => /^\d{10}$/.test(m);

const usersCol = db.collection("users");
const otpsCol = db.collection("otps");
const resetTokensCol = db.collection("resetTokens");

async function findUserByMobile(mobile) {
  const snap = await usersCol.where("mobile", "==", mobile).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}
async function findUserByEmail(email) {
  const snap = await usersCol.where("email", "==", email.toLowerCase()).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

async function findLatestOtp(email, purpose) {
  const snap = await otpsCol
    .where("email", "==", email)
    .where("purpose", "==", purpose)
    .where("consumed", "==", false)
    .get();
  if (snap.empty) return null;
  let latest = null;
  snap.forEach((doc) => {
    const data = { id: doc.id, ...doc.data() };
    if (!latest || data.createdAt > latest.createdAt) latest = data;
  });
  return latest;
}

router.post("/signup", otpLimiter, async (req, res) => {
  try {
    const { username, mobile, email: rawEmail, password } = req.body || {};
    const email = (rawEmail || "").trim().toLowerCase();

    if (!username || !username.trim()) return res.status(400).json({ error: "Enter a username." });
    if (!isValidMobile(mobile || "")) return res.status(400).json({ error: "Enter a valid 10-digit mobile number." });

    const emailCheck = validateCampusEmail(email);
    if (!emailCheck.ok) return res.status(422).json({ error: emailCheck.error, code: emailCheck.code });

    if (!password || password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });

    if (await findUserByMobile(mobile)) return res.status(409).json({ error: "An account with this mobile number already exists." });
    if (await findUserByEmail(email)) return res.status(409).json({ error: "An account with this email already exists." });

    const code = genOtp();
    const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
    const passwordHash = await hashPassword(password);
    const payload = JSON.stringify({ username: username.trim(), mobile, email, passwordHash });

    const oldSnap = await otpsCol.where("email", "==", email).where("purpose", "==", "signup").get();
    const batch = db.batch();
    oldSnap.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();

    await otpsCol.add({
      email, code, purpose: "signup", payload,
      expiresAt, consumed: false, createdAt: new Date().toISOString(),
    });

    await sendOtpEmail(email, code, "signup");
    res.json({ ok: true, message: "Verification code sent to your email." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't send the verification email. Please try again shortly." });
  }
});

router.post("/signup/resend", otpLimiter, async (req, res) => {
  try {
    const email = (req.body?.email || "").trim().toLowerCase();
    const row = await findLatestOtp(email, "signup");
    if (!row) return res.status(400).json({ error: "Start sign up again — no pending verification found." });

    const code = genOtp();
    const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
    await otpsCol.doc(row.id).update({ code, expiresAt });

    await sendOtpEmail(email, code, "signup");
    res.json({ ok: true, message: "New code sent." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't resend the code. Please try again shortly." });
  }
});

router.post("/signup/verify", async (req, res) => {
  try {
    const email = (req.body?.email || "").trim().toLowerCase();
    const otp = (req.body?.otp || "").trim();

    const row = await findLatestOtp(email, "signup");
    if (!row) return res.status(400).json({ error: "Start sign up again — no pending verification found.", code: "otp_missing" });
    if (new Date(row.expiresAt) < new Date()) return res.status(400).json({ error: "OTP expired. Please request a new one.", code: "otp_expired" });
    if (row.code !== otp) return res.status(400).json({ error: "Incorrect code. Try again.", code: "otp_incorrect" });

    const { username, mobile, passwordHash } = JSON.parse(row.payload);

    if (await findUserByMobile(mobile)) return res.status(409).json({ error: "An account with this mobile number already exists." });
    if (await findUserByEmail(email)) return res.status(409).json({ error: "An account with this email already exists." });

    const userRef = await usersCol.add({
      username, mobile, email, passwordHash,
      createdAt: new Date().toISOString(),
    });
    await otpsCol.doc(row.id).update({ consumed: true });

    const user = { id: userRef.id, username, mobile, email };
    const token = signToken(user);
    res.json({ ok: true, token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong verifying your code." });
  }
});

router.post("/login", async (req, res) => {
  try {
    const identifier = (req.body?.identifier || "").trim();
    const password = req.body?.password || "";
    if (!identifier || !password) return res.status(400).json({ error: "Enter your mobile/email and password." });

    const user = isValidMobile(identifier) ? await findUserByMobile(identifier) : await findUserByEmail(identifier);
    if (!user) return res.status(401).json({ error: "This account isn't registered. Check your details or create an account.", code: "invalid_credentials" });

    if (user.blocked) {
      return res.status(403).json({ error: "This account has been blocked. Contact the restaurant if you think this is a mistake.", code: "account_blocked" });
    }

    const ok = await checkPassword(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Incorrect password. Please try again.", code: "invalid_credentials" });

    const token = signToken(user);
    res.json({ ok: true, token, user: { id: user.id, username: user.username, mobile: user.mobile, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong logging you in." });
  }
});

router.post("/forgot-password", otpLimiter, async (req, res) => {
  try {
    const email = (req.body?.email || "").trim().toLowerCase();

    // Same college-email policy as sign up, so this field can't be used
    // to probe with arbitrary/malformed addresses.
    const emailCheck = validateCampusEmail(email);
    if (!emailCheck.ok) return res.status(422).json({ error: emailCheck.error, code: emailCheck.code });

    // NOTE (intentional product decision, not an oversight): this confirms
    // whether an account exists, which is a deliberate UX trade-off against
    // the usual "don't reveal account existence" best practice. It's scoped
    // to a closed campus email domain and already covered by otpLimiter's
    // rate limiting, which keeps this from being a practical enumeration
    // vector. If that changes (e.g. this domain opens up publicly), switch
    // this back to the generic "if that email has an account…" response.
    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(404).json({
        error: "No account is registered with this email.",
        code: "not_registered",
      });
    }
    if (user.blocked) {
      return res.status(403).json({ error: "This account has been blocked. Contact the restaurant if you think this is a mistake.", code: "account_blocked" });
    }

    const code = genOtp();
    const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();

    const oldSnap = await otpsCol.where("email", "==", email).where("purpose", "==", "reset").get();
    const batch = db.batch();
    oldSnap.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();

    await otpsCol.add({
      email, code, purpose: "reset",
      expiresAt, consumed: false, createdAt: new Date().toISOString(),
    });
    await sendOtpEmail(email, code, "reset");

    res.json({ ok: true, message: "Reset code sent to your email." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't send the reset email. Please try again shortly." });
  }
});

router.post("/forgot-password/resend", otpLimiter, async (req, res) => {
  try {
    const email = (req.body?.email || "").trim().toLowerCase();
    const row = await findLatestOtp(email, "reset");
    if (!row) return res.status(400).json({ error: "Request a new code.", code: "otp_missing" });
    const code = genOtp();
    const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
    await otpsCol.doc(row.id).update({ code, expiresAt });
    await sendOtpEmail(email, code, "reset");
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't resend the code." });
  }
});

router.post("/forgot-password/verify", async (req, res) => {
  try {
    const email = (req.body?.email || "").trim().toLowerCase();
    const otp = (req.body?.otp || "").trim();

    const row = await findLatestOtp(email, "reset");
    if (!row) return res.status(400).json({ error: "Request a new code.", code: "otp_missing" });
    if (new Date(row.expiresAt) < new Date()) return res.status(400).json({ error: "OTP expired. Please request a new one.", code: "otp_expired" });
    if (row.code !== otp) return res.status(400).json({ error: "Incorrect code. Try again.", code: "otp_incorrect" });

    await otpsCol.doc(row.id).update({ consumed: true });

    const token = crypto.randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await resetTokensCol.doc(token).set({ email, expiresAt, used: false });

    res.json({ ok: true, resetToken: token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong." });
  }
});

router.post("/reset-password", async (req, res) => {
  try {
    const { email: rawEmail, resetToken, newPassword } = req.body || {};
    const email = (rawEmail || "").trim().toLowerCase();
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });

    const tokenDoc = await resetTokensCol.doc(resetToken || "").get();
    if (!tokenDoc.exists) return res.status(400).json({ error: "Reset session expired. Start the process again." });
    const row = tokenDoc.data();
    if (row.email !== email || row.used) return res.status(400).json({ error: "Reset session expired. Start the process again." });
    if (new Date(row.expiresAt) < new Date()) return res.status(400).json({ error: "Reset session expired. Start the process again." });

    const hash = await hashPassword(newPassword);
    const user = await findUserByEmail(email);
    if (user) await usersCol.doc(user.id).update({ passwordHash: hash });
    await resetTokensCol.doc(resetToken).update({ used: true });

    // They just proved ownership of this account via OTP and set a new
    // password — no reason to make them log in again with it right away.
    const token = user ? signToken(user) : null;
    res.json({
      ok: true,
      message: "Password updated. You're logged in.",
      token,
      user: user ? { id: user.id, username: user.username, mobile: user.mobile, email: user.email } : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't reset the password." });
  }
});

/* "Skip for now" on the reset-password step. The person already proved
   they own this account by completing the email OTP a moment ago — that's
   the same proof of identity /reset-password relies on — so if they don't
   want to change their password right now, there's no good reason to also
   make them go type it in again on the login screen. This consumes the
   same one-time resetToken (so it can't also be used for /reset-password
   afterward) and simply logs them in, exactly as /login would after a
   correct password. */
router.post("/forgot-password/skip", async (req, res) => {
  try {
    const { email: rawEmail, resetToken } = req.body || {};
    const email = (rawEmail || "").trim().toLowerCase();

    const tokenDoc = await resetTokensCol.doc(resetToken || "").get();
    if (!tokenDoc.exists) return res.status(400).json({ error: "Reset session expired. Start the process again." });
    const row = tokenDoc.data();
    if (row.email !== email || row.used) return res.status(400).json({ error: "Reset session expired. Start the process again." });
    if (new Date(row.expiresAt) < new Date()) return res.status(400).json({ error: "Reset session expired. Start the process again." });

    const user = await findUserByEmail(email);
    if (!user) return res.status(404).json({ error: "Account not found." });

    await resetTokensCol.doc(resetToken).update({ used: true });

    const token = signToken(user);
    res.json({ ok: true, token, user: { id: user.id, username: user.username, mobile: user.mobile, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't complete verification." });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  const doc = await usersCol.doc(req.user.id).get();
  if (!doc.exists) return res.status(404).json({ error: "User not found." });
  const { passwordHash, ...user } = doc.data();
  res.json({ ok: true, user: { id: doc.id, ...user } });
});

router.patch("/me", requireAuth, async (req, res) => {
  const { username } = req.body || {};
  if (!username || !username.trim()) return res.status(400).json({ error: "Enter a username." });
  await usersCol.doc(req.user.id).update({ username: username.trim() });
  res.json({ ok: true });
});

module.exports = router;

