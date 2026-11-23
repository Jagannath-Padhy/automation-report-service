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
  // Initialize result directly
  const result: TestResult = { response: element?.jsonResponse?.response || {}, passed: [], failed: [] };
  
  // Validate - same logic for both versions
  validateIgm1IssueStatus(message, result);
  
  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}
