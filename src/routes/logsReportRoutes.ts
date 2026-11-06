import { Router } from "express";
import multer from "multer";
import { logsReportController } from "../controllers/logsReportController";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 75 * 1024 * 1024 } });

router.post("/", upload.single("file"), logsReportController);

export default router;
