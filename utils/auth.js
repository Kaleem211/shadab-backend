const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const JWT_SECRET = process.env.JWT_SECRET;

function signToken(user) {
  return jwt.sign(
    { id: user.id, mobile: user.mobile, email: user.email, username: user.username },
    JWT_SECRET,
    { expiresIn: "30d" }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not logged in." });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Session expired, please log in again." });
  }
}

function requireAdmin(req, res, next) {
  const supplied = req.headers["x-admin-password"];
  if (!supplied || supplied !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Incorrect admin password." });
  }
  next();
}

async function hashPassword(pw) {
  return bcrypt.hash(pw, 10);
}
async function checkPassword(pw, hash) {
  return bcrypt.compare(pw, hash);
}

function genOtp() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
}

module.exports = { signToken, requireAuth, requireAdmin, hashPassword, checkPassword, genOtp };
