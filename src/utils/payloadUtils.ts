import axios from "axios";
import { FLOW_ID_MAP } from "./constants";
import logger from "@ondc/automation-logger";
export interface TestItem {
  flow_id: string;
  transaction_id: string;
}

const normalizeUsecaseKey = (value: string) =>
  value.toLowerCase().replace(/[-_\s]+/g, " ").trim();

// Usecases renamed in automation-specifications. Maps the normalized legacy name to the
// normalized current name so sessions created before the rename still resolve.
const LEGACY_USECASE_ALIASES: Record<string, string> = {
  "unified credit": "business loan",
};

// Session usecaseIds can arrive as slugs ("transit-insurance") or in a different case,
// while FLOW_ID_MAP is keyed by display name ("TRANSIT INSURANCE").
export function resolveUsecaseKey(
  usecases: Record<string, unknown> | undefined,
  usecaseId: string
): string | undefined {
  if (!usecases || !usecaseId) return undefined;
  if (usecases[usecaseId]) return usecaseId;
  const normalized = normalizeUsecaseKey(usecaseId);
  const target = LEGACY_USECASE_ALIASES[normalized] ?? normalized;
  return Object.keys(usecases).find((k) => normalizeUsecaseKey(k) === target);
}

export async function generateTestsFromPayloads(
  domain: string,
  version: string,
  usecaseId: string,
  sessionId: string,
  flowIdToPayloadIdsMap: Record<string, string[]>
): Promise<{
  tests: TestItem[];
  subscriber_id: string;
}> {
  const resolvedUsecaseId = resolveUsecaseKey(
    FLOW_ID_MAP[domain]?.[version],
    usecaseId
  );
  if (!resolvedUsecaseId) {
    logger.error(`Cannot find FLOW_ID_MAP configuration`, {
      domain,
      version,
      usecaseId,
      availableDomains: Object.keys(FLOW_ID_MAP),
      availableVersions: FLOW_ID_MAP[domain] ? Object.keys(FLOW_ID_MAP[domain]) : [],
      availableUsecases: FLOW_ID_MAP[domain]?.[version] ? Object.keys(FLOW_ID_MAP[domain][version]) : []
    });
    throw new Error("Cannot generate pramaan flows for this configuration");
  }
  usecaseId = resolvedUsecaseId;
  const flowMappings = FLOW_ID_MAP[domain][version][usecaseId];
  const flowMap: Record<string, TestItem & { timestamp: string }> = {};
  const payloadIds = Object.values(flowIdToPayloadIdsMap).flat();
  const pramaanFlowIds = Object.keys(FLOW_ID_MAP[domain][version][usecaseId]);
  const response = await axios.get(
    `${process.env.DATA_BASE_URL}/api/sessions/payload/${sessionId}`,
    {
      headers: {
        "x-api-key": process.env.API_SERVICE_KEY,
      },
    }
  );

  const payloads = response.data;
  // let category_id = ""
  // if (domain === "nic2004:60232") {
  //   const searchJsonRequest = payloads.find(
  //     (item: any) => item.payload?.action === "SEARCH"
  //   )?.payload?.jsonRequest;

  //   console.log("searchJsonRequest", JSON.stringify(searchJsonRequest));

  //   category_id = searchJsonRequest?.message?.intent?.category?.id || "Immediate Delivery"
  // }
  // console.log("payloads in report service", JSON.stringify(payloads));

  if (!payloads.length) {
    return { tests: [], subscriber_id: "" };
  }

  // const flowMappings = FLOW_ID_MAP[domain][version][usecaseId];
  // const flowMap: Record<string, TestItem & { timestamp: string }> = {};
  // const payloadIds = Object.values(flowIdToPayloadIdsMap).flat();
  // const pramaanFlowIds = Object.keys(FLOW_ID_MAP[domain][version][usecaseId]);

  // Determine subscriber_id (consistent across payloads)
  const npType = payloads[0].npType;
  let subscriber_id = "";

  for (const entry of payloads) {
    const payload = entry.payload;
    if (!payloadIds.includes(payload.payloadId)) {
      continue;
    }
    if (!pramaanFlowIds.includes(payload.flowId)) {
      continue;
    }
    if (!subscriber_id) {
      if (npType === "BPP" && payload.bppId) {
        subscriber_id = payload.bppId;
      } else if (npType === "BAP" && payload.bapId) {
        subscriber_id = payload.bapId;
      }
    }

    // let mappedFlowId = flowMappings[payload.flowId];
    const mappedFlowId = flowMappings[payload.flowId];
    logger.info("Mapped Flow ID is", { flowId: mappedFlowId });
    // if (
    //   domain === "nic2004:60232" &&
    //   version === "1.2.0" &&
    //   payload.flowId === "ORDER_FLOW_BASELINE"
    // ) {
    //   mappedFlowId =
    //     NIC_LOGISTICS_CATEGORY_FLOW_MAP[category_id] ??
    //     "B2C_1A";
    // }
    if (!mappedFlowId) {
      throw new Error(
        `No flowId mapping found for ${payload.flowId} under ${domain} → ${version} → ${usecaseId}`
      );
    }
    const transactionId = payload.transactionId;
    const timestamp = payload.jsonRequest?.context?.timestamp;

    if (!timestamp) continue;

    if (
      !flowMap[mappedFlowId] ||
      new Date(timestamp) > new Date(flowMap[mappedFlowId].timestamp)
    ) {
      flowMap[mappedFlowId] = {
        flow_id: mappedFlowId,
        transaction_id: transactionId,
        timestamp,
      };
    }
  }

  const tests = Object.values(flowMap).map(({ flow_id, transaction_id }) => ({
    flow_id,
    transaction_id,
  }));

  return { tests, subscriber_id };
}

export function mapPayloadsToLogFormat(payloads: any): any[] {
  // Normalize to array
  let normalizedPayloads: any[] = [];

  if (Array.isArray(payloads)) {
    normalizedPayloads = payloads;
  } else if (payloads && Array.isArray(payloads.payloads)) {
    normalizedPayloads = payloads.payloads;
  } else if (payloads && typeof payloads === "object") {
    // Handle case where payloads might be an object of arrays (e.g. { flowA: [...], flowB: [...] })
    normalizedPayloads = Object.values(payloads).flatMap((v) =>
      Array.isArray(v) ? v : []
    );
    // If still empty, maybe it’s a single payload object
    if (normalizedPayloads.length === 0) normalizedPayloads = [payloads];
  }

  return normalizedPayloads.map((p) => ({
    request: p.jsonRequest ?? undefined,
    response: p.jsonResponse.response ?? undefined,
    action: p.action ? String(p.action).toLowerCase() : "",
    transaction_id: p.transactionId ?? undefined,
    message_id: p.messageId ?? undefined,
    created_at: p.createdAt ?? new Date(),
    updated_at: p.updatedAt ?? new Date(),
  }));
}
