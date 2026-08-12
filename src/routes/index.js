import { Router } from "express";
import leadsRoutes from "./leadsRoutes.js";
import contactRoutes from "./contactRoutes.js";
import authRoutes from "./authRoutes.js";

const router = Router();

router.use("/leads", leadsRoutes);
router.use("/contact", contactRoutes);
router.use("/auth", authRoutes);

export default router;
