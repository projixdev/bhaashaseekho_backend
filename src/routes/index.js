import { Router } from "express";
import leadsRoutes from "./leadsRoutes.js";
import contactRoutes from "./contactRoutes.js";

const router = Router();

router.use("/leads", leadsRoutes);
router.use("/contact", contactRoutes);

export default router;
