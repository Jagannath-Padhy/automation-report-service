import { fetchPayloads, fetchSessionDetails } from "./dbService";
import { sortPayloadsByCreatedAt } from "../utils/groupUtils";
import { validationModule } from "./validationModule";
import { generateCustomHTMLReport } from "../templates/generateReport";
import { CacheService } from "./cacheService";
import logger from "@ondc/automation-logger";
import { DOMAINS_WITH_VERSION, ENABLED_DOMAINS, ENABLED_USECASES, FLOW_ID_MAP, typeMapping } from "../utils/constants";
import axios from "axios";
import { generateTestsFromPayloads, resolveUsecaseKey } from "../utils/payloadUtils";

export class ReportService {
  async generate(
    sessionId: string,
    flowIdToPayloadIdsMap: Record<string, string[]>,
    userId?: string,
    flow_summary?: Record<string, { total: number; completed: number }>
  ): Promise<any> {
    try {
      // Fetch session details first
      const sessionDetails = await fetchSessionDetails(sessionId);
      if (!sessionDetails) {
        throw new Error(`Session details not found for session: ${sessionId}`);
      }

      // Cache session details (non-blocking)
      CacheService.set(
        `sessionDetails:${sessionId}`,
        JSON.stringify(sessionDetails)
      ).catch(console.error);

      const requestedFlows = Object.keys(flowIdToPayloadIdsMap);
      const flowMap: Record<string, string> = sessionDetails?.flowMap ?? {};

      const currentStates = await this.fetchCurrentStates(
        sessionId,
        requestedFlows,
        flowMap
      );

      // Cache current states (non-blocking)
      CacheService.set(
        `flowStates:${sessionId}`,
        JSON.stringify(currentStates)
      ).catch(console.error);

      // Build payload IDs and action ID mapping in parallel
      const [payloadIdsFromStates, payloadIdToActionId] = await Promise.all([
        Promise.resolve(this.buildPayloadIdsFromStates(currentStates)),
        Promise.resolve(this.buildPayloadIdToActionId(currentStates)),
      ]);

      const payloads = await fetchPayloads(payloadIdsFromStates);
      this.annotatePayloadsWithActionId(payloads, payloadIdToActionId);
      const unfetchedActionIds = this.findUnfetchedActionIds(payloadIdsFromStates, payloads, payloadIdToActionId);

      const flows = sortPayloadsByCreatedAt(payloads);

      // Check if domain is not in enabled domains - use Pramaan report
      const rawDomainVersionKey = sessionDetails.domain === DOMAINS_WITH_VERSION.FIS13 && sessionDetails.version === DOMAINS_WITH_VERSION.FIS13_VERSION ? `${sessionDetails.domain}:${sessionDetails.version}:${sessionDetails.usecaseId}` : `${sessionDetails.domain}:${sessionDetails.version}`;
      // Usecase casing differs across session / ENABLED_DOMAINS / FLOW_ID_MAP (e.g. "Transit Insurance" vs "TRANSIT INSURANCE")
      const domainVersionKey = (ENABLED_DOMAINS.find((d) => d.toLowerCase() === rawDomainVersionKey.toLowerCase()) as string | undefined) ?? rawDomainVersionKey;

      if (!ENABLED_DOMAINS.includes(domainVersionKey)) {
        return await this.checkPramaanReport(sessionDetails, sessionId, flowIdToPayloadIdsMap, userId, flow_summary);
      }

      // Check usecase-level enabling
      // If domain:version has specific usecases configured, verify the current usecase is allowed
      const allowedUsecases = ENABLED_USECASES[domainVersionKey];
      if (allowedUsecases && allowedUsecases.length > 0) {
        const currentUsecase = sessionDetails.usecaseId?.toLowerCase();
        if (!currentUsecase || !allowedUsecases.includes(currentUsecase)) {
          logger.info(`Usecase '${currentUsecase}' not enabled for ${domainVersionKey}, using Pramaan`);
          return await this.checkPramaanReport(sessionDetails, sessionId, flowIdToPayloadIdsMap, userId, flow_summary);
        }
      }

      const htmlReport = generateCustomHTMLReport(
        await validationModule(flows, sessionId, undefined, unfetchedActionIds),
        sessionId,
        flowMap
      );
      logger.info("flow map result", JSON.stringify(htmlReport.flowResults))
      this.saveReportToDB(sessionId, htmlReport.html, userId, flow_summary, htmlReport.flowResults);
      return htmlReport;
    } catch (error) {
      logger.error(
        `Error generating report for session ${sessionId}:`,
        {},
        error
      );
      throw new Error(
        `Failed to generate report: ${error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }

  /**
   * Checks Pramaan report when domain is not specified or not in enabled domains
   * @param sessionDetails - Session details object containing sessionId, domain, version, etc.
   * @returns Pramaan response data or error object
   */
  private async checkPramaanReport(
    sessionDetails: any,
    sessionId: string,
    flowIdToPayloadIdsMap: Record<string, string[]>,
    _userId?: string,
    flow_summary?: Record<string, { total: number; completed: number }>
  ): Promise<any> {
    const testId = `PW_${sessionId}`;
    logger.info(`Generating Pramaan Flow summary:`, flow_summary);
    // Cache flow_summary so pramaanCallbackController can retrieve it when callback arrives
    if (flow_summary && Object.keys(flow_summary).length > 0) {
      CacheService.set(
        `flow_summary:${testId}`,
        JSON.stringify(flow_summary)
      ).catch((err) =>
        logger.error(`Failed to cache flow_summary for testId: ${testId}`, {}, err)
      );
    }

    const { tests, subscriber_id } = await generateTestsFromPayloads(
      sessionDetails.domain,
      sessionDetails.version,
      sessionDetails.usecaseId,
      sessionId,
      flowIdToPayloadIdsMap
    );

    logger.info(
      `[ReportService] Checking Pramaan report for sessionId: ${sessionDetails.sessionId},usecaseId: ${sessionDetails.usecaseId}, generated testId: ${testId}`
    );

    // Build request body for Pramaan
    const mappedType = typeMapping[sessionDetails.usecaseId] ?? typeMapping[resolveUsecaseKey(typeMapping, sessionDetails.usecaseId) ?? ""];
    const body = {
      id: subscriber_id,
      version: sessionDetails.version,
      domain: sessionDetails.domain || undefined, // Handle case when domain is not specified
      environment: process.env.PRAMAAN_ENVIRONMENT || "Preprod",
      type: mappedType,
      tests,
      test_id: testId,
    };
    // const pramaanUrl = `${process.env.PRAMAAN_URL}/preprod/testing/buyer/runtest`;
    const pramaanUrl = process.env.PRAMAAN_URL;
    if (!pramaanUrl) {
      throw new Error("PRAMAAN_URL is not defined in environment variables");
    }

    logger.info(`Sending sync request to Pramaan at ${pramaanUrl},body: ${JSON.stringify(body)}`);
    const pramaanResponse = await axios.post(pramaanUrl, body, {
      headers: { "Content-Type": "application/json" },
    });

    logger.info(
      `Received response from Pramaan: ${JSON.stringify(pramaanResponse.data)}`
    );

    // Extract ack status safely
    const ackStatus = pramaanResponse.data?.message?.ack?.status;

    if (ackStatus === "NACK") {
      logger.warning(`Pramaan responded with NACK for testId: ${testId}`);
      return {
        error: "Pramaan responded with NACK",
        response: pramaanResponse.data,
      } as any;
    }

    if (ackStatus === "ACK") {
      logger.info(`Pramaan responded with ACK for testId: ${testId}`);
      return pramaanResponse.data as any;
    }

    // Unexpected structure
    logger.error(`Unexpected Pramaan response format for testId: ${testId}`);
    return {
      error: "Unexpected response format from Pramaan",
      response: pramaanResponse.data,
    } as any;
  }

  async fetchCurrentStates(
    sessionId: string,
    flowNames: string[],
    flowMap: Record<string, string>
  ): Promise<Record<string, any>> {
    try {
      const entries = await Promise.all(
        flowNames.map(async (flowName) => {
          const txnId = flowMap[flowName];
          if (!txnId) {
            logger.warning(`No transaction ID found for flow: ${flowName}`);
            return [flowName, null] as const;
          }

          try {
            const { data } = await axios.get(
              `${process.env.AUTOMATION_BACKEND}/flow/current-state`,
              {
                params: { transaction_id: txnId, session_id: sessionId },
              }
            );
            return [flowName, data] as const;
          } catch (error) {
            if (axios.isAxiosError(error)) {
              logger.error(
                `Failed to fetch current state for flow ${flowName}:`,
                error.message
              );

              // Axios-specific details
              logger.error("Status:", error.response?.status);
              logger.error("Response:", error.response?.data);
            } else {
              logger.error(
                `Failed to fetch current state for flow ${flowName}:`,
                error instanceof Error ? error.message : error
              );
            }

            return [flowName, null] as const;
          }
        })
      );
      return Object.fromEntries(entries);
    } catch (error) {
      logger.error("Error in fetchCurrentStates:", error);
      throw new Error(
        `Failed to fetch current states for session ${sessionId}`
      );
    }
  }

  buildPayloadIdsFromStates(
    currentStates: Record<string, any>
  ): Record<string, string[]> {
    return Object.fromEntries(
      Object.entries(currentStates).map(([flowName, state]: [string, any]) => {
        const ids: string[] = (state?.sequence ?? []).flatMap((step: any) =>
          (step?.payloads?.payloads ?? [])
            .map((p: any) => p?.payloadId)
            .filter(Boolean)
        );
        return [flowName, ids];
      })
    );
  }

  buildPayloadIdToActionId(
    currentStates: Record<string, any>
  ): Map<string, string> {
    const map = new Map<string, string>();
    Object.values(currentStates).forEach((state: any) => {
      (state?.sequence ?? []).forEach((step: any) => {
        const actionId: string | undefined = step?.actionId;
        (step?.payloads?.payloads ?? []).forEach((p: any) => {
          const pid = p?.payloadId;
          if (pid && actionId) map.set(pid, actionId);
        });
      });
    });
    return map;
  }

  /**
   * Per flow, the action_ids whose payloads the workbench flow state lists but the
   * payload DB did not return — the step ran, its payload just can't be read, so
   * the report can say that instead of "mandatory step missing".
   */
  findUnfetchedActionIds(
    requested: Record<string, string[]>,
    fetched: Record<string, any[]>,
    payloadIdToActionId: Map<string, string>
  ): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [flowId, ids] of Object.entries(requested)) {
      const got = new Set((fetched[flowId] ?? []).map((p: any) => p?.payloadId));
      const missing = ids
        .filter((id) => !got.has(id))
        .map((id) => payloadIdToActionId.get(id))
        .filter((a): a is string => !!a);
      if (missing.length > 0) result[flowId] = Array.from(new Set(missing));
    }
    return result;
  }

  annotatePayloadsWithActionId(
    payloads: Record<string, any[]>,
    payloadIdToActionId: Map<string, string>
  ): void {
    Object.values(payloads).forEach((arr) => {
      arr.forEach((p) => {
        const actionId = payloadIdToActionId.get(p.payloadId);
        if (actionId) p.action_id = actionId;
      });
    });
  }

  private saveReportToDB(
    sessionId: string,
    html: string,
    userId?: string,
    flow_summary?: Record<string, { total: number; completed: number }>,
    flowResults?: Record<string, "PASS" | "FAIL">
  ): void {
    const testId = `PW_${sessionId}`;
    logger.info("Saving report to DB for testId:", { testId });
    const reportUrl = `${process.env.DATA_BASE_URL}/report/${testId}`;
    const base64Report = `data:text/html;base64,${Buffer.from(html).toString("base64")}`;

    const total_tests = flow_summary
      ? Object.values(flow_summary).reduce((sum, f) => sum + f.total, 0)
      : undefined;
    const passed_tests = flow_summary
      ? Object.values(flow_summary).reduce((sum, f) => sum + f.completed, 0)
      : undefined;

    // 1. Save HTML report
    axios
      .post(
        reportUrl,
        {
          data: base64Report,
          ...(flow_summary && { flow_summary }),
          ...(total_tests !== undefined && { total_tests }),
          ...(passed_tests !== undefined && { passed_tests }),
        },
        {
          headers: { "Content-Type": "application/json", "x-api-key": process.env.API_SERVICE_KEY }, params: {
            ...(userId && { userId }),
          }
        }
      )
      .then((res) => logger.info(`Report saved to DB for testId: ${testId}`, res.data))
      .catch((err) => logger.error(`Failed to save report to DB for testId: ${testId}`, {}, err));

    // 2. Save flowSummary + flowMap (pass/fail per flow) to automation-db
    if (flowResults && Object.keys(flowResults).length > 0) {
      const analyticsUrl = `${process.env.DATA_BASE_URL}/api/sessions/${sessionId}/analytics`;
      axios
        .post(
          analyticsUrl,
          { flowSummary: flow_summary, flowMap: flowResults },
          { headers: { "Content-Type": "application/json", "x-api-key": process.env.API_SERVICE_KEY } }
        )
        .then(() => logger.info(`Analytics saved for sessionId: ${sessionId}`))
        .catch((err) => logger.error(`Failed to save analytics for sessionId: ${sessionId}`, {}, err));
    }
  }
}