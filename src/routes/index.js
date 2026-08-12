import { Router } from "express";
import leadsRoutes from "./leadsRoutes.js";
import contactRoutes from "./contactRoutes.js";
import authRoutes from "./authRoutes.js";
import classRoutes from "./classRoutes.js";
import assignmentRoutes from "./assignmentRoutes.js";

const router = Router();

router.use("/leads", leadsRoutes);
router.use("/contact", contactRoutes);
router.use("/auth", authRoutes);
router.use("/classes", classRoutes);
router.use("/assignments", assignmentRoutes);

export default router;
