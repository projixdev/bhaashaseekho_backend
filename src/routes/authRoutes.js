import { Router } from "express";
import { sendOtp, verifyOtp } from "../controllers/authController.js";
import { rateLimit } from "../middleware/rateLimit.js";

const router = Router();

router.post("/send-otp", rateLimit("auth-send-otp"), sendOtp);
router.post("/verify-otp", rateLimit("auth-verify-otp"), verifyOtp);

export default router;
