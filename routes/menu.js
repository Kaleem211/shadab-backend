const express = require("express");
const db = require("../db");
const { requireAdmin } = require("../utils/auth");

const router = express.Router();

/* Public: get all menu overrides (edited/added items) */
router.get("/", (req, res) => {
  const rows = db.prepare("SELECT * FROM menu_overrides").all();
  res.json({ ok: true, items: rows.map((r) => JSON.parse(r.data_json)) });
});

/* Admin: upsert one item (add or edit) */
router.put("/:id", requireAdmin, (req, res) => {
  const id = req.params.id;
  const data = { ...req.body, id };
  db.prepare(`INSERT INTO menu_overrides (id, data_json) VALUES (?, ?)
              ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json`)
    .run(id, JSON.stringify(data));
  res.json({ ok: true, item: data });
});

/* Admin: delete/restore one item override */
router.delete("/:id", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM menu_overrides WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

/* Admin: restore original menu (wipe all overrides) */
router.delete("/", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM menu_overrides").run();
  res.json({ ok: true });
});

module.exports = router;
