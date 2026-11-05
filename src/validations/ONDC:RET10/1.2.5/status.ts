import { TestResult, Payload } from "../../../types/payload";
import { validateRet10Status } from "../../shared/retail/ret10StatusValidations";
import { saveFromElement } from "../../../utils/specLoader";

export default async function status(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const result = await validateRet10Status(element, sessionID, flowId, actionId);
  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}
