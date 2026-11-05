import { TestResult, Payload } from "../../../types/payload";
import { validateRet10OnStatus } from "../../shared/retail/ret10StatusValidations";
import { saveFromElement } from "../../../utils/specLoader";

export default async function on_status(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const result = await validateRet10OnStatus(element, sessionID, flowId, actionId);
  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}
