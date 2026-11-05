import { TestResult, Payload } from "../../../types/payload";
import { saveFromElement } from "../../../utils/specLoader";
import { validateIgm1IssueStatus, validateIgm2IssueStatus } from "../../shared/igmValidations";

export default async function issue_status(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const message = element?.jsonRequest?.message;
  
  // issue_status has identical payload for both versions (just issue_id)
  // Initialize result directly. Populate `response` from the real recorded
  // sync-ack envelope — left as {} here before, which made the report
  // template's ack-status badge always fall back to "invalid response".
  const result: TestResult = { response: element?.jsonResponse?.response || {}, passed: [], failed: [] };
  
  // Validate - same logic for both versions
  validateIgm1IssueStatus(message, result);
  
  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}
