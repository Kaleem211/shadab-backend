const express = require("express");
const db = require("../db");
const { requireAdmin } = require("../utils/auth");

const router = express.Router();
const DEFAULT_CLOSING_TIME = "19:15";

router.get("/", (req, res) => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'closingTime'").get();
  res.json({ ok: true, closingTime: row ? row.value : DEFAULT_CLOSING_TIME });
});

router.put("/", requireAdmin, (req, res) => {
  const { closingTime } = req.body || {};
  if (!closingTime) return res.status(400).json({ error: "Missing closingTime." });
  db.prepare(`INSERT INTO settings (key, value) VALUES ('closingTime', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(closingTime);
  res.json({ ok: true });
});

router.post("/admin-password", requireAdmin, (req, res) => {
  res.status(400).json({
    error: "To change the admin password, update the ADMIN_PASSWORD environment variable in your Render dashboard (Settings → Environment) and redeploy. It can't be changed from here for security — it's never stored in the website's code.",
  });
});

module.exports = router;
