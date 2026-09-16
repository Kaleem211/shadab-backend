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
    const body = req.body || {};

    // This doc is now what order totals are priced against server-side
    // (see utils/menuCatalog.js), so a bad price here isn't just a display
    // bug — it would become the real charged amount. `deleted: true` docs
    // (used to hide a base item) skip the price/name checks since they
    // intentionally carry whatever fields were last saved on that item.
    if (!body.deleted) {
      const price = Number(body.price);
      if (!Number.isFinite(price) || price <= 0 || price > 100000) {
        return res.status(400).json({ error: "Enter a valid price." });
      }
      if (!body.name || !String(body.name).trim()) {
        return res.status(400).json({ error: "Enter a valid name." });
      }
      // Optional: what the admin earns per unit of this item. Left unset,
      // priceOrderItems() (routes/orders.js) treats it as a margin of 0
      // (cost === price) rather than assuming a profit that was never
      // configured. When set, it can't be negative or exceed the item's
      // own price — a margin bigger than the price would mean a negative
      // restaurant cost, which isn't meaningful.
      if (body.profitMargin !== undefined && body.profitMargin !== null && body.profitMargin !== "") {
        const margin = Number(body.profitMargin);
        if (!Number.isFinite(margin) || margin < 0 || margin > price) {
          return res.status(400).json({ error: "Profit margin must be a valid amount, and can't be more than the price." });
        }
      }
    }

    // Merge onto whatever's already saved for this item instead of a bare
    // overwrite. Root cause of "profit margin disappears even though it
    // was set": .set(data) used to replace the ENTIRE doc with only the
    // fields the caller happened to send. Hiding an item (see the
    // frontend's deleteItem()) sends name/price/category/etc. but not
    // profitMargin — under a blind overwrite that silently erased a
    // margin the admin had already configured, and un-hiding the item
    // later never brought it back because it was gone from Firestore.
    // Merging means any field the caller doesn't mention is left alone;
    // a field they DO send (including profitMargin: null, e.g. clearing
    // the margin in the item form) still overwrites as before.
    const existingDoc = await menuCol.doc(id).get();
    const existingData = existingDoc.exists ? existingDoc.data() : {};
    const data = { ...existingData, ...body, id };
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

              
