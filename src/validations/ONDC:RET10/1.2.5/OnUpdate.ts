import { TestResult, Payload } from "../../../types/payload";
import { validateRet10OnUpdate } from "../../shared/retail/ret10UpdateCancelTrackValidations";
import { saveFromElement } from "../../../utils/specLoader";

export default async function on_update(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const result = await validateRet10OnUpdate(element, sessionID, flowId, actionId);
  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}
