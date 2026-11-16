import { TestResult, Payload } from "../../../types/payload";
import { DomainValidators } from "../../shared/domainValidator";
import { validateOrderQuote } from "../../shared/quoteValidations";
import { saveFromElement } from "../../../utils/specLoader";
import { getActionData } from "../../../services/actionDataService";
import {
  validatePramaanContext,
  validatePramaanItems,
  validatePramaanProvider,
  validatePramaanFulfillments,
  validatePramaanBilling,
  validatePramaanPayments,
  validatePramaanQuote,
  validatePramaanCancellationTerms,
  validatePramaanOrderTags,
  resolveTrv11Type,
} from "./pramaanChecks";

export default async function on_init(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string,
  usecaseId?: string
): Promise<TestResult> {
  const result = await DomainValidators.trv11OnInit(element, sessionID, flowId, actionId);

  try {
    const context = element?.jsonRequest?.context;
    const message = element?.jsonRequest?.message;
    const type = resolveTrv11Type(element, flowId, usecaseId);

    // 1. Pramaan Context Verification
    validatePramaanContext(context, "on_init", result);

    // 2. Message Verification
    if (!message || typeof message !== "object") {
      result.failed.push("Verify the presence of 'message' which is an object");
      await saveFromElement(element, sessionID, flowId, "jsonRequest");
      return result;
    }
    result.passed.push("Verify the presence of 'message' which is an object");

    const order = message.order;
    if (!order || typeof order !== "object") {
      result.failed.push("Verify the presence of 'message.order' which is an object");
      await saveFromElement(element, sessionID, flowId, "jsonRequest");
      return result;
    }
    result.passed.push("Verify the presence of 'message.order' which is an object");

    // Items
    validatePramaanItems(order.items, type, result);

    // Provider
    validatePramaanProvider(order.provider, type, result);

    // Fulfillments
    validatePramaanFulfillments(order.fulfillments, type, result);

    // Billing
    validatePramaanBilling(order.billing, result);

    // Payments
    if (order.payments && Array.isArray(order.payments)) {
      validatePramaanPayments(order.payments, "on_init", result);
    }

    // Quote
    validatePramaanQuote(order.quote, result);
    if (order.quote) {
      validateOrderQuote(message, result, {
        validateDecimalPlaces: true,
        validateTotalMatch: true,
        validateItemPriceConsistency: false,
        flowId,
      });
    }

    // Cancellation Terms
    validatePramaanCancellationTerms(order.cancellation_terms, type, result);

    // Metro Tags
    if (type === "METRO") {
      validatePramaanOrderTags(order.tags, result);
    }

    const txnId = context?.transaction_id as string | undefined;
    if (txnId) {
      const initData = await getActionData(sessionID, flowId, txnId, "init");
      const onInitItems: any[] = order?.items || [];
      const initItems: any[] = initData?.items || [];
      const initPriceById = new Map<string, string>();
      for (const it of initItems) {
        if (it?.id && it?.price?.value !== undefined) {
          initPriceById.set(it.id, String(it.price.value));
        }
      }

      const missingFromInit: string[] = [];
      const priceMismatches: Array<{ id: string; init: string; on_init: string }> = [];
      for (const it of onInitItems) {
        const id = it?.id;
        if (!id) continue;
        if (!initPriceById.has(id)) {
          missingFromInit.push(id);
          continue;
        }
        const ini = parseFloat(initPriceById.get(id) as string);
        const onIni = it?.price?.value !== undefined ? parseFloat(String(it.price.value)) : NaN;
        if (!Number.isNaN(ini) && !Number.isNaN(onIni)) {
          if (ini === onIni) {
            result.passed.push(`Item '${id}' price matches INIT`);
          } else {
            priceMismatches.push({ id, init: String(ini), on_init: String(onIni) });
          }
        }
      }
      if (priceMismatches.length) {
        result.failed.push("Item price mismatches between INIT and on_init");
      }
      if (missingFromInit.length || priceMismatches.length) {
        (result.response as any) = {
          ...(result.response || {}),
          on_init_vs_init: { missingFromInit, priceMismatches },
        };
      }
    }
  } catch (_) {}

  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}

