import { Router } from "express";
import { postLead } from "../controllers/leadsController.js";
import { rateLimit } from "../middleware/rateLimit.js";

const router = Router();

router.post("/", rateLimit("leads"), postLead);

export default router;
