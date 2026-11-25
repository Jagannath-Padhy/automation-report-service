import { TestResult, Payload } from "../../../types/payload";
import { saveFromElement } from "../../../utils/specLoader";
import { validateIgm1IssueStatus } from "../../shared/igmValidations";

export default async function issue_status(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const message = element?.jsonRequest?.message;
  const result: TestResult = { response: {}, passed: [], failed: [] };
  validateIgm1IssueStatus(message, result);
  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}
