import { TestResult, Payload } from "../../../types/payload";
import { validateIgm1OnIssueStatus } from "../../shared/igm/igm1";

export default async function on_issue_status(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  // See issue.ts for why response is populated from jsonResponse here.
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

    validateIgm1OnIssueStatus(message, result);
  } catch (error) {
    result.failed.push(`IGM on_issue_status validation error: ${error}`);
  }

  return result;
}
