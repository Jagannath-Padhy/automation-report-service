import { TestResult, Payload } from "../../../types/payload";
import { DomainValidators } from "../../shared/domainValidator";
import { saveFromElement } from "../../../utils/specLoader";
import { getActionData } from "../../../services/actionDataService";
import {
  validateQuoteBreakup,
  validateOrderState,
  validateItemPricing,
  compareOrderIdContinuity,
} from "./commonChecks";
import { validateCityConsistency } from "./selectChecks";
import {
  resolvePaymentMode,
  validatePaymentsPresence,
  validatePaymentEnums,
  validatePaymentModeLock,
  validateCodPaymentConstraints,
  validatePaidTransactionId,
  validateSettlementDetails,
  validateCodSettlementCounterparty,
  validateSettlementBasisWindow,
  validatePaymentAmountMatchesQuote,
  validateBppTerms,
  validateCreditTerms,
  validateBapTerms,
  validateAcceptBapTerms,
  validateOrderTimestamps,
  validateBppTermsEcho,
  validateSettlementDetailsEcho,
  validateFinderFeeEcho,
  validateQuotePriceNoDrift,
  validateBillingEcho,
  validateProviderContinuity,
  validateIdsAgainstOnSelect,
  validatePaymentStatusNoRegression,
  validateCallbackTtlWindow,
  validateItemsAgainstOnSelect,
  validateShipFromLocation,
  validateDeliveryLocality,
  validateFulfillmentContactAndTracking,
  validateOrderDurations,
  validateTaxNumberPanConsistency,
  validateDistinctTaxIdentities,
  validateFinderFeeAgainstSearch,
  validateUpdatedAtAdvances,
  validateCancellationTermsEcho,
} from "./orderFormationChecks";
import {
  isOffersFlow,
  validateOrderOffersMatchApplied,
  validateOfferLinesUnchanged,
} from "./offerChecks";

export default async function on_confirm(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const result = await DomainValidators.retEB2BOnConfirm(element, sessionID, flowId, actionId);

  try {
    const message = element?.jsonRequest?.message;
    const order = message?.order;
    const context = element?.jsonRequest?.context;
    const mode = resolvePaymentMode(flowId);

    if (order?.state) {
      // `Accepted` only, matching L1 (`ON_CONFIRM_ORDER_ADDITIONAL_PROPERTIES.ORDER_STATE`
      // declares `var_enum: ["Accepted"]`) and all nine reference flows, every one of which
      // sends `Accepted`. `Created` used to be tolerated here, which made this report more
      // permissive than the L1 gate in front of it.
      validateOrderState(order, result, ["Accepted"], "on_confirm");
    }
    // created_at is NOT required here and is NOT compared against confirm's: the reference
    // payloads legitimately re-stamp it (COD ...595Z at confirm vs ...612Z at on_confirm).
    validateOrderTimestamps(order, context, "on_confirm", result);

    validatePaymentsPresence(order, "on_confirm", result);
    validatePaymentEnums(order, "on_confirm", result);
    validatePaymentModeLock(order, "on_confirm", mode, flowId, result);
    validateCodPaymentConstraints(order, "on_confirm", mode, result);
    validatePaidTransactionId(order, "on_confirm", result);

    validateSettlementDetails(order, "on_confirm", result);
    // Added 2026-10-13 (COD flow doc §3.4): a COD sale-amount must settle to the
    // seller side — the seller collected the cash. Prepaid is deliberately untouched.
    validateCodSettlementCounterparty(order, "on_confirm", mode, result);
    validateSettlementBasisWindow(order, "on_confirm", result);
    validatePaymentAmountMatchesQuote(order, "on_confirm", result);

    validateBppTerms(order, "on_confirm", result);
    // Four of the nine flows add np_type here, which is what makes the PAN identity rule
    // fire at this leg; the other five omit it and are skipped rather than failed.
    validateTaxNumberPanConsistency(order, "on_confirm", result);
    validateDistinctTaxIdentities(order, "on_confirm", result);
    validateCreditTerms(order, "on_confirm", result);
    validateBapTerms(order, "on_confirm", result);

    validateItemPricing(order?.items, result, "on_confirm");
    if (order?.quote) {
      validateQuoteBreakup(order.quote, result, "on_confirm");
    }
    // Seller leg: the offers it lists must be exactly the offers its quote applies.
    if (isOffersFlow(flowId)) validateOrderOffersMatchApplied(order, "on_confirm", result);
    validateShipFromLocation(order, "on_confirm", result);
    // Vistar V7: an empty ship-from locality passed L1's presence rule.
    validateDeliveryLocality(order, "on_confirm", result, "start");
    // Added 2026-10-12 from the confirm-leg contract audit §3.1. This is the one leg that
    // carries BOTH contacts: the seller's warehouse (start) and the buyer's door (end). L1
    // asserts both phones exist and that tracking exists; this adds their shape.
    validateFulfillmentContactAndTracking(order, "on_confirm", result);
    validateOrderDurations(order, "on_confirm", result);

    const txnId = context?.transaction_id as string | undefined;
    if (txnId) {
      const confirmData = await getActionData(sessionID, flowId, txnId, "confirm");
      compareOrderIdContinuity(order?.id, confirmData?.order_id, "on_confirm", result);
      validateBppTermsEcho(order, confirmData?.bpp_terms, "on_confirm", result);
      // fn 270: the seller must accept the bap_terms the buyer proposed at confirm.
      validateAcceptBapTerms(order, confirmData?.bap_terms, "on_confirm", result);
      // The generated COD scripts omit the settlement_details echo at BOTH confirm and
      // on_confirm; it is applied at both here.
      validateSettlementDetailsEcho(order, confirmData?.settlement_details, "on_confirm", result);
      validateFinderFeeEcho(order, confirmData?.payments, "confirm", "on_confirm", result);
      validateQuotePriceNoDrift(order, confirmData?.quote_price, "confirm", "on_confirm", result);
      validateBillingEcho(order, confirmData?.billing, "on_confirm", result);
      validateProviderContinuity(order, confirmData?.provider, "confirm", "on_confirm", result);
      validatePaymentStatusNoRegression(order, confirmData?.payments, "confirm", "on_confirm", result);
      validateCallbackTtlWindow(context, confirmData?.timestamp, confirmData?.ttl, "confirm", "on_confirm", result);
      // updated_at only — created_at is legitimately re-stamped across this leg in all nine
      // flows (deltas 15-74 ms), so it is not compared. See validateUpdatedAtAdvances.
      validateUpdatedAtAdvances(order, confirmData?.updated_at, "confirm", "on_confirm", result);

      const onSelectData = await getActionData(sessionID, flowId, txnId, "on_select");
      validateIdsAgainstOnSelect(order, onSelectData, "on_confirm", result);
      validateItemsAgainstOnSelect(order, onSelectData, "on_confirm", result);
      if (isOffersFlow(flowId)) validateOfferLinesUnchanged(order, onSelectData, "on_confirm", result);

      const onInitData = await getActionData(sessionID, flowId, txnId, "on_init");
      validateCancellationTermsEcho(order, onInitData?.cancellation_terms, "on_init", "on_confirm", result);

      const searchData = await getActionData(sessionID, flowId, txnId, "search");
      validateFinderFeeAgainstSearch(order, searchData, "on_confirm", result);

      const onSearchData = await getActionData(sessionID, flowId, txnId, "on_search");
      validateCityConsistency(context, onSearchData, result, "on_confirm");
    }
  } catch (_) {}

  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}
