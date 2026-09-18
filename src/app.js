import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import apiRoutes from "./routes/index.js";

const app = express();

// Render fronts every web service with two reverse-proxy layers: inbound
// traffic hits Cloudflare's network first, then Render's own load balancer,
// which is what actually opens the socket to this process (see Render's
// "How Render handles DDoS attacks" — "traffic passes through Cloudflare and
// Render's load balancers, your app sees the proxy's IP by default").
//
// Each of those layers appends to X-Forwarded-For rather than replacing it,
// so the header arriving here reads:
//   <whatever the client sent>, <real client IP>, <Cloudflare edge IP>
// and req.socket.remoteAddress is the Render load balancer. Trusting 2 hops
// makes Express walk back exactly two entries from the socket and land on
// the real client IP — the last value a proxy we control wrote, and the
// first one a client cannot forge. Trusting 1 would land on the Cloudflare
// edge IP instead, which rotates across a small pool and is shared by every
// visitor, collapsing the per-IP rate limiter into a handful of buckets.
//
// This number is deployment topology, not preference: it must equal the
// number of proxies in front of this process. Verify after any change to
// Render's networking (or if the app is moved off Render) by logging req.ip
// on a production request and confirming it matches the caller's real IP.
app.set("trust proxy", 2);

app.use(cors({ origin: env.corsOrigin }));
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.use("/api", apiRoutes);

// 404 fallback
app.use((req, res) => {
  res.status(404).json({ success: false, message: "Not found" });
});

// Centralized error handler — catches anything thrown/rejected in a route
// that wasn't already handled with its own try/catch.
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ success: false, message: "Internal server error" });
});

export default app;
