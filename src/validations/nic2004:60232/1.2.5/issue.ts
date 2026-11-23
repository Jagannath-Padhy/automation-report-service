import { TestResult, Payload } from "../../../types/payload";
import { validateIgm1Issue } from "../../shared/igm/igm1";

export default async function issue(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  // Populate `response` from the real recorded sync-ack envelope — leaving
  // it as {} makes the report template's ack-status lookup always miss and
  // fall back to its "invalid response" placeholder, regardless of whether
  // a real ACK/NACK was received (same bug fixed earlier for RET10's IGM
  // files; TRV11's copy of this pattern still has it).
  const result: TestResult = {
    response: element?.jsonResponse?.response || {},
    passed: [],
    failed: [],
  };

  try {
    const message = element?.jsonRequest?.message;

    if (!message) {
      return result;
    }

    validateIgm1Issue(message, result);
  } catch (error) {
    result.failed.push(`IGM issue validation error: ${error}`);
  }

  return result;
}
