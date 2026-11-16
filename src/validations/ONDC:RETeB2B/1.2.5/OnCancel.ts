import { TestResult, Payload } from "../../../types/payload";
import { saveFromElement } from "../../../utils/specLoader";
import { getActionData } from "../../../services/actionDataService";
import { validateOrderState, compareOrderIdContinuity, validateQuoteAmountSigns } from "./commonChecks";
import { validateOnSelectFulfillmentRefs } from "./selectChecks";
import { validateAdjustmentArithmetic, asArray } from "./returnChecks";
import { validatePaymentParamsEcho, validateCreatedAtNotBeforeOrder } from "./orderFormationChecks";
import {
  validateCancelledFulfillmentStates,
  validateCancellationAttribution,
  validatePrecancelState,
  validateRtoInitiation,
  validateCancelFulfillmentIdContinuity,
} from "./rtoChecks";

// Two on_cancel shapes reach this validator:
//   - Buyer_Side_Order_Cancellation `on_cancel` — the seller's answer to the buyer's /cancel;
//   - Merchant_Side_RTO... `on_cancel_rto` — the seller's UNSOLICITED cancellation after a
//     failed delivery, which raises an `RTO` fulfillment. (This file used to say the RTO flow
//     "routes through on_update/on_status, not on_cancel" — it does not; on_cancel_rto is that
//     flow's 13th leg.)
// The rules and their contract basis are in rtoChecks.ts; calibration and the
// deliberate non-checks are in docs/RETeB2B-merchant-rto-part-cancel-verification.md.
export default async function on_cancel(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const testResults: TestResult = {
    response: {},
    passed: [],
    failed: [],
  };

  // Note: deliberately NOT using the shared createOnCancelValidator() factory here —
  // its unconditional validateCancellation() check validates order.status against
  // mobility-style values (SOFT_CANCEL/CANCELLED), but ONDC retail uses order.state
  // (title-case "Cancelled"), so it would push a guaranteed false-positive failure.
  const { jsonRequest, jsonResponse } = element;
  if (jsonResponse?.response) testResults.response = jsonResponse.response;

  const context = jsonRequest?.context;
  const message = jsonRequest?.message;
  const order = message?.order;
  const label = actionId && actionId !== "on_cancel" ? `on_cancel (${actionId})` : "on_cancel";

  try {
    if (order?.state) {
      validateOrderState(order, testResults, ["Cancelled"], label);
    }
    if (order?.cancellation) {
      testResults.passed.push(`${label}: cancellation details present`);
    }

    validateCancelledFulfillmentStates(order, label, testResults);
    validateCancellationAttribution(order, context, label, testResults);
    validateRtoInitiation(order, actionId, label, testResults);
    validateOnSelectFulfillmentRefs(order, testResults, label);
    // S8: only discount/offer lines may be negative. The sum check (validateQuoteBreakup) is
    // deliberately NOT applied after confirm; the sign rule holds on every leg that quotes.
    if (order?.quote) validateQuoteAmountSigns(order.quote, testResults, label);

    const txnId = context?.transaction_id as string | undefined;
    if (txnId) {
      const confirmData = await getActionData(sessionID, flowId, txnId, "confirm");
      compareOrderIdContinuity(order?.id, confirmData?.order_id, label, testResults);
      // Cancel and RTO fulfillments book their quantity and money exactly like a return:
      // quote_trail = -(moved qty x unit price), quote = confirmed total + sum(quote_trail).
      validateAdjustmentArithmetic(order, confirmData, label, testResults);
      validatePaymentParamsEcho(order, confirmData?.payments, label, testResults);
      validateCreatedAtNotBeforeOrder(order, confirmData, label, testResults);

      // precancel_state must record the state the seller last reported: the previous on_status
      // (state AND updated_at), else on_confirm (state only — see validatePrecancelState).
      const priorStatus = await getActionData(sessionID, flowId, txnId, "on_status");
      const onConfirmData = await getActionData(sessionID, flowId, txnId, "on_confirm");
      const prior = priorStatus?.delivery_state !== undefined
        ? { state: priorStatus.delivery_state, updatedAt: priorStatus.updated_at, source: "previous on_status" }
        : onConfirmData?.delivery_state !== undefined
          ? { state: onConfirmData.delivery_state, source: "on_confirm" }
          : null;
      validatePrecancelState(order, prior, label, testResults);
      // Vistar V16/V17: the Delivery keeps its confirmed id; Cancel/RTO ids are new.
      validateCancelFulfillmentIdContinuity(order, asArray(onConfirmData?.fulfillment_ids), label, testResults);
    }
  } catch (_) {}

  if (testResults.passed.length < 1 && testResults.failed.length < 1) {
    testResults.passed.push("Validated on_cancel");
  }

  // Persisted via the `on_cancel` save-spec so later legs can hold cancelled fulfillments
  // to staying Cancelled (rtoChecks.validateNoCancelledFulfillmentRevived).
  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return testResults;
}
