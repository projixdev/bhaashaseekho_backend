import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { updateProfile } from "../controllers/profileController.js";

const router = Router();

router.patch("/", requireAuth, updateProfile);

export default router;
