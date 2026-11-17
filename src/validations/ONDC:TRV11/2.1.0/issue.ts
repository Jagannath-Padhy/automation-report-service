import { TestResult, Payload } from "../../../types/payload";
import { validateIgm1Issue } from "../../shared/igm/igm1";

export default async function issue(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const result: TestResult = {
    response: element?.jsonResponse?.response || {},
    passed: [],
    failed: []
  };

  try {
    const message = element?.jsonRequest?.message;
    
    if (!message) {
      return result;
    }

    // Call shared IGM 1.0.0 validator
    validateIgm1Issue(message, result);
  } catch (error) {
    result.failed.push(`IGM issue validation error: ${error}`);
  }

  return result;
}
