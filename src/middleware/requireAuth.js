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

    // Catches a trial whose access window naturally elapsed while an
    // already-issued (otherwise still-valid for 30 days) token is still in
    // use — sendOtp only blocks *new* logins, this blocks the rest of an
    // expired trial's session too (ROADMAP.md Phase 14). Read straight off
    // the token, no DB lookup, consistent with the rest of this middleware.
    if (payload.isTrial && payload.accessExpiresAt && new Date(payload.accessExpiresAt).getTime() < Date.now()) {
      res.status(403).json({ success: false, message: "Your trial access has expired." });
      return;
    }

    req.user = { id: payload.sub, phone: payload.phone, role: payload.role, isAdmin: Boolean(payload.isAdmin) };
    next();
  } catch {
    res.status(401).json({ success: false, message: "Invalid or expired session." });
  }
}
