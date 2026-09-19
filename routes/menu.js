const express = require("express");
const db = require("../db");
const { requireAdmin, requirePin, verifyPinToken } = require("../utils/auth");

const router = express.Router();
const menuCol = db.collection("menuOverrides");

/* Public: get all menu overrides (edited/added items).
   profitMargin is stripped out here — it's the Privacy PIN's business,
   never the public's. Anyone (a customer's browser, an unauthenticated
   request) can hit this endpoint, so it must never leak what the
   restaurant earns per item. The admin dashboard's own Menu tab gets
   margins separately, only once the PIN is unlocked — see GET /margins
   below. */
router.get("/", async (req, res) => {
  try {
    const snap = await menuCol.get();
    const items = [];
    snap.forEach((doc) => {
      const { profitMargin, ...rest } = doc.data();
      items.push(rest);
    });
    res.json({ ok: true, items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't load menu overrides." });
  }
});

/* Admin + Privacy PIN only: the profit margin for every item, keyed by
   id. Kept as a separate endpoint (rather than a flag on GET /) so the
   public/customer-facing catalog call above can never accidentally
   start including margins again — the only way to get them is this
   route, and it's gated the same way Customers/Revenue are. */
router.get("/margins", requireAdmin, requirePin, async (req, res) => {
  try {
    const snap = await menuCol.get();
    const margins = {};
    snap.forEach((doc) => {
      const d = doc.data();
      margins[d.id] = (d.profitMargin != null && d.profitMargin !== "") ? d.profitMargin : null;
    });
    res.json({ ok: true, margins });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't load profit margins." });
  }
});

/* Admin: upsert one item (add or edit) */
router.put("/:id", requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const body = req.body || {};

    // Fetched up front (not just where it was previously read, further
    // down) so it's available for the profit-margin-changed check below
    // as well as the merge at the end.
    const existingDoc = await menuCol.doc(id).get();
    const existingData = existingDoc.exists ? existingDoc.data() : {};

    // The profit margin is Privacy-PIN-gated: viewing AND editing it
    // both require the PIN, on top of the ordinary admin password.
    // Scoped to only when the margin is actually CHANGING (not just
    // present in the payload) so routine saves that merely carry the
    // margin through unchanged — e.g. hiding/un-hiding an item, see
    // deleteItem() in the frontend — never get blocked by a PIN prompt
    // for a value nobody is touching.
    const incomingMargin = body.profitMargin === undefined ? undefined : (body.profitMargin === "" ? null : body.profitMargin);
    const existingMargin = (existingData.profitMargin === undefined || existingData.profitMargin === "") ? null : existingData.profitMargin;
    const marginChanging = incomingMargin !== undefined && Number(incomingMargin) !== Number(existingMargin || 0) && !(incomingMargin == null && existingMargin == null);
    if (marginChanging) {
      const pinCheck = await verifyPinToken(req);
      if (!pinCheck.ok) return res.status(pinCheck.status).json({ error: pinCheck.message, code: pinCheck.code });
    }

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
    // (existingDoc/existingData were already fetched above, for the
    // margin-changed check.)
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

              
