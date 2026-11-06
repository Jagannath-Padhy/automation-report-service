import { TestResult, Payload } from "../../../types/payload";
import { DomainValidators } from "../../shared/domainValidator";
import { saveFromElement } from "../../../utils/specLoader";
import { getActionData } from "../../../services/actionDataService";
import { validateOrderState, compareOrderIdContinuity, validateQuoteAmountSigns } from "./commonChecks";
import {
  resolveRaisedReturnId,
  validateReturnStateProgression,
  validateReturnIdContinuity,
  validateAdjustmentArithmetic,
  validateDeliveryStaysDeliveredDuringReturn,
  asArray,
} from "./returnChecks";
import {
  validatePaymentParamsEcho,
  validateCreatedAtNotBeforeOrder,
  validateOrderStateNoRegression,
} from "./orderFormationChecks";
import { validatePartCancelPrecondition } from "./rtoChecks";
import { validateOnSelectFulfillmentRefs, validateSelectProvider } from "./selectChecks";

export default async function on_update(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const result = await DomainValidators.retEB2BOnUpdate(element, sessionID, flowId, actionId);

  try {
    const message = element?.jsonRequest?.message;
    const order = message?.order;

    // Covers both the Merchant-side RTO/part-cancellation flow's unsolicited on_update
    // and the buyer-initiated-return flow's on_update — the enum stays permissive since this
    // can land at different points of the order lifecycle.
    //
    // `Created` is in the enum (added 2026-10-11) but is no longer the whole story: since
    // 2026-10-14 validateOrderStateNoRegression below fails an on_update that moves the order
    // BACK from the state the seller last reported. The RTO reference's part cancel sends
    // `Created` straight after on_confirm's `Accepted`; contract Scenario 1 keeps `Accepted`.
    if (order?.state) {
      validateOrderState(order, result, ["Created", "Accepted", "In-progress", "Completed", "Cancelled"], "on_update");
    }

    // Pass through return/replacement tags without failing on mere presence
    if (order?.tags && Array.isArray(order.tags)) {
      result.passed.push(`on_update: order.tags present with ${order.tags.length} entries`);
    }

    // provider.id + a named descriptor: all 11 contract /on_update examples (part cancel and
    // every return state) carry descriptor {name, code, short_desc}. The RTO spec example and
    // mock for on_update_part_cancel omit it; that is an upstream defect and FAILS here.
    validateSelectProvider(order, result, `on_update (${actionId})`);
    validateDeliveryStaysDeliveredDuringReturn(order, `on_update (${actionId})`, result);
    // S8: only discount/offer lines may be negative. The sum check (validateQuoteBreakup) is
    // deliberately NOT applied after confirm; the sign rule holds on every leg that quotes.
    if (order?.quote) validateQuoteAmountSigns(order.quote, result, `on_update (${actionId})`);

    const txnId = element?.jsonRequest?.context?.transaction_id as string | undefined;
    if (txnId) {
      const confirmData = await getActionData(sessionID, flowId, txnId, "confirm");
      compareOrderIdContinuity(order?.id, confirmData?.order_id, "on_update", result);

      // Return / part-cancel reconciliation — see returnChecks.ts. Both reads happen BEFORE
      // this leg is saved, so `on_update` is the PREVIOUS on_update (null on the first).
      // `update` is update_return's data until update_settlement_trail overwrites it, after
      // which the raised return_request is recovered from the previous on_update instead.
      const label = `on_update (${actionId})`;
      const previousOnUpdate = await getActionData(sessionID, flowId, txnId, "on_update");
      const savedUpdate = await getActionData(sessionID, flowId, txnId, "update");
      // Once overwritten, the saved `update` is the buyer's refund report, not the return they
      // raised — so its id is not trusted as the anchor; the previous on_update (already held
      // to the raised id) is used instead, and the trail's id is checked by update.ts.
      const raisedFrom = savedUpdate?.update_target === "item" ? savedUpdate : previousOnUpdate;
      const raisedId = resolveRaisedReturnId(raisedFrom) ?? resolveRaisedReturnId(savedUpdate);
      validateReturnStateProgression(order, actionId, previousOnUpdate, label, result);
      validateReturnIdContinuity(order, raisedId, raisedFrom, label, result);
      validateAdjustmentArithmetic(order, confirmData, label, result);

      // Post-confirm echo — see orderFormationChecks "POST-CONFIRM ECHO" and rtoChecks.
      // `on_status` is the latest status leg when there was one (it is always later than
      // on_confirm); otherwise on_confirm is the seller's last word on the order.
      const priorStatus = await getActionData(sessionID, flowId, txnId, "on_status");
      const onConfirmData = await getActionData(sessionID, flowId, txnId, "on_confirm");
      const prior = priorStatus?.order_state !== undefined
        ? { state: priorStatus.order_state, label: "previous on_status" }
        : { state: onConfirmData?.order_state, label: "on_confirm" };
      validateOrderStateNoRegression(order, prior.state, prior.label, label, result);
      validatePaymentParamsEcho(order, confirmData?.payments, label, result);
      validateCreatedAtNotBeforeOrder(order, confirmData, label, result);
      validateOnSelectFulfillmentRefs(order, result, label);

      const known = new Set<string>(
        [
          ...asArray(onConfirmData?.fulfillment_ids),
          ...asArray(priorStatus?.fulfillment_ids),
          ...asArray(previousOnUpdate?.fulfillments).map((f: any) => f?.id),
        ].filter(Boolean)
      );
      validatePartCancelPrecondition(order, known, label, result);
    }

    // TODO(RETeB2B-B2B): return reason-code validation against the provider's return policy
  } catch (_) {}

  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}
