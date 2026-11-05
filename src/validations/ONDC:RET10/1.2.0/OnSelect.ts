import { TestResult, Payload } from "../../../types/payload";
import { validateRet10OnSelect } from "../../shared/retail/ret10SelectValidations";
import { saveFromElement } from "../../../utils/specLoader";

export default async function on_select(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const result = await validateRet10OnSelect(element, sessionID, flowId, actionId);
  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}
