import { Router } from "express";
import apiKeyMiddleware from "../middleware/api-key"; // Import API key middleware
import ReportRoutes from "./reportRoutes"; // Import report routes
import LogRoutes from "./logRoutes";
import CallbackRoutes from "./callbackRoutes";
import FlowDataRoutes from "./flowDataRoutes";
import LogsReportRoutes from "./logsReportRoutes";

const router = Router();

router.get("/health", (_req, res) => { res.json({ status: "ok" }); });

// Mount session and payload related routes
router.use(apiKeyMiddleware);
router.use("/generate-report", ReportRoutes);
router.use("/logs", LogRoutes);
router.use("/callback", CallbackRoutes);
router.use("/flow-data", FlowDataRoutes);
router.use("/logs-report", LogsReportRoutes);
export default router;