const express = require("express");
const db = require("../db");
const { requireAdmin } = require("../utils/auth");

const router = express.Router();
const menuCol = db.collection("menuOverrides");

/* Public: get all menu overrides (edited/added items) */
router.get("/", async (req, res) => {
  try {
    const snap = await menuCol.get();
    const items = [];
    snap.forEach((doc) => items.push(doc.data()));
    res.json({ ok: true, items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't load menu overrides." });
  }
});

/* Admin: upsert one item (add or edit) */
router.put("/:id", requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const data = { ...req.body, id };
    await menuCol.doc(id).set(data);
    res.json({ ok: true, item: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't save the menu item." });
  }
});

/* Admin: delete/restore one item override */
router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    await menuCol.doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't delete the menu item." });
  }
});

/* Admin: restore original menu (wipe all overrides) */
router.delete("/", requireAdmin, async (req, res) => {
  try {
    const snap = await menuCol.get();
    const batch = db.batch();
    snap.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't restore the menu." });
  }
});

module.exports = router;

              
