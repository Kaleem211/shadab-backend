require("dotenv").config();
const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth");
const orderRoutes = require("./routes/orders");
const menuRoutes = require("./routes/menu");
const settingsRoutes = require("./routes/settings");

// Fail fast with a clear message if required secrets are missing.
["GMAIL_USER", "GMAIL_APP_PASSWORD", "JWT_SECRET", "ADMIN_PASSWORD"].forEach((k) => {
  if (!process.env[k]) {
    console.error(`Missing required environment variable: ${k}. See .env.example.`);
  }
});

const app = express();
app.use(express.json());

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error("Not allowed by CORS: " + origin));
  },
}));

app.get("/api/health", (req, res) => res.json({ ok: true, message: "Shadab backend is running." }));

app.use("/api/auth", authRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/menu", menuRoutes);
app.use("/api/settings", settingsRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Server error." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Shadab backend listening on port ${PORT}`));
