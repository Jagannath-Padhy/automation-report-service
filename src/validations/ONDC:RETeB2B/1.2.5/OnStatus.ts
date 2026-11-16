import { TestResult, Payload } from "../../../types/payload";
import { DomainValidators } from "../../shared/domainValidator";
import { saveFromElement } from "../../../utils/specLoader";
import { getActionData } from "../../../services/actionDataService";
import { compareOrderIdContinuity, validateQuoteAmountSigns } from "./commonChecks";
import { validateCityConsistency, validateOnSelectFulfillmentRefs } from "./selectChecks";
import {
  validateOrderTimestamps,
  resolvePaymentMode,
  validatePaymentModeLock,
  validateCodSettlementCounterparty,
  validatePaymentParamsEcho,
  validateCreatedAtNotBeforeOrder,
} from "./orderFormationChecks";
import { validateNoCancelledFulfillmentRevived } from "./rtoChecks";
import {
  isOffersFlow,
  validateOrderOffersMatchApplied,
  validateOfferLinesUnchanged,
} from "./offerChecks";
import {
  resolveStatusLeg,
  validateStatusLegStates,
  validateDeliveryFulfillmentPresent,
  validateDeliveryAgent,
  validateCodSettlementAtDelivery,
  validateFulfillmentRouting,
  validateTrackingTag,
  validateFulfillmentCustomer,
  validateFulfillmentTimeWindows,
  validateStatusProgression,
} from "./onStatusChecks";

// The eB2B flows run up to SEVEN on_status legs, all with context.action `on_status` and all
// disambiguated by `action_id` — the same shape OnSelect.ts uses to tell the out-of-stock
// rejection from the retry:
//
//   on_status_accepted -> _packed -> _agent_assigned -> _picked -> _out_for_delivery
//                      -> _order_delivered          (and _rto_delivered on the RTO flow)
//
// Each one's expected order.state and fulfillment state are fully determined by that id;
// onStatusChecks.STATUS_LEGS holds the measured contract. An unrecognised action_id makes
// every leg-specific check skip rather than fail, so a new spec leg cannot break the report.
export default async function on_status(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const result = await DomainValidators.retEB2BOnStatus(element, sessionID, flowId, actionId);

  try {
    const message = element?.jsonRequest?.message;
    const order = message?.order;
    const context = element?.jsonRequest?.context;
    const leg = resolveStatusLeg(actionId);
    const mode = resolvePaymentMode(flowId);

    // `order.updated_at` must not be stamped later than the call carrying it, and must not
    // precede `created_at`. validateStatusProgression below only compares this leg against
    // the PREVIOUS one, so without this a leg could claim a future update and pass.
    // `created_at` stays optional here — it is present on all 47 reference legs but is
    // re-stamped at each one, so it is never compared across legs (see the doc's §6).
    validateOrderTimestamps(order, context, `on_status (${actionId})`, result);
    // S8: only discount/offer lines may be negative. The sum check (validateQuoteBreakup) is
    // deliberately NOT applied after confirm; the sign rule holds on every leg that quotes.
    if (order?.quote) validateQuoteAmountSigns(order.quote, result, `on_status (${actionId})`);

    // Must come before the per-leg rules: all of them take a `length === 0` early return
    // when there is no live delivery fulfillment, so the absence would otherwise be
    // invisible rather than reported.
    validateDeliveryFulfillmentPresent(order, actionId, result, leg);

    // The core rule: this leg must report exactly the states its action_id promises.
    // Replaces the old "any of five order states / any of seven fulfillment codes" check,
    // which duplicated L1's enum and accepted `Pending` at delivery.
    validateStatusLegStates(order, leg, actionId, result);
    validateDeliveryAgent(order, leg, actionId, result);
    // COD money is collected on fulfillment: NOT-PAID before delivery, PAID at it. The mode
    // is passed so a COD flow that flips `type` to ON-ORDER mid-lifecycle is still held to
    // the pre-delivery rule — see the COD flow doc §3.2.
    validateCodSettlementAtDelivery(order, leg, actionId, result, mode);
    // Added 2026-10-13 (COD flow doc §3.2): until now the payment mode was last checked at
    // on_confirm, so an order could silently become prepaid for the whole fulfillment
    // lifecycle. Both modes are locked here; the four mode-less flows skip.
    validatePaymentModeLock(order, `on_status (${actionId})`, mode, flowId, result);
    // Added 2026-10-13 (COD flow doc §3.4): COD cash collected by the seller must be
    // settled to the seller side, not the buyer app.
    validateCodSettlementCounterparty(order, `on_status (${actionId})`, mode, result);

    validateFulfillmentRouting(order, actionId, result);
    validateTrackingTag(order, actionId, result);
    validateFulfillmentCustomer(order, actionId, result);
    validateFulfillmentTimeWindows(order, context, actionId, result);
    // Seller leg: the offers it lists must be exactly the offers its quote applies.
    if (isOffersFlow(flowId)) validateOrderOffersMatchApplied(order, `on_status (${actionId})`, result);

    const txnId = context?.transaction_id as string | undefined;
    if (txnId) {
      const confirmData = await getActionData(sessionID, flowId, txnId, "confirm");
      compareOrderIdContinuity(order?.id, confirmData?.order_id, `on_status (${actionId})`, result);

      // Post-confirm echo (orderFormationChecks "POST-CONFIRM ECHO") and the RTO rules:
      // the payment committed at confirm is echoed unchanged, created_at is never earlier than
      // the order, every items[].fulfillment_id resolves, and a fulfillment cancelled at
      // on_cancel stays Cancelled.
      validatePaymentParamsEcho(order, confirmData?.payments, `on_status (${actionId})`, result);
      validateCreatedAtNotBeforeOrder(order, confirmData, `on_status (${actionId})`, result);
      validateOnSelectFulfillmentRefs(order, result, `on_status (${actionId})`);
      const onCancelData = await getActionData(sessionID, flowId, txnId, "on_cancel");
      validateNoCancelledFulfillmentRevived(order, onCancelData, `on_status (${actionId})`, result);

      // Keyed on context.action, so this is always the IMMEDIATELY PRECEDING on_status —
      // null on the first leg, which the check treats as "nothing to compare".
      const priorStatus = await getActionData(sessionID, flowId, txnId, "on_status");
      validateStatusProgression(order, priorStatus?.updated_at, actionId, result);

      const onSearchData = await getActionData(sessionID, flowId, txnId, "on_search");
      validateCityConsistency(context, onSearchData, result, `on_status (${actionId})`);

      // The offer lines quoted at on_select must survive the whole fulfillment lifecycle.
      // The read is gated so the other flows pay no extra redis read.
      if (isOffersFlow(flowId)) {
        const onSelectData = await getActionData(sessionID, flowId, txnId, "on_select");
        validateOfferLinesUnchanged(order, onSelectData, `on_status (${actionId})`, result);
      }
    }
  } catch (_) {}

  // Persisted via the `on_status` save-spec so the NEXT on_status leg can be held to a
  // forward-moving updated_at. Before that spec existed this call was a silent no-op
  // (loadSaveSpec threw and saveFromElement swallowed it).
  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}
