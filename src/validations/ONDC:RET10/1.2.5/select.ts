import { TestResult, Payload } from "../../../types/payload";
import { validateRet10Select } from "../../shared/retail/ret10SelectValidations";
import { saveFromElement } from "../../../utils/specLoader";

export default async function select(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const result = await validateRet10Select(element, sessionID, flowId, actionId);
  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}
