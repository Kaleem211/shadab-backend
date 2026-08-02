const db = require("../db");

const menuCol = db.collection("menuOverrides");

/* Keep this in sync with BASE_MENU in the frontend's js/app.js — this is
   the server's own copy of the restaurant's starting menu and prices. It
   only needs id + price + name here; the admin can override any of these
   per item (or add/hide items) via /api/menu, which is what mergeMenu()
   below layers on top. */
const BASE_MENU = [
  { id: "dumbucket-chicken", name: "Chicken Dum Biryani Bucket", note: "", price: 480, category: "Buckets" },
  { id: "dumbucket-medium", name: "Medium Dum Bucket", note: "", price: 850, category: "Buckets" },
  { id: "biryani-2pc", name: "Two Piece Biryani", note: "", price: 180, category: "Biryani" },
  { id: "biryani-lolipop", name: "Lolipop Biryani", note: "", price: 210, category: "Biryani" },
  { id: "biryani-1pc", name: "One Piece Biryani", note: "", price: 120, category: "Biryani" },
  { id: "biryani-fry", name: "Fry Biryani", note: "", price: 210, category: "Fry" },
  { id: "fry-130", name: "Chicken Fry - 130", note: "200–250gm", price: 130, category: "Fry" },
  { id: "fry-180", name: "Chicken Fry - 180", note: "400–450gm", price: 180, category: "Fry" },
  { id: "biryani-curry", name: "Curry Biryani", note: "", price: 210, category: "Curry" },
];

/* Merges BASE_MENU with whatever admin overrides currently exist in
   Firestore — same merge logic the frontend uses to render the menu, so
   the price a customer sees is exactly the price the server will charge.
   `deleted: true` hides a base item entirely (see routes/menu.js). Any
   override id that ISN'T in BASE_MENU is a fully custom item the admin
   added. Returns a Map keyed by item id -> { id, name, price, note,
   category }, containing only items that are currently orderable. */
async function getOrderableMenu() {
  const snap = await menuCol.get();
  const overridesById = new Map();
  snap.forEach((doc) => overridesById.set(doc.id, doc.data()));

  const map = new Map();

  BASE_MENU.forEach((item) => {
    const ov = overridesById.get(item.id);
    if (ov && ov.deleted) return; // hidden by admin
    const merged = ov ? { ...item, ...ov } : item;
    map.set(item.id, merged);
  });

  const baseIds = new Set(BASE_MENU.map((m) => m.id));
  overridesById.forEach((ov, id) => {
    if (baseIds.has(id) || ov.deleted) return;
    map.set(id, { id, name: ov.name, price: ov.price, note: ov.note || "", category: ov.category || "Other" });
  });

  return map;
}

module.exports = { BASE_MENU, getOrderableMenu };
   
