// Stacks after requireAuth — rejects a verified user whose role doesn't
// match, for endpoints that only make sense for one role (e.g. a student
// has no roster to view).
export function requireRole(role) {
  return function requireRoleMiddleware(req, res, next) {
    if (req.user?.role !== role) {
      res.status(403).json({ success: false, message: "Not authorized." });
      return;
    }
    next();
  };
}
