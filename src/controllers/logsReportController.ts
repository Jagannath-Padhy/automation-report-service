import { Request, Response } from "express";
import logger from "@ondc/automation-logger";
import { generateReportFromLogs } from "../services/logsReportService";
import { LogsInputError } from "../utils/logsAdapter";
import { apiResponse } from "../utils/responseHandler";

// POST /logs-report — multipart form: `flow_id` (required), `usecase_id` (optional),
// `file` (the downloaded logs .json). Responds with the HTML report as a download.
export async function logsReportController(req: Request, res: Response): Promise<void> {
  const flowId = (req.body?.flow_id as string | undefined)?.trim();
  const usecaseId = (req.body?.usecase_id as string | undefined)?.trim() || undefined;

  if (!flowId) {
    apiResponse.badRequest(res, "flow_id is required.");
    return;
  }
  if (!req.file) {
    apiResponse.badRequest(res, "file is required (multipart field 'file' with the logs JSON).");
    return;
  }

  let rawLogs: unknown;
  try {
    rawLogs = JSON.parse(req.file.buffer.toString("utf8"));
  } catch (err: any) {
    apiResponse.badRequest(res, `file is not valid JSON: ${err?.message}`);
    return;
  }

  try {
    const { html, transactionId } = await generateReportFromLogs(flowId, rawLogs, usecaseId);
    const fileName = `${flowId}_${transactionId}_report.html`.replace(/[^\w.()-]+/g, "_");
    res
      .status(200)
      .set({
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fileName}"`,
      })
      .send(html);
  } catch (err: any) {
    if (err instanceof LogsInputError) {
      apiResponse.badRequest(res, err.message);
      return;
    }
    logger.error("Failed to generate report from uploaded logs", { error: err, flowId });
    apiResponse.internalError(res, "Failed to generate report from logs", err);
  }
}
