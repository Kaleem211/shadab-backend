const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { requireAuth, requireAdmin } = require("../utils/auth");

const router = express.Router();
const ordersCol = db.collection("orders");

router.post("/", requireAuth, async (req, res) => {
  try {
    const { customerName, customerPhone, items, total } = req.body || {};
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "Cart is empty." });
    if (typeof total !== "number") return res.status(400).json({ error: "Missing order total." });

    const id = "ORD-" + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString("hex").toUpperCase();
    const order = {
      id,
      userMobile: req.user.mobile,
      customerName: customerName || req.user.username,
      customerPhone: customerPhone || req.user.mobile,
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

router.delete("/", requireAdmin, async (req, res) => {
  const snap = await ordersCol.get();
  const batch = db.batch();
  snap.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
  res.json({ ok: true });
});

module.exports = router;
