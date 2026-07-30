const express = require("express");
const db = require("../db");
const { requireAdmin } = require("../utils/auth");

const router = express.Router();
const adminsCol = db.collection("admins");

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
