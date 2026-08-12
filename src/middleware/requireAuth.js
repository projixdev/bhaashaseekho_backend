import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

// Verifies the session JWT issued by authController.signSession and attaches
// { id, phone, role } to req.user. Any route behind this can trust req.user
// without re-checking the database.
export function requireAuth(req, res, next) {
  const [scheme, token] = (req.headers.authorization || "").split(" ");

  if (scheme !== "Bearer" || !token) {
    res.status(401).json({ success: false, message: "Authentication required." });
    return;
  }

  try {
    const payload = jwt.verify(token, env.jwtSecret);
    req.user = { id: payload.sub, phone: payload.phone, role: payload.role };
    next();
  } catch {
    res.status(401).json({ success: false, message: "Invalid or expired session." });
  }
}
