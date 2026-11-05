import { TestResult, Payload } from "../../../types/payload";
import { validateRet10OnConfirm } from "../../shared/retail/ret10InitConfirmValidations";
import { saveFromElement } from "../../../utils/specLoader";

export default async function on_confirm(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const result = await validateRet10OnConfirm(element, sessionID, flowId, actionId);
  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}
