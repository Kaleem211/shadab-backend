const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const db = require("../db");

const JWT_SECRET = process.env.JWT_SECRET;
const adminsCol = db.collection("admins");

function signToken(user) {
  return jwt.sign(
    { id: user.id, mobile: user.mobile, email: user.email, username: user.username },
    JWT_SECRET,
    { expiresIn: "30d" }
  );
}

const usersCol = db.collection("users");

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not logged in." });
  let identity;
  try {
    identity = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Session expired, please log in again." });
  }
  // A JWT stays valid for 30 days regardless of anything that happens to
  // the account after it's issued, so an admin blocking someone wouldn't
  // otherwise take effect until that token expired on its own. This one
  // extra lookup is what makes a block immediate for someone already
  // mid-session, not just for their next login attempt.
  try {
    const doc = await usersCol.doc(identity.id).get();
    if (doc.exists && doc.data().blocked) {
      return res.status(403).json({ error: "This account has been blocked. Contact the restaurant if you think this is a mistake.", code: "account_blocked" });
    }
  } catch (err) {
    console.error("Block-status check failed:", err);
  }
  req.user = identity;
  next();
}

/* Admin access now requires BOTH the shared admin password AND a logged-in
   customer account (the JWT identifies *who* unlocked admin). That identity
   is what lets us show "active admins" with real names/mobiles, and lets an
   admin block a specific person from ever unlocking admin again, without
   having to rotate the shared password for everyone. Every successful
   unlock is recorded/updated in the `admins` collection, keyed by mobile. */
async function requireAdmin(req, res, next) {
  const supplied = req.headers["x-admin-password"];
  if (!supplied || supplied !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Incorrect admin password." });
  }

  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not logged in." });

  let identity;
  try {
    identity = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Session expired, please log in again." });
  }

  try {
    const ref = adminsCol.doc(identity.mobile);
    const doc = await ref.get();
    const now = new Date().toISOString();

    if (doc.exists && doc.data().blocked) {
      return res.status(403).json({ error: "Your admin access has been blocked by another admin." });
    }

    if (doc.exists) {
      await ref.update({
        name: identity.username,
        email: identity.email,
        lastAccess: now,
        accessCount: (doc.data().accessCount || 0) + 1,
      });
    } else {
      await ref.set({
        mobile: identity.mobile,
        name: identity.username,
        email: identity.email,
        firstAccess: now,
        lastAccess: now,
        accessCount: 1,
        blocked: false,
      });
    }

    req.user = identity;
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't verify admin access." });
  }
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
  
