import { randomUUID } from "crypto";
import logger from "@ondc/automation-logger";
import { validationModule } from "./validationModule";
import { generateCustomHTMLReport } from "../templates/generateReport";
import { loadConfig } from "../utils/configLoader";
import { ENABLED_DOMAINS } from "../utils/constants";
import {
  assignActionIds,
  detectDomainVersion,
  logsToPayloads,
  LogsInputError,
  parseLogsFile,
} from "../utils/logsAdapter";

/**
 * Builds the HTML report from an uploaded logs file instead of a live workbench session.
 * Same validationModule → generateCustomHTMLReport pipeline as ReportService.generate, but
 * domain/version come from the logs, the flow from the caller, and nothing is fetched from or
 * saved to the DB. Validators still use Redis as cross-call scratch space; a fresh synthetic
 * sessionId keeps each upload isolated.
 */
export async function generateReportFromLogs(
  flowId: string,
  rawLogs: unknown,
  usecaseId?: string
): Promise<{ html: string; flowResults: Record<string, "PASS" | "FAIL">; transactionId: string }> {
  const entries = parseLogsFile(rawLogs);
  const { domain, version } = detectDomainVersion(entries);

  const rawKey = `${domain}:${version}${usecaseId ? `:${usecaseId}` : ""}`;
  const enabledKey = ENABLED_DOMAINS.find(
    (d) => d.toLowerCase() === rawKey.toLowerCase() || d.toLowerCase() === `${domain}:${version}`.toLowerCase()
  );
  if (!enabledKey) {
    throw new LogsInputError(
      `${domain}:${version} has no internal validators; log upload reports are only supported for: ${ENABLED_DOMAINS.join(", ")}.`
    );
  }

  const domainConfig = loadConfig(domain, version, usecaseId);
  const sequence: string[] | undefined = domainConfig?.flows?.[flowId];
  if (!sequence) {
    const available = Object.keys(domainConfig?.flows ?? {});
    throw new LogsInputError(
      `Unknown flow_id '${flowId}' for ${domain}:${version}. Valid flows: ${available.join(", ") || "none configured"}.`
    );
  }

  const payloads = assignActionIds(
    logsToPayloads(entries, flowId),
    sequence,
    domainConfig?.flow_action_ids?.[flowId]
  );
  const transactionId = payloads[0].transactionId;
  const sessionId = `LOGS_${randomUUID()}`;

  logger.info("Generating report from uploaded logs", {
    sessionId,
    flowId,
    domain,
    version,
    transactionId,
    payloadCount: payloads.length,
  });

  const report = await validationModule({ [flowId]: payloads }, sessionId, {
    domain,
    version,
    usecaseId,
  });
  // An upload is one flow by design; "the other flows are mandatory" is session-level advice.
  delete report.finalReport.mandatoryFlows;
  const { html, flowResults } = generateCustomHTMLReport(report, sessionId, {
    [flowId]: transactionId,
  });
  return { html, flowResults, transactionId };
}
