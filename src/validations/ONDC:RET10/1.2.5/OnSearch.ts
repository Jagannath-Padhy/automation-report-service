import { TestResult, Payload } from "../../../types/payload";
import { validateRet10OnSearch } from "../../shared/retail/ret10SearchValidations";
import { saveFromElement } from "../../../utils/specLoader";

export default async function on_search(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const result = await validateRet10OnSearch(element, sessionID, flowId, actionId);
  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}
