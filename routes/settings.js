const express = require("express");
const db = require("../db");
const { requireAdmin } = require("../utils/auth");

const router = express.Router();

/* All restaurant-wide settings now live in ONE Firestore document instead of
   just a closingTime field, so the admin can control the ordering cut-off,
   the extra/grace minutes after cut-off, the delivery time window shown to
   customers, the list of contact numbers, and the WhatsApp group link — all
   from the admin dashboard, applied instantly for every customer. */
const settingsDoc = db.collection("settings").doc("config");

const DEFAULTS = {
  closingTime: "19:15",           // 7:15 PM
  graceMinutes: 3,                // extra minutes admin allows after closing
  deliveryWindowStart: "20:30",   // 8:30 PM
  deliveryWindowEnd: "20:45",     // 8:45 PM
  whatsappGroupLink: "https://chat.whatsapp.com/JiF939y4TlyKkZaFuznaWe",
  contacts: [
    { id: "shareef", name: "Shareef", phone: "+91 63009 47969", details: "" },
  ],
  // Orders are held as "pending" until the combined value of everyone's
  // orders for the day reaches this amount — then they all confirm at once.
  minOrderPoolAmount: 600,
  // How many extra minutes past the daily cutoff (closingTime +
  // graceMinutes) a customer is still allowed to cancel an order. Shared
  // by every order placed that day — e.g. closing 19:15 + 3 min grace +
  // 15 here means all of today's orders can be cancelled up until 19:33.
  // Only used when cancellationMode is "afterClosing". See orders.js's
  // getCancelWindow() for the actual computation.
  cancelWindowMinutes: 15,
  // Which method decides the cancellation deadline:
  //  - "afterClosing": cancelWindowMinutes past (closingTime + graceMinutes)
  //  - "timeRange": a fixed clock-time window (cancelWindowStart to
  //    cancelWindowEnd) each day, independent of closing time
  cancellationMode: "afterClosing",
  cancelWindowStart: "18:00",  // 6:00 PM — only used when cancellationMode is "timeRange"
  cancelWindowEnd: "19:00",    // 7:00 PM — only used when cancellationMode is "timeRange"
};

const ALLOWED_KEYS = [
  "closingTime",
  "graceMinutes",
  "deliveryWindowStart",
  "deliveryWindowEnd",
  "whatsappGroupLink",
  "contacts",
  "minOrderPoolAmount",
  "cancelWindowMinutes",
  "cancellationMode",
  "cancelWindowStart",
  "cancelWindowEnd",
];

/* Public: every customer's browser calls this on load so everyone always
   sees the admin's current settings — not something cached per-device. */
router.get("/", async (req, res) => {
  try {
    const doc = await settingsDoc.get();
    const saved = doc.exists ? doc.data() : {};
    res.json({ ok: true, settings: { ...DEFAULTS, ...saved } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't load settings." });
  }
});

/* Admin only: partial update — only the fields sent in the body are
   changed, everything else is left as-is (merge: true). */
router.put("/", requireAdmin, async (req, res) => {
  try {
    const updates = {};
    for (const key of ALLOWED_KEYS) {
      if (req.body && req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No valid settings fields provided." });
    }

    if (updates.closingTime && !/^\d{2}:\d{2}$/.test(updates.closingTime)) {
      return res.status(400).json({ error: "closingTime must be in HH:MM format." });
    }
    if (updates.deliveryWindowStart && !/^\d{2}:\d{2}$/.test(updates.deliveryWindowStart)) {
      return res.status(400).json({ error: "deliveryWindowStart must be in HH:MM format." });
    }
    if (updates.deliveryWindowEnd && !/^\d{2}:\d{2}$/.test(updates.deliveryWindowEnd)) {
      return res.status(400).json({ error: "deliveryWindowEnd must be in HH:MM format." });
    }
    if (updates.graceMinutes !== undefined) {
      const n = Number(updates.graceMinutes);
      if (!Number.isFinite(n) || n < 0 || n > 60) {
        return res.status(400).json({ error: "graceMinutes must be a number between 0 and 60." });
      }
      updates.graceMinutes = n;
    }
    if (updates.contacts !== undefined && !Array.isArray(updates.contacts)) {
      return res.status(400).json({ error: "contacts must be an array." });
    }
    if (updates.minOrderPoolAmount !== undefined) {
      const n = Number(updates.minOrderPoolAmount);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ error: "minOrderPoolAmount must be a positive number." });
      }
      updates.minOrderPoolAmount = n;
    }
    if (updates.cancelWindowMinutes !== undefined) {
      const n = Number(updates.cancelWindowMinutes);
      if (!Number.isFinite(n) || n < 0 || n > 1440) {
        return res.status(400).json({ error: "cancelWindowMinutes must be a number between 0 and 1440." });
      }
      updates.cancelWindowMinutes = n;
    }
    if (updates.cancellationMode !== undefined && !["afterClosing", "timeRange"].includes(updates.cancellationMode)) {
      return res.status(400).json({ error: "cancellationMode must be 'afterClosing' or 'timeRange'." });
    }
    if (updates.cancelWindowStart && !/^\d{2}:\d{2}$/.test(updates.cancelWindowStart)) {
      return res.status(400).json({ error: "cancelWindowStart must be in HH:MM format." });
    }
    if (updates.cancelWindowEnd && !/^\d{2}:\d{2}$/.test(updates.cancelWindowEnd)) {
      return res.status(400).json({ error: "cancelWindowEnd must be in HH:MM format." });
    }
    // Guard against an inverted range only when both ends are present in
    // this update, or already present in the saved doc — so a partial
    // update to just one side doesn't false-positive against a stale value.
    {
      const existing = (await settingsDoc.get()).data() || {};
      const start = updates.cancelWindowStart || existing.cancelWindowStart || DEFAULTS.cancelWindowStart;
      const end = updates.cancelWindowEnd || existing.cancelWindowEnd || DEFAULTS.cancelWindowEnd;
      if ((updates.cancelWindowStart || updates.cancelWindowEnd) && start >= end) {
        return res.status(400).json({ error: "Cancellation window end time must be after the start time." });
      }
    }

    await settingsDoc.set(updates, { merge: true });
    const doc = await settingsDoc.get();
    res.json({ ok: true, settings: { ...DEFAULTS, ...doc.data() } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't save settings." });
  }
});

router.post("/admin-password", requireAdmin, (req, res) => {
  res.status(400).json({
    error: "To change the admin password, update the ADMIN_PASSWORD environment variable in your Render dashboard (Settings → Environment) and redeploy. It can't be changed from here for security — it's never stored in the website's code.",
  });
});

module.exports = router;
              
