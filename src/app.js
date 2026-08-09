import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import apiRoutes from "./routes/index.js";

const app = express();

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
