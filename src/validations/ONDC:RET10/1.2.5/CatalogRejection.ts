import { TestResult, Payload } from "../../../types/payload";
import { validateRet10CatalogRejection } from "../../shared/retail/ret10CatalogRejectionValidations";
import { saveFromElement } from "../../../utils/specLoader";

export default async function catalog_rejection(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const result = await validateRet10CatalogRejection(element, sessionID, flowId, actionId);
  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}
