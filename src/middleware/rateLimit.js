// Basic in-memory, per-key rate limiter. Lives only in this process's memory,
// so it resets on restart and doesn't share state across multiple instances —
// an accepted limitation for a v1. Swappable for Redis/Upstash later without
// changing anything at the call sites. Unlike on serverless, this actually
// persists across requests here since Express is a long-running process.
const buckets = new Map();

function checkRateLimit(key, { limit = 5, windowMs = 10 * 60 * 1000 } = {}) {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now > bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true };
  }

  if (bucket.count >= limit) {
    return { allowed: false };
  }

  bucket.count += 1;
  return { allowed: true };
}

// req.ip, not X-Forwarded-For directly. The leftmost X-Forwarded-For value is
// whatever the *client* put there — every proxy in the chain appends rather
// than replaces, so a caller sending "X-Forwarded-For: <random>" on each
// request used to land in a brand-new bucket every time and never hit the
// limit at all. req.ip instead honours the app's "trust proxy" hop count (set
// in app.js) and walks back a fixed number of entries from the socket, so it
// resolves to the address our own edge observed and a client cannot forge.
function getClientIp(req) {
  return req.ip || "unknown";
}

// Returns an Express middleware scoped to `prefix` (e.g. "leads", "contact")
// so different routes get independent buckets per client IP.
// `skip(req)` lets a specific route exempt a specific request from this
// route's bucket entirely (used by authRoutes.js for the reviewer bypass) --
// generic here on purpose, this file has no reviewer-specific knowledge.
// `limit`/`windowMs` let a specific route override checkRateLimit's default
// threshold (used by authRoutes.js for the temporary closed-testing bump) --
// left undefined here, they just fall through to checkRateLimit's own
// defaults, so every other caller is unaffected.
export function rateLimit(prefix, { skip, limit, windowMs } = {}) {
  return function rateLimitMiddleware(req, res, next) {
    if (skip && skip(req)) {
      next();
      return;
    }
    const { allowed } = checkRateLimit(`${prefix}:${getClientIp(req)}`, { limit, windowMs });
    if (!allowed) {
      res.status(429).json({ success: false, message: "Too many requests. Please try again later." });
      return;
    }
    next();
  };
}
