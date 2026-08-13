// Stacks after requireAuth — rejects a verified user who isn't the founder
// account (User.isAdmin, ROADMAP.md Phase 15). isAdmin is trusted straight
// off the JWT, same as role in requireRole.js — requireAuth already treats
// the token as authoritative without re-checking the database.
export function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) {
    res.status(403).json({ success: false, message: "Not authorized." });
    return;
  }
  next();
}
