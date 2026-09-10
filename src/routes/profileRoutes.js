import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { updateProfile, requestAccountDeletion } from "../controllers/profileController.js";

const router = Router();

router.patch("/", requireAuth, updateProfile);
router.post("/deletion-request", requireAuth, requestAccountDeletion);

export default router;
