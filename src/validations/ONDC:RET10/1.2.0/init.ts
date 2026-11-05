import { TestResult, Payload } from "../../../types/payload";
import { validateRet10Init } from "../../shared/retail/ret10InitConfirmValidations";
import { saveFromElement } from "../../../utils/specLoader";

export default async function init(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const result = await validateRet10Init(element, sessionID, flowId, actionId);
  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}
