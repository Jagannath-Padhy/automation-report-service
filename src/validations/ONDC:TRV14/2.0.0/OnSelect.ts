import { TestResult, Payload } from "../../../types/payload";
import { validateTrv14Step } from "../../shared/trv14/stepValidator";
import { saveTrv14ActionData, saveTrv14FormUrls } from "../../shared/trv14/helpers";
import { saveFromElement } from "../../../utils/specLoader";

export default async function on_select(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const result = await validateTrv14Step(element, sessionID, flowId, actionId);
  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  await saveTrv14ActionData(element, sessionID, flowId);
  await saveTrv14FormUrls(element, sessionID);
  return result;
}
