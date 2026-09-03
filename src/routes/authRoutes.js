import { Router } from "express";
import { sendOtp, verifyOtp, isReviewerPhone } from "../controllers/authController.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { normalizePhone } from "../utils/validation.js";

const router = Router();

// REVIEWER BYPASS — Play Store review only, do not remove without checking
// Play Console sign-in requirements. Exempts only the configured reviewer
// number from these two routes' rate limit so repeated review logins never
// hit 429; every other phone number keeps the normal 5-per-10min limit.
const skipForReviewer = (req) => isReviewerPhone(normalizePhone(req.body?.phone));

router.post("/send-otp", rateLimit("auth-send-otp", { skip: skipForReviewer }), sendOtp);
router.post("/verify-otp", rateLimit("auth-verify-otp", { skip: skipForReviewer }), verifyOtp);

export default router;
