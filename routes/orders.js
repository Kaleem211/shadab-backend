const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { requireAuth, requireAdmin } = require("../utils/auth");

const router = express.Router();
const ordersCol = db.collection("orders");

router.post("/", requireAuth, async (req, res) => {
  try {
    const { customerName, customerPhone, address, items, total } = req.body || {};
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "Cart is empty." });
    if (typeof total !== "number") return res.status(400).json({ error: "Missing order total." });

    const id = "ORD-" + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString("hex").toUpperCase();
    const order = {
      id,
      userMobile: req.user.mobile,
      customerName: customerName || req.user.username,
      customerPhone: customerPhone || req.user.mobile,
      address: address || "",
      items,
      total,
      status: "placed",
      createdAt: new Date().toISOString(),
    };
    await ordersCol.doc(id).set(order);
    res.json({ ok: true, order });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't place the order." });
  }
});

router.get("/mine", requireAuth, async (req, res) => {
  const snap = await ordersCol.where("userMobile", "==", req.user.mobile).get();
  const orders = [];
  snap.forEach((doc) => orders.push(doc.data()));
  orders.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json({ ok: true, orders });
});

router.get("/", requireAdmin, async (req, res) => {
  const snap = await ordersCol.get();
  const orders = [];
  snap.forEach((doc) => orders.push(doc.data()));
  orders.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json({ ok: true, orders });
});

router.patch("/:id/deliver", requireAdmin, async (req, res) => {
  const ref = ordersCol.doc(req.params.id);
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ error: "Order not found." });
  await ref.update({ status: "delivered" });
  res.json({ ok: true });
});

/* Customer cancels their own order. Allowed any time before it's been
   delivered — the front-end only shows the Cancel button while ordering
   is still open (closing time + admin's extra/grace minutes) for the day,
   but this endpoint enforces ownership + status regardless. */
router.patch("/:id/cancel", requireAuth, async (req, res) => {
  try {
    const ref = ordersCol.doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "Order not found." });
    const order = doc.data();
    if (order.userMobile !== req.user.mobile) {
      return res.status(403).json({ error: "You can only cancel your own orders." });
    }
    if (order.status === "delivered") {
      return res.status(400).json({ error: "This order has already been delivered and can't be cancelled." });
    }
    if (order.status === "cancelled") {
      return res.status(400).json({ error: "This order is already cancelled." });
    }
    await ref.update({ status: "cancelled", cancelledAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't cancel the order." });
  }
});

router.delete("/", requireAdmin, async (req, res) => {
  const snap = await ordersCol.get();
  const batch = db.batch();
  snap.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
  res.json({ ok: true });
});

module.exports = router;
  
