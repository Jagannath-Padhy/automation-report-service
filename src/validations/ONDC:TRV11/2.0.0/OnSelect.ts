import { TestResult, Payload } from "../../../types/payload";
import { DomainValidators } from "../../shared/domainValidator";
import { validateOrderQuote } from "../../shared/quoteValidations";
import { getActionData } from "../../../services/actionDataService";
import { saveFromElement } from "../../../utils/specLoader";
import {
  validatePramaanContext,
  validatePramaanItems,
  validatePramaanProvider,
  validatePramaanFulfillments,
  validatePramaanQuote,
  validatePramaanOrderTags,
  validatePramaanCancellationTerms,
  resolveTrv11Type,
} from "./pramaanChecks";

export default async function on_select(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string,
  usecaseId?: string
): Promise<TestResult> {
  const result = await DomainValidators.trv11OnSelect(element, sessionID, flowId, actionId);

  try {
    const context = element?.jsonRequest?.context;
    const message = element?.jsonRequest?.message;
    const type = resolveTrv11Type(element, flowId, usecaseId);

    // 1. Pramaan Context Verification
    validatePramaanContext(context, "on_select", result);

    // 2. Pramaan Message & Order Verification
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

    // Metro Tags & Cancellation Terms
    if (type === "METRO") {
      validatePramaanOrderTags(order.tags, result);
      validatePramaanCancellationTerms(order.cancellation_terms, type, result);
    } else {
      validatePramaanCancellationTerms(order.cancellation_terms, type, result);
    }

    // Compare item ids and prices with prior SELECT request if available
    const txnId = context?.transaction_id as string | undefined;
    if (txnId) {
      const selectData = await getActionData(sessionID, flowId, txnId, "select");
      const selItems: any[] = selectData?.order?.items || [];
      const onSelItems: any[] = order?.items || [];

      // Build price map from SELECT
      const selectPriceById = new Map<string, string>();
      for (const it of selItems) {
        if (it?.id && it?.price?.value !== undefined) {
          selectPriceById.set(it.id, String(it.price.value));
        }
      }

      const missingInSelect: string[] = [];
      const priceMismatches: Array<{ id: string; select: string; on_select: string }> = [];
      for (const it of onSelItems) {
        const id: string | undefined = it?.id;
        if (!id) continue;
        if (!selectPriceById.has(id)) {
          missingInSelect.push(id);
          continue;
        }
        const selPrice = parseFloat(selectPriceById.get(id) as string);
        const onSelPrice = it?.price?.value !== undefined ? parseFloat(String(it.price.value)) : NaN;
        if (!Number.isNaN(selPrice) && !Number.isNaN(onSelPrice)) {
          if (selPrice === onSelPrice) {
            result.passed.push(`Item '${id}' price matches SELECT`);
          } else {
            priceMismatches.push({ id, select: String(selPrice), on_select: String(onSelPrice) });
          }
        }
      }

      if (priceMismatches.length) {
        result.failed.push("Item price mismatches between SELECT and on_select");
        (result.response as any) = {
          ...(result.response || {}),
          on_select_vs_select: {
            ...(result.response as any)?.on_select_vs_select,
            priceMismatches,
          },
        };
      }
    }
  } catch (_) {}

  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}

