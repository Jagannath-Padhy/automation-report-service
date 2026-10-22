import { TestResult, Payload } from "../../../types/payload";
import { DomainValidators } from "../../shared/domainValidator";
import { saveFromElement } from "../../../utils/specLoader";
import { validateGpsFormat } from "./commonChecks";
import { validateOnSearchContext } from "./onSearchRetailChecks";
import {
  validateBroadcastRouting,
  validateP2PRouting,
  validateSearchCity,
  validateIntentPresence,
  validateItemCategoryExclusivity,
  validateBuyerFinderFee,
  validateIntentFulfillment,
  validateBapTerms,
  validateBapFeatures,
  validateP2PRetailerIdentification,
} from "./searchChecks";

// Discovery_flow_broadcast_search issues two search legs, disambiguated by
// action_id: search-0 is the gateway broadcast, search-1 is the follow-up P2P
// search aimed at one seller. Every other RETeB2B flow has a single
// undisambiguated search step, so the deep path and the strict action_id check
// stay scoped to this flow (same arrangement as OnSearch.ts).
const FLOW_DISCOVERY_BROADCAST = "Discovery_flow_broadcast_search";
const ACTION_ID_BROADCAST = "search-0";
const ACTION_ID_P2P = "search-1";

export default async function search(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const result = await DomainValidators.retEB2BSearch(element, sessionID, flowId, actionId);

  try {
    const context = element?.jsonRequest?.context;
    const intent = element?.jsonRequest?.message?.intent;

    if (flowId === FLOW_DISCOVERY_BROADCAST) {
      if (actionId === ACTION_ID_BROADCAST) {
        validateSearchRequest(context, intent, result);
        validateBroadcastRouting(context, result);
        validateBuyerFinderFee(intent, result);
        validateBapTerms(intent, context?.timestamp, result);
        validateBapFeatures(intent, result);
        validateItemCategoryExclusivity(intent, result);
        validateIntentFulfillment(intent, result);
      } else if (actionId === ACTION_ID_P2P) {
        validateSearchRequest(context, intent, result);
        validateP2PRouting(context, result);
        validateP2PRetailerIdentification(intent, result);
      } else {
        result.failed.push(
          `search: this call does not match a step of ${flowId} — the flow expects a broadcast search (no bpp_id/bpp_uri) followed by a search sent directly to one seller (with bpp_id/bpp_uri); check the order of calls`
        );
      }
    } else {
      validateLightSearch(intent, result);
    }
  } catch (_) {}

  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}

// Shared across both legs: context hygiene, city, intent presence.
function validateSearchRequest(context: any, intent: any, result: TestResult): void {
  validateOnSearchContext(context, result);
  validateSearchCity(context, result);
  validateIntentPresence(intent, result);
}

// Preserved behaviour for the other eight RETeB2B flows.
function validateLightSearch(intent: any, result: TestResult): void {
  if (intent) {
    if (Object.keys(intent).length === 0) {
      result.failed.push("search: intent must not be empty");
    } else {
      result.passed.push("search: intent is present");
    }

    const finderFee = intent?.payment?.["@ondc/org/buyer_app_finder_fee_amount"];
    if (finderFee !== undefined) {
      const fee = parseFloat(String(finderFee));
      if (Number.isNaN(fee)) {
        result.failed.push(`search: buyer_app_finder_fee_amount '${finderFee}' is not numeric`);
      } else {
        result.passed.push(`search: buyer_app_finder_fee_amount '${finderFee}' is valid`);
      }
    }

    const gps = intent?.fulfillment?.end?.location?.gps;
    if (gps) {
      validateGpsFormat(gps, "search.intent.fulfillment.end.location", result);
    }
  }
}
