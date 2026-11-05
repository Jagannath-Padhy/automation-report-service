import { TestResult, Payload } from "../../../types/payload";
import { validateRet11OnSearch } from "../../shared/retail/ret11SearchValidations";
import { saveFromElement } from "../../../utils/specLoader";

export default async function on_search(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const result = await validateRet11OnSearch(element, sessionID, flowId, actionId);
  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}
