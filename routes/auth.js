const express = require("express");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const db = require("../db");
const { sendOtpEmail } = require("../mailer");
const { signToken, hashPassword, checkPassword, genOtp, requireAuth } = require("../utils/auth");

const router = express.Router();

// Don't let someone hammer the OTP endpoints (costs real emails + is an abuse vector).
const otpLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 8, message: { error: "Too many attempts, please wait a few minutes." } });

const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const isValidMobile = (m) => /^\d{10}$/.test(m);

function findUserByMobile(mobile) {
  return db.prepare("SELECT * FROM users WHERE mobile = ?").get(mobile);
}
function findUserByEmail(email) {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase());
}

/* ---------------- SIGNUP: step 1 — send OTP ---------------- */
router.post("/signup", otpLimiter, async (req, res) => {
  try {
    const { username, mobile, email: rawEmail, password } = req.body || {};
    const email = (rawEmail || "").trim().toLowerCase();

    if (!username || !username.trim()) return res.status(400).json({ error: "Enter a username." });
    if (!isValidMobile(mobile || "")) return res.status(400).json({ error: "Enter a valid 10-digit mobile number." });
    if (!isValidEmail(email)) return res.status(400).json({ error: "Enter a valid email address." });
    if (!password || password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });

    if (findUserByMobile(mobile)) return res.status(409).json({ error: "An account with this mobile number already exists." });
    if (findUserByEmail(email)) return res.status(409).json({ error: "An account with this email already exists." });

    const code = genOtp();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const passwordHash = await hashPassword(password);
    const payload = JSON.stringify({ username: username.trim(), mobile, email, passwordHash });

    db.prepare("DELETE FROM otps WHERE email = ? AND purpose = 'signup'").run(email);
    db.prepare("INSERT INTO otps (email, code, purpose, payload, expires_at) VALUES (?, ?, 'signup', ?, ?)")
      .run(email, code, payload, expiresAt);

    await sendOtpEmail(email, code, "signup");
    res.json({ ok: true, message: "Verification code sent to your email." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't send the verification email. Please try again shortly." });
  }
});

/* ---------------- SIGNUP: resend ---------------- */
router.post("/signup/resend", otpLimiter, async (req, res) => {
  try {
    const email = (req.body?.email || "").trim().toLowerCase();
    const row = db.prepare("SELECT * FROM otps WHERE email = ? AND purpose = 'signup' AND consumed = 0 ORDER BY id DESC LIMIT 1").get(email);
    if (!row) return res.status(400).json({ error: "Start sign up again — no pending verification found." });

    const code = genOtp();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    db.prepare("UPDATE otps SET code = ?, expires_at = ? WHERE id = ?").run(code, expiresAt, row.id);

    await sendOtpEmail(email, code, "signup");
    res.json({ ok: true, message: "New code sent." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't resend the code. Please try again shortly." });
  }
});

/* ---------------- SIGNUP: step 2 — verify OTP, create account ---------------- */
router.post("/signup/verify", async (req, res) => {
  try {
    const email = (req.body?.email || "").trim().toLowerCase();
    const otp = (req.body?.otp || "").trim();

    const row = db.prepare("SELECT * FROM otps WHERE email = ? AND purpose = 'signup' AND consumed = 0 ORDER BY id DESC LIMIT 1").get(email);
    if (!row) return res.status(400).json({ error: "Start sign up again — no pending verification found." });
    if (new Date(row.expires_at) < new Date()) return res.status(400).json({ error: "Code expired. Request a new one." });
    if (row.code !== otp) return res.status(400).json({ error: "Incorrect code. Try again." });

    const { username, mobile, passwordHash } = JSON.parse(row.payload);

    if (findUserByMobile(mobile)) return res.status(409).json({ error: "An account with this mobile number already exists." });
    if (findUserByEmail(email)) return res.status(409).json({ error: "An account with this email already exists." });

    const info = db.prepare("INSERT INTO users (username, mobile, email, password_hash) VALUES (?, ?, ?, ?)")
      .run(username, mobile, email, passwordHash);
    db.prepare("UPDATE otps SET consumed = 1 WHERE id = ?").run(row.id);

    const user = { id: info.lastInsertRowid, username, mobile, email };
    const token = signToken(user);
    res.json({ ok: true, token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong verifying your code." });
  }
});

/* ---------------- LOGIN ---------------- */
router.post("/login", async (req, res) => {
  try {
    const identifier = (req.body?.identifier || "").trim();
    const password = req.body?.password || "";
    if (!identifier || !password) return res.status(400).json({ error: "Enter your mobile/email and password." });

    const user = isValidMobile(identifier) ? findUserByMobile(identifier) : findUserByEmail(identifier);
    if (!user) return res.status(401).json({ error: "Incorrect details. Check and try again, or create an account." });

    const ok = await checkPassword(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Incorrect details. Check and try again, or create an account." });

    const token = signToken(user);
    res.json({ ok: true, token, user: { id: user.id, username: user.username, mobile: user.mobile, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong logging you in." });
  }
});

/* ---------------- FORGOT PASSWORD: send OTP ---------------- */
router.post("/forgot-password", otpLimiter, async (req, res) => {
  try {
    const email = (req.body?.email || "").trim().toLowerCase();
    const user = findUserByEmail(email);
    // Always respond ok (don't reveal which emails exist), but only actually send if the account exists.
    if (user) {
      const code = genOtp();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      db.prepare("DELETE FROM otps WHERE email = ? AND purpose = 'reset'").run(email);
      db.prepare("INSERT INTO otps (email, code, purpose, expires_at) VALUES (?, ?, 'reset', ?)").run(email, code, expiresAt);
      await sendOtpEmail(email, code, "reset");
    }
    res.json({ ok: true, message: "If that email has an account, a code has been sent." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't send the reset email. Please try again shortly." });
  }
});

/* ---------------- FORGOT PASSWORD: resend ---------------- */
router.post("/forgot-password/resend", otpLimiter, async (req, res) => {
  try {
    const email = (req.body?.email || "").trim().toLowerCase();
    const row = db.prepare("SELECT * FROM otps WHERE email = ? AND purpose = 'reset' AND consumed = 0 ORDER BY id DESC LIMIT 1").get(email);
    if (!row) return res.json({ ok: true }); // stay silent either way
    const code = genOtp();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    db.prepare("UPDATE otps SET code = ?, expires_at = ? WHERE id = ?").run(code, expiresAt, row.id);
    await sendOtpEmail(email, code, "reset");
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't resend the code." });
  }
});

/* ---------------- FORGOT PASSWORD: verify OTP -> short-lived reset token ---------------- */
router.post("/forgot-password/verify", (req, res) => {
  const email = (req.body?.email || "").trim().toLowerCase();
  const otp = (req.body?.otp || "").trim();

  const row = db.prepare("SELECT * FROM otps WHERE email = ? AND purpose = 'reset' AND consumed = 0 ORDER BY id DESC LIMIT 1").get(email);
  if (!row) return res.status(400).json({ error: "Request a new code." });
  if (new Date(row.expires_at) < new Date()) return res.status(400).json({ error: "Code expired. Request a new one." });
  if (row.code !== otp) return res.status(400).json({ error: "Incorrect code. Try again." });

  db.prepare("UPDATE otps SET consumed = 1 WHERE id = ?").run(row.id);

  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO reset_tokens (token, email, expires_at) VALUES (?, ?, ?)").run(token, email, expiresAt);

  res.json({ ok: true, resetToken: token });
});

/* ---------------- FORGOT PASSWORD: set new password ---------------- */
router.post("/reset-password", async (req, res) => {
  try {
    const { email: rawEmail, resetToken, newPassword } = req.body || {};
    const email = (rawEmail || "").trim().toLowerCase();
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });

    const row = db.prepare("SELECT * FROM reset_tokens WHERE token = ? AND email = ? AND used = 0").get(resetToken, email);
    if (!row) return res.status(400).json({ error: "Reset session expired. Start the process again." });
    if (new Date(row.expires_at) < new Date()) return res.status(400).json({ error: "Reset session expired. Start the process again." });

    const hash = await hashPassword(newPassword);
    db.prepare("UPDATE users SET password_hash = ? WHERE email = ?").run(hash, email);
    db.prepare("UPDATE reset_tokens SET used = 1 WHERE token = ?").run(resetToken);

    res.json({ ok: true, message: "Password updated. You can log in now." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't reset the password." });
  }
});

/* ---------------- CURRENT USER ---------------- */
router.get("/me", requireAuth, (req, res) => {
  const user = db.prepare("SELECT id, username, mobile, email, created_at FROM users WHERE id = ?").get(req.user.id);
  if (!user) return res.status(404).json({ error: "User not found." });
  res.json({ ok: true, user });
});

router.patch("/me", requireAuth, (req, res) => {
  const { username } = req.body || {};
  if (!username || !username.trim()) return res.status(400).json({ error: "Enter a username." });
  db.prepare("UPDATE users SET username = ? WHERE id = ?").run(username.trim(), req.user.id);
  res.json({ ok: true });
});

module.exports = router;
