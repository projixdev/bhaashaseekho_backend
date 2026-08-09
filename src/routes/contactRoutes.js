import { Router } from "express";
import { postContact } from "../controllers/contactController.js";
import { rateLimit } from "../middleware/rateLimit.js";

const router = Router();

router.post("/", rateLimit("contact"), postContact);

export default router;
