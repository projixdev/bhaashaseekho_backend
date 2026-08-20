import { Router } from "express";
import { postLead } from "../controllers/leadsController.js";
import { optionalAuth } from "../middleware/optionalAuth.js";
import { rateLimit } from "../middleware/rateLimit.js";

const router = Router();

router.post("/", rateLimit("leads"), optionalAuth, postLead);

export default router;
