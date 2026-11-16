import { TestResult, Payload } from "../../../types/payload";
import { saveFromElement } from "../../../utils/specLoader";
import { validateIgm1OnIssue } from "../../shared/igmValidations";

export default async function on_issue(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const message = element?.jsonRequest?.message;
  const result: TestResult = { response: {}, passed: [], failed: [] };
  validateIgm1OnIssue(message, result);
  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}
