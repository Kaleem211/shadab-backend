const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { requireAuth, requireAdmin } = require("../utils/auth");

const router = express.Router();

/* Customer places an order */
router.post("/", requireAuth, (req, res) => {
  const { customerName, customerPhone, items, total } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "Cart is empty." });
  if (typeof total !== "number") return res.status(400).json({ error: "Missing order total." });

  const id = "ORD-" + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString("hex").toUpperCase();
  db.prepare(`INSERT INTO orders (id, user_mobile, customer_name, customer_phone, items_json, total)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, req.user.mobile, customerName || req.user.username, customerPhone || req.user.mobile, JSON.stringify(items), total);

  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  res.json({ ok: true, order: formatOrder(order) });
});

/* Customer's own orders */
router.get("/mine", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM orders WHERE user_mobile = ? ORDER BY created_at DESC").all(req.user.mobile);
  res.json({ ok: true, orders: rows.map(formatOrder) });
});

/* Admin: all orders */
router.get("/", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT * FROM orders ORDER BY created_at DESC").all();
  res.json({ ok: true, orders: rows.map(formatOrder) });
});

/* Admin: mark delivered */
router.patch("/:id/deliver", requireAdmin, (req, res) => {
  const info = db.prepare("UPDATE orders SET status = 'delivered' WHERE id = ?").run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: "Order not found." });
  res.json({ ok: true });
});

/* Admin: clear all orders */
router.delete("/", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM orders").run();
  res.json({ ok: true });
});

function formatOrder(row) {
  return {
    id: row.id,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    items: JSON.parse(row.items_json),
    total: row.total,
    status: row.status,
    createdAt: row.created_at,
  };
}

module.exports = router;
