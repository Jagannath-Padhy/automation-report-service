import { TestResult, Payload } from "../../../types/payload";
import { validateRet10OnInit } from "../../shared/retail/ret10InitConfirmValidations";
import { saveFromElement } from "../../../utils/specLoader";

export default async function on_init(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const result = await validateRet10OnInit(element, sessionID, flowId, actionId);
  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}
