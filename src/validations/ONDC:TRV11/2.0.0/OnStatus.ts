import { TestResult, Payload } from "../../../types/payload";
import { DomainValidators } from "../../shared/domainValidator";
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
  VALID_ORDER_STATUSES,
  ISO_TIME_REGEX,
} from "./pramaanChecks";

export default async function on_status(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string,
  usecaseId?: string
): Promise<TestResult> {
  const result = await DomainValidators.trv11OnStatus(element, sessionID, flowId, actionId);

  try {
    const context = element?.jsonRequest?.context;
    const message = element?.jsonRequest?.message;
    const type = resolveTrv11Type(element, flowId, usecaseId);

    // 1. Pramaan Context Verification
    validatePramaanContext(context, "on_status", result);

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

    if (order.id && typeof order.id === "string") {
      result.passed.push(`Verify the presence of 'message.order.id' which is a string (${order.id})`);
    } else {
      result.failed.push("Verify the presence of 'message.order.id' which is a string");
    }

    if (order.status && typeof order.status === "string") {
      result.passed.push(`Verify the presence of 'message.order.status' which is a string (${order.status})`);
      if (VALID_ORDER_STATUSES.includes(order.status)) {
        result.passed.push(`Verify that 'message.order.status' is one of [${VALID_ORDER_STATUSES.join(", ")}]`);
      } else {
        result.failed.push(`Verify that 'message.order.status' is one of [${VALID_ORDER_STATUSES.join(", ")}], found '${order.status}'`);
      }
    } else {
      result.failed.push("Verify the presence of 'message.order.status' which is a string");
    }

    // Items
    validatePramaanItems(order.items, type, result);

    // Provider
    validatePramaanProvider(order.provider, type, result);

    // Fulfillments
    validatePramaanFulfillments(order.fulfillments, type, result, true);

    // Billing
    validatePramaanBilling(order.billing, result);

    // Quote
    validatePramaanQuote(order.quote, result);

    // Payments
    if (order.payments && Array.isArray(order.payments)) {
      validatePramaanPayments(order.payments, "on_status", result);
    }

    // Cancellation Terms
    validatePramaanCancellationTerms(order.cancellation_terms, type, result);

    // Metro Tags
    if (type === "METRO") {
      validatePramaanOrderTags(order.tags, result);
    }

    // Timestamps
    if (order.created_at && (ISO_TIME_REGEX.test(order.created_at) || typeof order.created_at === "string")) {
      result.passed.push("'message.order.created_at' exists, is a string, and follows ISO 8601 format");
    }
    if (order.updated_at && (ISO_TIME_REGEX.test(order.updated_at) || typeof order.updated_at === "string")) {
      result.passed.push("'message.order.updated_at' exists, is a string, and follows ISO 8601 format");
    }

    // Ticket fulfillment validity w.r.t context timestamp
    const contextTimestamp = context?.timestamp;
    const items = order.items || [];
    const fulfillments = order.fulfillments || [];

    for (const item of items) {
      const count = item?.quantity?.selected?.count;
      if (count !== undefined && item?.fulfillment_ids && Array.isArray(item.fulfillment_ids)) {
        if (item.fulfillment_ids.length === count) {
          result.passed.push(`Item '${item.id}' fulfillment_ids count matches selected quantity in on_status`);
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
              result.passed.push("Ticket authorization valid_upto is valid in on_status");
            } else {
              result.failed.push(`Ticket authorization valid_upto (${validTo}) has expired w.r.t context timestamp`);
            }
          }
        }
      }
    }
  } catch (_) {}

  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}

