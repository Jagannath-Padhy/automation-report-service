import { TestResult, Payload } from "../../../types/payload";
import { DomainValidators } from "../../shared/domainValidator";
import { validateOrderQuote } from "../../shared/quoteValidations";
import { getActionData } from "../../../services/actionDataService";
import { validateErrorResponse } from "../../shared/validationFactory";
import { saveFromElement } from "../../../utils/specLoader";
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
  ISO_TIME_REGEX,
} from "./pramaanChecks";

export default async function on_confirm(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string,
  usecaseId?: string
): Promise<TestResult> {
  // For error response scenarios, validate error first
  if (actionId === "on_confirm_delayed" || actionId.includes("error") || actionId.includes("driver_not_found")) {
    const result: TestResult = {
      response: {},
      passed: [],
      failed: [],
    };
    const { jsonResponse } = element;
    if (jsonResponse?.response) result.response = jsonResponse?.response;
    validateErrorResponse(element?.jsonRequest, result, actionId);
    return result;
  }

  const result = await DomainValidators.trv11OnConfirm(element, sessionID, flowId, actionId);

  try {
    const context = element?.jsonRequest?.context;
    const message = element?.jsonRequest?.message;
    const type = resolveTrv11Type(element, flowId, usecaseId);

    // 1. Pramaan Context Verification
    validatePramaanContext(context, "on_confirm", result);

    // 2. Message & Order Verification
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

    if (order.id && typeof order.id === "string") {
      result.passed.push(`Verify the presence of 'message.order.id' which is a string (${order.id})`);
    } else {
      result.failed.push("Verify the presence of 'message.order.id' which is a string");
    }

    if (order.status && typeof order.status === "string") {
      result.passed.push(`Verify the presence of 'message.order.status' which is a string (${order.status})`);
    } else {
      result.failed.push("Verify the presence of 'message.order.status' which is a string");
    }

    // Items
    validatePramaanItems(order.items, type, result);

    // Provider
    validatePramaanProvider(order.provider, type, result);

    // Fulfillments (with requireAuth = true for on_confirm)
    validatePramaanFulfillments(order.fulfillments, type, result, true);

    // Billing
    validatePramaanBilling(order.billing, result);

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

    // Payments
    if (order.payments && Array.isArray(order.payments)) {
      validatePramaanPayments(order.payments, "on_confirm", result);
      order.payments.forEach((payment: any, pIdx: number) => {
        if (payment.status === "PAID") {
          result.passed.push(`Payment [${pIdx}]: status is 'PAID'`);
        } else {
          result.failed.push(`Payment [${pIdx}]: status should be 'PAID', found '${payment.status}'`);
        }
      });
    }

    // Cancellation Terms
    validatePramaanCancellationTerms(order.cancellation_terms, type, result);

    // Metro Tags
    if (type === "METRO") {
      validatePramaanOrderTags(order.tags, result);
    }

    // Timestamps: created_at & updated_at
    if (order.created_at && (ISO_TIME_REGEX.test(order.created_at) || typeof order.created_at === "string")) {
      result.passed.push("'message.order.created_at' exists, is a string, and follows ISO 8601 format");
    }
    if (order.updated_at && (ISO_TIME_REGEX.test(order.updated_at) || typeof order.updated_at === "string")) {
      result.passed.push("'message.order.updated_at' exists, is a string, and follows ISO 8601 format");
    }

    // Fulfillments count mapping and ticket validity check
    const items = order.items || [];
    const fulfillments = order.fulfillments || [];
    const contextTimestamp = context?.timestamp;

    for (const item of items) {
      const count = item?.quantity?.selected?.count;
      if (count !== undefined && item?.fulfillment_ids && Array.isArray(item.fulfillment_ids)) {
        if (item.fulfillment_ids.length === count) {
          result.passed.push(`Item '${item.id}' fulfillment_ids count matches selected quantity`);
        } else {
          result.failed.push(`Item '${item.id}': Expected ${count} fulfillment_ids, found ${item.fulfillment_ids.length}`);
        }

        for (const fid of item.fulfillment_ids) {
          const exists = fulfillments.some((f: any) => f?.id === fid);
          if (exists) {
            result.passed.push(`Fulfillment ID '${fid}' mapped to fulfillments array`);
          } else {
            result.failed.push(`Fulfillment ID '${fid}' not found in fulfillments array`);
          }
        }
      }
    }

    for (const fulfillment of fulfillments) {
      if (fulfillment?.type === "TICKET" && fulfillment?.stops && Array.isArray(fulfillment.stops)) {
        for (const stop of fulfillment.stops) {
          const auth = stop?.authorization;
          const validTo = auth?.valid_upto || auth?.valid_to;
          if (validTo && contextTimestamp) {
            if (new Date(validTo).getTime() >= new Date(contextTimestamp).getTime()) {
              result.passed.push(`Ticket authorization valid_upto is valid w.r.t context timestamp`);
            } else {
              result.failed.push(`Ticket authorization valid_upto (${validTo}) must be >= context timestamp (${contextTimestamp})`);
            }
          }
        }
      }
    }

    // Compare against CONFIRM request when available
    const txnId = context?.transaction_id as string | undefined;
    if (txnId) {
      const confirmData = await getActionData(sessionID, flowId, txnId, "confirm");
      const confirmItems: any[] = confirmData?.items || [];
      const confirmPriceById = new Map<string, string>();
      for (const it of confirmItems) {
        if (it?.id && it?.price?.value !== undefined) {
          confirmPriceById.set(it.id, String(it.price.value));
        }
      }

      const missingFromConfirm: string[] = [];
      const priceMismatches: Array<{ id: string; confirm: string; on_confirm: string }> = [];
      for (const it of items) {
        const id = it?.id;
        if (!id) continue;
        if (!confirmPriceById.has(id)) {
          missingFromConfirm.push(id);
          continue;
        }
        const cnf = parseFloat(confirmPriceById.get(id) as string);
        const onCnf = it?.price?.value !== undefined ? parseFloat(String(it.price.value)) : NaN;
        if (!Number.isNaN(cnf) && !Number.isNaN(onCnf)) {
          if (cnf === onCnf) {
            result.passed.push(`Item '${id}' price matches CONFIRM`);
          } else {
            priceMismatches.push({ id, confirm: String(cnf), on_confirm: String(onCnf) });
          }
        }
      }
      if (priceMismatches.length) {
        result.failed.push("Item price mismatches between CONFIRM and on_confirm");
      }
      if (missingFromConfirm.length || priceMismatches.length) {
        (result.response as any) = {
          ...(result.response || {}),
          on_confirm_vs_confirm: { missingFromConfirm, priceMismatches },
        };
      }
    }
  } catch (_) {}

  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}

