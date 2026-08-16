import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { registerPushToken } from "../controllers/notificationsController.js";

const router = Router();

router.post("/register-token", requireAuth, registerPushToken);

export default router;
