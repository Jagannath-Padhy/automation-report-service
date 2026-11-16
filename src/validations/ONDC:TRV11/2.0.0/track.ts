import { TestResult, Payload } from "../../../types/payload";
import { saveFromElement } from "../../../utils/specLoader";

export default async function track(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const result: TestResult = { response: {}, passed: [], failed: [] };
  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}
