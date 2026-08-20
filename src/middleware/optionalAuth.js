import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

// Like requireAuth, but never rejects the request — attaches req.user when a
// valid Bearer token is present, leaves it undefined otherwise. For routes
// that serve both the public website (no token) and the logged-in app
// (token), where the token is a convenience (attaching a known identity),
// not a permission gate. Deliberately skips requireAuth's session-validity
// checks (single-device, monthly re-login) — those enforce an authenticated
// *session*, which isn't what's being protected here.
export function optionalAuth(req, _res, next) {
  const [scheme, token] = (req.headers.authorization || "").split(" ");

  if (scheme !== "Bearer" || !token) {
    next();
    return;
  }

  try {
    const payload = jwt.verify(token, env.jwtSecret);
    req.user = { id: payload.sub, phone: payload.phone, role: payload.role, isAdmin: Boolean(payload.isAdmin) };
  } catch {
    // Invalid/expired token on an optional-auth route — treat as anonymous
    // rather than failing the request.
  }
  next();
}
