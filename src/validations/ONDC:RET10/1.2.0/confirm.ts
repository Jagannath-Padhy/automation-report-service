import { TestResult, Payload } from "../../../types/payload";
import { validateRet10Confirm } from "../../shared/retail/ret10InitConfirmValidations";
import { saveFromElement } from "../../../utils/specLoader";

export default async function confirm(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const result = await validateRet10Confirm(element, sessionID, flowId, actionId);
  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}
