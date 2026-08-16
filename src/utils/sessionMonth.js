// Shared between authController.signSession (writes loginMonth into a fresh
// JWT) and requireAuth (reads it back to decide whether the token is from an
// earlier calendar month) — a single canonical implementation so the two
// sides can never drift into using different clocks/formats. UTC, not local
// server time, so this doesn't shift with the host machine's timezone.
export function currentMonthKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
