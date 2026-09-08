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

// TEMPORARY, closed-testing period only: bumped from the default 5/10min to
// 15/10min because switching between teacher/student test accounts on one
// device shares this same per-IP bucket across every phone number tried, so
// the default threshold was tripping on legitimate multi-account QA (see
// QA-CLOSED-TESTING.md), not abuse. The per-IP mechanism itself is still the
// right control -- only this number is temporarily relaxed. Revisit and
// tighten back down to the default before general public launch.
const QA_PERIOD_OTP_LIMIT = { limit: 15 };

router.post("/send-otp", rateLimit("auth-send-otp", { skip: skipForReviewer, ...QA_PERIOD_OTP_LIMIT }), sendOtp);
router.post("/verify-otp", rateLimit("auth-verify-otp", { skip: skipForReviewer, ...QA_PERIOD_OTP_LIMIT }), verifyOtp);

export default router;
