import { TestResult, Payload } from "../../../types/payload";
import { DomainValidators } from "../../shared/domainValidator";
import { saveFromElement } from "../../../utils/specLoader";
import { getActionData } from "../../../services/actionDataService";
import { validateOrderState, validateQuoteBreakup, validateItemPricing } from "./commonChecks";
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
  validateOrderTimestamps,
  validateBppTermsEcho,
  validateSettlementDetailsEcho,
  validateFinderFeeEcho,
  validateQuotePriceNoDrift,
  validateBillingEcho,
  validateProviderContinuity,
  validateIdsAgainstOnSelect,
  validateItemsAgainstOnSelect,
  validateShipFromLocation,
  validateFulfillmentContactAndTracking,
  validateDeliveryLocality,
  validateOrderDurations,
  validateTaxNumberPanConsistency,
  validateDistinctTaxIdentities,
  validateFinderFeeAgainstSearch,
} from "./orderFormationChecks";
import { isOffersFlow, validateOfferLinesUnchanged } from "./offerChecks";

export default async function confirm(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const result = await DomainValidators.retEB2BConfirm(element, sessionID, flowId, actionId);

  try {
    const message = element?.jsonRequest?.message;
    const order = message?.order;
    const context = element?.jsonRequest?.context;
    const mode = resolvePaymentMode(flowId);

    if (order?.id) {
      result.passed.push("confirm: order.id is present");
    } else {
      result.failed.push("confirm: order.id is missing");
    }

    if (order?.state) {
      validateOrderState(order, result, ["Created"], "confirm");
    }
    validateOrderTimestamps(order, context, "confirm", result, { requireCreatedAt: true });

    validatePaymentsPresence(order, "confirm", result);
    validatePaymentEnums(order, "confirm", result);
    validatePaymentModeLock(order, "confirm", mode, flowId, result);
    validateCodPaymentConstraints(order, "confirm", mode, result);
    validatePaidTransactionId(order, "confirm", result);

    validateSettlementDetails(order, "confirm", result);
    // Added 2026-10-13 (COD flow doc §3.4): a COD sale-amount must settle to the
    // seller side — the seller collected the cash. Prepaid is deliberately untouched.
    validateCodSettlementCounterparty(order, "confirm", mode, result);
    // The settlement terms are agreed here (delivery / P1D / 0.00 in all nine reference
    // flows) and absent from on_init, which is why this runs at confirm and not earlier.
    validateSettlementBasisWindow(order, "confirm", result);
    validatePaymentAmountMatchesQuote(order, "confirm", result);

    validateBppTerms(order, "confirm", result);
    // Silent unless bpp_terms declares np_type (five of nine flows omit it at this leg).
    validateTaxNumberPanConsistency(order, "confirm", result);
    validateDistinctTaxIdentities(order, "confirm", result);
    // Not required here — no reference confirm repeats the credit tag — but validated if sent.
    validateCreditTerms(order, "confirm", result);
    // accept_bpp_terms is required here — this is the buyer's own request, and all nine
    // reference flows send 'Y'. on_confirm is held to a weaker form; see validateBapTerms.
    validateBapTerms(order, "confirm", result, { requireAcceptance: true });

    validateItemPricing(order?.items, result, "confirm");
    if (order?.quote) {
      validateQuoteBreakup(order.quote, result, "confirm");
    }
    // Deliberately kept even though it is a silent no-op here: the contract's /confirm
    // declares no fulfillments[].start, and neither do the nine reference payloads. It is
    // the on_confirm leg that has a ship-from location. See the confirm contract audit §4.
    validateShipFromLocation(order, "confirm", result);
    // Added 2026-10-12 from the confirm-leg contract audit §3.1. L1 asserts end.contact.phone
    // and tracking EXIST at this leg; this adds the shape it cannot see. The start.contact
    // branch finds nothing here — confirm carries no fulfillment start.
    validateFulfillmentContactAndTracking(order, "confirm", result);
    validateDeliveryLocality(order, "confirm", result);
    validateOrderDurations(order, "confirm", result);

    const txnId = context?.transaction_id as string | undefined;
    if (txnId) {
      // The echo gap the generated COD scripts leave open: the terms the seller quoted at
      // on_init must still hold now that the buyer is committing to them.
      const onInitData = await getActionData(sessionID, flowId, txnId, "on_init");
      validateBppTermsEcho(order, onInitData?.bpp_terms, "confirm", result);
      validateSettlementDetailsEcho(order, onInitData?.settlement_details, "confirm", result);
      validateFinderFeeEcho(order, onInitData?.payments, "on_init", "confirm", result);
      validateQuotePriceNoDrift(order, onInitData?.quote_price, "on_init", "confirm", result);

      const initData = await getActionData(sessionID, flowId, txnId, "init");
      validateBillingEcho(order, initData?.billing, "confirm", result);
      validateProviderContinuity(order, initData?.provider, "init", "confirm", result);

      const onSelectData = await getActionData(sessionID, flowId, txnId, "on_select");
      validateIdsAgainstOnSelect(order, onSelectData, "confirm", result);
      // The committed order must match the terms the seller quoted, not the ones the buyer
      // first asked for: quantities and item->fulfillment pairing come from on_select.
      validateItemsAgainstOnSelect(order, onSelectData, "confirm", result);
      // Buyer leg, so the offer LINES only — see the matching note in init.ts.
      if (isOffersFlow(flowId)) validateOfferLinesUnchanged(order, onSelectData, "confirm", result);

      // Only the two `_with_offers(...)` flows have a search/on_search step, so both of
      // these have real data there and skip silently in the other seven.
      const searchData = await getActionData(sessionID, flowId, txnId, "search");
      validateFinderFeeAgainstSearch(order, searchData, "confirm", result);

      const onSearchData = await getActionData(sessionID, flowId, txnId, "on_search");
      validateCityConsistency(context, onSearchData, result, "confirm");
    }
  } catch (_) {}

  // Persisted via the `confirm` save-spec so later calls (on_confirm, cancel, on_cancel,
  // update, on_update) can verify they reference the same order id, and so on_confirm can
  // be held to the terms, quote price and payment status committed here.
  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}
