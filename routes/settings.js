const express = require("express");
const db = require("../db");
const { requireAdmin } = require("../utils/auth");

const router = express.Router();
const settingsCol = db.collection("settings");
const DEFAULT_CLOSING_TIME = "19:15";

router.get("/", async (req, res) => {
  const doc = await settingsCol.doc("closingTime").get();
  res.json({ ok: true, closingTime: doc.exists ? doc.data().value : DEFAULT_CLOSING_TIME });
});

router.put("/", requireAdmin, async (req, res) => {
  const { closingTime } = req.body || {};
  if (!closingTime) return res.status(400).json({ error: "Missing closingTime." });
  await settingsCol.doc("closingTime").set({ value: closingTime });
  res.json({ ok: true });
});

router.post("/admin-password", requireAdmin, (req, res) => {
  res.status(400).json({
    error: "To change the admin password, update the ADMIN_PASSWORD environment variable in your Render dashboard (Settings → Environment) and redeploy. It can't be changed from here for security — it's never stored in the website's code.",
  });
});

module.exports = router;
