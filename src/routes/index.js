import { Router } from "express";
import leadsRoutes from "./leadsRoutes.js";
import contactRoutes from "./contactRoutes.js";
import authRoutes from "./authRoutes.js";
import classRoutes from "./classRoutes.js";
import assignmentRoutes from "./assignmentRoutes.js";
import rosterRoutes from "./rosterRoutes.js";
import feedbackRoutes from "./feedbackRoutes.js";
import adminRoutes from "./adminRoutes.js";

const router = Router();

router.use("/leads", leadsRoutes);
router.use("/contact", contactRoutes);
router.use("/auth", authRoutes);
router.use("/classes", classRoutes);
router.use("/assignments", assignmentRoutes);
router.use("/roster", rosterRoutes);
router.use("/feedback", feedbackRoutes);
router.use("/admin", adminRoutes);

export default router;
