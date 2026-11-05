import { TestResult, Payload } from "../../../types/payload";
import { saveFromElement } from "../../../utils/specLoader";
import { 
  detectIgmVersion, 
  validateIgm1Issue, 
  validateIgm2Issue 
} from "../../shared/igmValidations";

export default async function issue(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const message = element?.jsonRequest?.message;
  
  // Detect IGM version using comprehensive multi-field check
  const igmVersion = detectIgmVersion(message);
  
  // Initialize result
  const result: TestResult = { response: {}, passed: [], failed: [] };
  
  if (igmVersion === '1.0.0') {
    validateIgm1Issue(message, result);
  } else {
    validateIgm2Issue(message, result);
  }
  
  // Add marker to confirm which validator ran
  if (result.passed.length === 0 && result.failed.length === 0) {
    result.passed.push(`IGM ${igmVersion} issue validation executed`);
  }
  
  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}
