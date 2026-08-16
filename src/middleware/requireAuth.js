import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { connectDB } from "../config/db.js";
import User from "../models/User.js";
import { currentMonthKey } from "../utils/sessionMonth.js";

// Verifies the session JWT issued by authController.signSession and attaches
// { id, phone, role } to req.user. Any route behind this can trust req.user
// without re-checking the database — except the two checks below, which by
// their nature can't be verified from the token alone (session takeover) or
// need a shared clock reference (monthly re-login).
export async function requireAuth(req, res, next) {
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

    // Single-device login + forced monthly re-login — both "teachers and
    // students" features (see authController.signSession), deliberately
    // never checked for the separate admin password-login token
    // (role: "admin", adminController.adminLogin), which carries neither
    // claim at all. A token with no loginMonth/sessionId claim (an admin
    // token, or one issued before this feature existed) is treated as
    // exempt rather than instantly rejected — production tokens self-heal
    // on next login either way, and this avoids mass-invalidating every
    // already-issued session the moment this ships.
    if (payload.role !== "admin") {
      if (payload.loginMonth && payload.loginMonth !== currentMonthKey()) {
        res.status(401).json({ success: false, message: "Your monthly session has expired. Please log in again." });
        return;
      }

      if (payload.sessionId) {
        await connectDB();
        const user = await User.findById(payload.sub).select("+activeSessionId");
        if (!user || user.activeSessionId !== payload.sessionId) {
          res.status(401).json({
            success: false,
            message: "You've been logged out because this account was signed in on another device.",
          });
          return;
        }
      }
    }

    req.user = { id: payload.sub, phone: payload.phone, role: payload.role, isAdmin: Boolean(payload.isAdmin) };
    next();
  } catch (err) {
    if (err?.name === "JsonWebTokenError" || err?.name === "TokenExpiredError") {
      res.status(401).json({ success: false, message: "Invalid or expired session." });
      return;
    }
    console.error("requireAuth failed:", err);
    res.status(401).json({ success: false, message: "Invalid or expired session." });
  }
}
