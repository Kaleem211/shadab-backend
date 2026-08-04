require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");

const authRoutes = require("./routes/auth");
const orderRoutes = require("./routes/orders");
const menuRoutes = require("./routes/menu");
const settingsRoutes = require("./routes/settings");
const adminsRoutes = require("./routes/admins");
const customersRoutes = require("./routes/customers");
const pushRoutes = require("./routes/push");
// Fail fast with a clear message if required secrets are missing.
["GMAIL_USER", "GMAIL_APP_PASSWORD", "JWT_SECRET", "ADMIN_PASSWORD"].forEach((k) => {
  if (!process.env[k]) {
    console.error(`Missing required environment variable: ${k}. See .env.example.`);
  }
});

const app = express();
app.set("trust proxy", 1); // Render sits behind a proxy — needed for express-rate-limit to see real client IPs
app.disable("x-powered-by"); // don't advertise "Express" to fingerprinting tools

// Security headers (CSP left off here since it must be tuned to the exact
// frontend origin/CDNs in use — enable it once you've confirmed nothing breaks).
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(compression()); // gzip responses so the app stays fast under concurrent load

app.use(express.json({ limit: "200kb" })); // cap body size — blocks oversized payload abuse

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error("Not allowed by CORS: " + origin));
  },
}));

// Global safety-net rate limit — generous enough for real traffic, tight enough
// to blunt scripted abuse/DoS attempts. Sensitive routes (OTP, login) keep
// their own stricter limiters on top of this.
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 240, // ~4 requests/second sustained per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down." },
});
app.use("/api", globalLimiter);

app.get("/api/health", (req, res) => res.json({ ok: true, message: "Shadab backend is running." }));

app.use("/api/auth", authRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/menu", menuRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/admins", adminsRoutes);
app.use("/api/customers", customersRoutes);
app.use("/api/push", pushRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Server error." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Shadab backend listening on port ${PORT}`));

/* Background heartbeat: reconciles today's pool/order statuses on a
   timer, not just when a request happens to trigger it (order placed,
   cancelled, edited, or a settings save). Without this, status changes
   that are purely time-based — the pool minimum being reached without
   anyone ordering again, or an order's cancel-window closing so it
   should auto-promote to "preparing" — only ever fired whenever a poll
   or another customer's action happened to reconcile that day, which is
   what made order progress and its push notifications feel delayed or
   "stuck" between traffic. 20s matches the frontend's own live-refresh
   interval (LIVE_REFRESH_MS in app.js), so a status a customer sees
   never lags more than about one poll cycle behind real time. */
setInterval(() => {
  orderRoutes.reconcileToday().catch((err) => console.error("Heartbeat reconcile failed:", err));
}, 20000);
    
