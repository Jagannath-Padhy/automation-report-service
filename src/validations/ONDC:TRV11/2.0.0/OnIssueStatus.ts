import { TestResult, Payload } from "../../../types/payload";
import { saveFromElement } from "../../../utils/specLoader";
import { validateIgm1OnIssueStatus } from "../../shared/igmValidations";

export default async function on_issue_status(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const message = element?.jsonRequest?.message;
  const result: TestResult = { response: {}, passed: [], failed: [] };
  validateIgm1OnIssueStatus(message, result);
  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}
