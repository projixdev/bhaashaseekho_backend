import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { listConversations, getMessages, sendMessage } from "../controllers/messagesController.js";

const router = Router();

router.get("/conversations", requireAuth, listConversations);
router.get("/conversations/:otherUserId", requireAuth, getMessages);
router.post("/conversations/:otherUserId", requireAuth, sendMessage);

export default router;
