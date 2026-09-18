import { Router } from "express";
import { sendOtp, verifyOtp, isReviewerPhone } from "../controllers/authController.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { normalizePhone } from "../utils/validation.js";

const router = Router();

// REVIEWER BYPASS — do not remove without checking Play Console and App
// Store Connect sign-in requirements. Exempts every configured reviewer/demo
// number (isReviewerPhone checks a list, see env.js) from these two routes'
// rate limit so repeated review logins never hit 429; every other phone
// number keeps the normal limit.
const skipForReviewer = (req) => isReviewerPhone(normalizePhone(req.body?.phone));

// Closed testing is over, so the temporary 15/10min bump these two routes
// carried during it is gone: no explicit limit here means both fall through
// to rateLimit's own 5/10min default, same as every other rate-limited route.
// (The QA problem that bump existed for -- one device cycling through several
// test accounts sharing a per-IP bucket -- only ever applied to testers.)
router.post("/send-otp", rateLimit("auth-send-otp", { skip: skipForReviewer }), sendOtp);
router.post("/verify-otp", rateLimit("auth-verify-otp", { skip: skipForReviewer }), verifyOtp);

export default router;
