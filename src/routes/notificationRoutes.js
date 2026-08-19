import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { registerPushToken, updateNotificationPreferences } from "../controllers/notificationsController.js";

const router = Router();

router.post("/register-token", requireAuth, registerPushToken);
router.patch("/preferences", requireAuth, updateNotificationPreferences);

export default router;
