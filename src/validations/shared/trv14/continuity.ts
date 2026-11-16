import { Payload, TestResult } from "../../../types/payload";
import { fetchFlowData, saveFlowData } from "../../../utils/redisUtils";
import { Trv14FlowProfile } from "./flowProfiles";

// ISO-8601 duration, e.g. PT30S, P1D, PT1H30M.
const ISO_DURATION_RE = /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/;

const lastRequestKey = (api: string) => `trv14_last_request_${api}`;
const FLOW_CITY_KEY = "trv14_flow_city";
const REQUEST_IDS_KEY = "trv14_request_message_ids";

/**
 * TRV14 cross-call checks the shared flowContinuityValidators don't cover
 * (those already check timestamp order and BAP/BPP id+uri stability):
 * - a solicited on_* reuses the message_id of the request it answers; a step the
 *   workbench marks unsolicited carries a new one; every request has its own;
 * - context.ttl is an ISO-8601 duration;
 * - context.location.city.code stays the same through the flow.
 * Calls are validated in flow order, so each request is saved before its response.
 */
export async function checkTrv14Continuity(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string,
  profile: Trv14FlowProfile,
  testResults: TestResult
): Promise<void> {
  const context = element?.jsonRequest?.context;
  const action: string | undefined = context?.action;
  const txnId: string | undefined = context?.transaction_id;
  if (!context || !action || !txnId) return;

  if (context.ttl !== undefined) {
    if (typeof context.ttl === "string" && ISO_DURATION_RE.test(context.ttl)) {
      testResults.passed.push(`${action}: context.ttl '${context.ttl}' is an ISO-8601 duration`);
    } else {
      testResults.failed.push(`${action}: context.ttl must be an ISO-8601 duration, found '${context.ttl}'`);
    }
  }

  const city = context?.location?.city?.code;
  if (city) {
    const flowCity = await fetchFlowData(sessionID, flowId, txnId, FLOW_CITY_KEY);
    if (!flowCity?.code) {
      await saveFlowData(sessionID, flowId, txnId, FLOW_CITY_KEY, { code: city });
    } else if (flowCity.code === city) {
      testResults.passed.push(`${action}: context.location.city.code matches the flow's first call`);
    } else {
      testResults.failed.push(
        `${action}: context.location.city.code '${city}' differs from the flow's first call '${flowCity.code}'`
      );
    }
  }

  if (!action.startsWith("on_")) {
    const seen = await fetchFlowData(sessionID, flowId, txnId, REQUEST_IDS_KEY);
    const ids: string[] = seen?.ids ?? [];
    if (ids.includes(context.message_id)) {
      testResults.failed.push(`${action} (${actionId}): message_id '${context.message_id}' was already used by an earlier request in this flow`);
    } else {
      testResults.passed.push(`${action} (${actionId}): new request carries a new message_id`);
      await saveFlowData(sessionID, flowId, txnId, REQUEST_IDS_KEY, { ids: [...ids, context.message_id] });
    }
    await saveFlowData(sessionID, flowId, txnId, lastRequestKey(action), {
      message_id: context.message_id,
      action_id: actionId,
    });
    return;
  }

  const request = await fetchFlowData(sessionID, flowId, txnId, lastRequestKey(action.slice(3)));
  const unsolicited = profile.unsolicited.includes(actionId);
  if (unsolicited) {
    if (request?.message_id && request.message_id === context.message_id) {
      testResults.failed.push(
        `${action} (${actionId}): an unsolicited call must carry a new message_id, found the ${action.slice(3)} request's '${context.message_id}'`
      );
    } else {
      testResults.passed.push(`${action} (${actionId}): unsolicited call carries its own message_id`);
    }
    return;
  }
  if (!request?.message_id) {
    testResults.failed.push(`${action} (${actionId}): no preceding ${action.slice(3)} request found in this flow`);
  } else if (request.message_id === context.message_id) {
    testResults.passed.push(`${action} (${actionId}): message_id matches the ${request.action_id} request`);
  } else {
    testResults.failed.push(
      `${action} (${actionId}): message_id '${context.message_id}' must match the ${request.action_id} request's '${request.message_id}'`
    );
  }
}
