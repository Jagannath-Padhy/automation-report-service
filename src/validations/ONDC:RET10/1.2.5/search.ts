import { TestResult, Payload } from "../../../types/payload";
import { validateRet10Search } from "../../shared/retail/ret10SearchValidations";
import { saveFromElement } from "../../../utils/specLoader";

export default async function search(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const result = await validateRet10Search(element, sessionID, flowId, actionId);
  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}
