const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { getOrFetch, invalidate } = require("./cache");

const JWT_SECRET = process.env.JWT_SECRET;
const adminsCol = db.collection("admins");

/* =========================================================
   ADMIN PASSWORD SYSTEM (central + local)
   Two independent admin passwords now exist, both stored (bcrypt-hashed,
   never in plaintext) in a single Firestore doc kept OUT of the public
   `settings` collection so it's never exposed by GET /settings:

   - centralPasswordHash: the "master" password. A device that unlocks
     admin with this one is meant to stay unlocked forever (the front-end
     persists it in localStorage instead of sessionStorage) — see
     index.html/app.js's admin-gate logic.
   - localPasswordHash: the "normal" password — same behaviour the admin
     password always had: unlocks for the current browser session only,
     and expires after the front-end's inactivity timeout.

   Both are seeded once (on first read) from the legacy ADMIN_PASSWORD
   env var if it's set, or a fallback default otherwise, so existing
   deployments keep working unchanged until an admin explicitly sets new
   passwords from the dashboard's Settings panel. */
const adminSecurityDoc = db.collection("adminSecurity").doc("config");
const LEGACY_DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Shadab@2026";
const ADMIN_SECURITY_CACHE_KEY = "admin-security-doc";

async function getAdminSecurity() {
  return getOrFetch(ADMIN_SECURITY_CACHE_KEY, 15000, async () => {
    const doc = await adminSecurityDoc.get();
    if (doc.exists && doc.data().centralPasswordHash && doc.data().localPasswordHash) {
      return doc.data();
    }
    // First run (or a partially-seeded doc from an older version): seed
    // both passwords from the legacy env var so nothing that already
    // depends on ADMIN_PASSWORD breaks the moment this ships.
    const seedHash = await hashPassword(LEGACY_DEFAULT_ADMIN_PASSWORD);
    const seeded = {
      centralPasswordHash: seedHash,
      localPasswordHash: seedHash,
      updatedAt: new Date().toISOString(),
    };
    await adminSecurityDoc.set(seeded, { merge: true });
    return seeded;
  });
}

function invalidateAdminSecurityCache() {
  invalidate(ADMIN_SECURITY_CACHE_KEY);
}

/* Simple, dependency-free password strength check shared by both the
   central- and local-password change endpoints. Mirrors (in spirit) the
   strength meter shown client-side, so a request that slipped past a
   disabled/JS-less client is still held to the same bar server-side. */
function passwordStrength(pw) {
  const s = String(pw || "");
  let score = 0;
  if (s.length >= 8) score++;
  if (s.length >= 12) score++;
  if (/[a-z]/.test(s) && /[A-Z]/.test(s)) score++;
  if (/\d/.test(s)) score++;
  if (/[^A-Za-z0-9]/.test(s)) score++;
  const labels = ["Very weak", "Weak", "Fair", "Good", "Strong", "Very strong"];
  return { score, label: labels[Math.min(score, labels.length - 1)] };
}

function assertStrongEnough(pw) {
  if (!pw || pw.length < 8) {
    const err = new Error("New password must be at least 8 characters long.");
    err.status = 400;
    throw err;
  }
  const { score } = passwordStrength(pw);
  if (score < 2) {
    const err = new Error("Choose a stronger password — mix upper/lowercase letters, numbers, or symbols.");
    err.status = 400;
    throw err;
  }
}

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
    const blocked = await getOrFetch(`user-blocked-${identity.id}`, 30000, async () => {
      const doc = await usersCol.doc(identity.id).get();
      return doc.exists && !!doc.data().blocked;
    });
    if (blocked) {
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
  if (!supplied) {
    return res.status(401).json({ error: "Incorrect admin password." });
  }

  let passwordType = null;
  try {
    const security = await getAdminSecurity();
    if (security.centralPasswordHash && (await checkPassword(supplied, security.centralPasswordHash))) {
      passwordType = "central";
    } else if (security.localPasswordHash && (await checkPassword(supplied, security.localPasswordHash))) {
      passwordType = "local";
    }
  } catch (err) {
    console.error("Admin password check failed:", err);
    return res.status(500).json({ error: "Couldn't verify admin password." });
  }
  if (!passwordType) {
    return res.status(401).json({ error: "Incorrect admin password." });
  }
  // Exposed to the route handler so GET /admins/verify can tell the
  // front-end which kind of password unlocked this request — that's what
  // decides whether the browser remembers it forever (central) or only
  // for this session (local). Every other admin route ignores this.
  req.adminPasswordType = passwordType;

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

module.exports = {
  signToken, requireAuth, requireAdmin, hashPassword, checkPassword, genOtp,
  getAdminSecurity, invalidateAdminSecurityCache, passwordStrength, assertStrongEnough,
};
  
