import { TestResult, Payload } from "../../../types/payload";
import { validateRet10OnTrack } from "../../shared/retail/ret10UpdateCancelTrackValidations";
import { saveFromElement } from "../../../utils/specLoader";

export default async function on_track(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const result = await validateRet10OnTrack(element, sessionID, flowId, actionId);
  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}
