import { TestResult, Payload } from "../../../types/payload";
import { DomainValidators } from "../../shared/domainValidator";
import { saveFromElement } from "../../../utils/specLoader";
import { getActionData } from "../../../services/actionDataService";
import { validateQuoteBreakup, validateItemPricing } from "./commonChecks";
import { validateCityConsistency } from "./selectChecks";
import {
  resolvePaymentMode,
  validatePaymentsPresence,
  validatePaymentEnums,
  validatePaymentModeLock,
  validateCodPaymentConstraints,
  validatePaidTransactionId,
  validateSettlementDetails,
  validateBillingDetails,
  validateIdsAgainstOnSelect,
  validateItemsAgainstOnSelect,
  validateFulfillmentContactAndTracking,
  validateDeliveryLocality,
  validateProviderContinuity,
  validateQuotePriceNoDrift,
  validateOffersAgainstCatalog,
  validateSelectOffersCarriedForward,
} from "./orderFormationChecks";
import { isOffersFlow, validateOfferLinesUnchanged } from "./offerChecks";

export default async function init(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const result = await DomainValidators.retEB2BInit(element, sessionID, flowId, actionId);

  try {
    const message = element?.jsonRequest?.message;
    const order = message?.order;
    const mode = resolvePaymentMode(flowId);

    validateBillingDetails(order, "init", result);
    // L1 asserts these fulfillment fields EXIST; this adds the shape it cannot see
    // (dialable phone, boolean tracking). See docs/RETeB2B-init-contract-audit.md §3.1.
    validateFulfillmentContactAndTracking(order, "init", result);
    validateDeliveryLocality(order, "init", result);

    validatePaymentsPresence(order, "init", result);
    validatePaymentEnums(order, "init", result);
    // No mode lock at init: every flow's init example — Prepaid included — sends the
    // mode-agnostic stub ON-FULFILLMENT / BPP, because the buyer app has not chosen a
    // payment instrument yet. validatePaymentModeLock skips `init` for both modes.
    validatePaymentModeLock(order, "init", mode, flowId, result);
    validateCodPaymentConstraints(order, "init", mode, result);
    validatePaidTransactionId(order, "init", result);
    // No-ops on every reference init — settlement_details is the seller's to declare, and
    // no init carries it. Kept so a buyer app that does send one is still held to the enums.
    validateSettlementDetails(order, "init", result);

    // init DOES carry a quote (price + breakup) in all nine reference flows, so the
    // quote checks apply from here, not only from on_init.
    validateItemPricing(order?.items, result, "init");
    if (order?.quote) {
      validateQuoteBreakup(order.quote, result, "init");
    }

    const context = element?.jsonRequest?.context;
    const txnId = context?.transaction_id as string | undefined;
    if (txnId) {
      const onSelectData = await getActionData(sessionID, flowId, txnId, "on_select");
      validateIdsAgainstOnSelect(order, onSelectData, "init", result);
      // The order must be formed on the terms the seller quoted, not the ones the buyer
      // first asked for — quantities and item->fulfillment pairing come from on_select.
      validateItemsAgainstOnSelect(order, onSelectData, "init", result);
      validateProviderContinuity(order, onSelectData?.provider, "on_select", "init", result);
      validateQuotePriceNoDrift(order, onSelectData?.quote_price, "on_select", "init", result);
      // The offer lines the seller applied at on_select must reach the order unchanged. Not
      // validateOrderOffersMatchApplied: init is the buyer's leg, and its order.offers lists
      // only the buyer's opt-ins, not the seller's auto-applied offers.
      if (isOffersFlow(flowId)) validateOfferLinesUnchanged(order, onSelectData, "init", result);

      const selectData = await getActionData(sessionID, flowId, txnId, "select");
      validateSelectOffersCarriedForward(order, selectData, "init", result);

      // Only the two `_with_offers(...)` flows have an on_search step, so both of these
      // have real data there and skip silently in the other seven.
      const onSearchData = await getActionData(sessionID, flowId, txnId, "on_search");
      validateCityConsistency(context, onSearchData, result, "init");
      validateOffersAgainstCatalog(order, context, onSearchData, "init", result);
    }
  } catch (_) {}

  // Persisted via the `init` save-spec so on_init can be held to the billing identity,
  // provider and quote this request declared, and to the ttl it allowed for a reply.
  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}
