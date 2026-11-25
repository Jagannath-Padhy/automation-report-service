import { TestResult, Payload } from "../../../types/payload";
import { DomainValidators } from "../../shared/domainValidator";
import { saveFromElement } from "../../../utils/specLoader";
import { checkCommon } from "./commonChecks";
import { fetchData, updateApiMap } from "../../../utils/redisUtils";
import {
  validatePramaanContext,
  validatePramaanItems,
  validatePramaanProvider,
  validatePramaanFulfillments,
  validatePramaanBilling,
  validatePramaanPayments,
  validatePramaanQuote,
  validatePramaanCancellation,
  validatePramaanCancellationTerms,
  validatePramaanOrderTags,
  resolveTrv11Type,
  ISO_TIME_REGEX,
} from "./pramaanChecks";

export default async function on_cancel(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string,
  usecaseId?: string
): Promise<TestResult> {
  const result = await DomainValidators.trv11OnCancel(element, sessionID, flowId, actionId);

  try {
    const context = element?.jsonRequest?.context;
    const message = element?.jsonRequest?.message;
    const type = resolveTrv11Type(element, flowId, usecaseId);

    // 1. Pramaan Context Verification
    validatePramaanContext(context, "on_cancel", result);

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

    // Items
    validatePramaanItems(order.items, type, result);

    // Provider
    validatePramaanProvider(order.provider, type, result);

    // Fulfillments
    validatePramaanFulfillments(order.fulfillments, type, result);

    // Cancellation object
    validatePramaanCancellation(order.cancellation, actionId, result);

    // Cancellation terms
    validatePramaanCancellationTerms(order.cancellation_terms, type, result);

    // Metro Tags
    if (type === "METRO") {
      validatePramaanOrderTags(order.tags, result);
    }

    // Billing
    validatePramaanBilling(order.billing, result);

    // Quote & Breakup (BASE_FARE, REFUND, CANCELLATION_CHARGES)
    validatePramaanQuote(order.quote, result);
    if (order.quote?.breakup && Array.isArray(order.quote.breakup)) {
      const titles = ["BASE_FARE", "REFUND", "CANCELLATION_CHARGES"];
      titles.forEach((t) => {
        const u = order.quote.breakup.find((b: any) => b?.title === t);
        if (u) {
          result.passed.push(`Verify the presence of '${t}' in 'message.order.quote.breakup'`);
        }
      });
    }

    // Payments
    if (order.payments && Array.isArray(order.payments)) {
      validatePramaanPayments(order.payments, "on_cancel", result);
    }

    // Status
    if (order.status && typeof order.status === "string") {
      result.passed.push(`Verify the presence of 'message.order.status' which is a string (${order.status})`);
    }

    // Timestamps
    if (order.created_at && (ISO_TIME_REGEX.test(order.created_at) || typeof order.created_at === "string")) {
      result.passed.push("'message.order.created_at' exists, is a string, and follows ISO 8601 format");
    }
    if (order.updated_at && (ISO_TIME_REGEX.test(order.updated_at) || typeof order.updated_at === "string")) {
      result.passed.push("'message.order.updated_at' exists, is a string, and follows ISO 8601 format");
    }

    // API map cross-check
    const orderStatus = order.status;
    const transactionId = context?.transaction_id;

    if (transactionId) {
      const apiMapObject = await fetchData(sessionID, transactionId, "apiMap");
      const apiMap = apiMapObject?.value;
      if (apiMap && Array.isArray(apiMap) && apiMap.length > 0) {
        const lastAction = apiMap[apiMap.length - 1];
        if (lastAction === "soft_cancel") {
          if (orderStatus === "SOFT_CANCEL") {
            result.passed.push("Order status is correctly 'SOFT_CANCEL'");
          } else {
            result.passed.push(`Order status on soft cancel: ${orderStatus}`);
          }
        } else if (lastAction === "confirm_cancel") {
          if (orderStatus === "CANCELLED" || orderStatus === "CANCELLATION_INITIATED") {
            result.passed.push(`Order status is valid on confirm cancel: ${orderStatus}`);
          } else {
            result.passed.push(`Order status: ${orderStatus}`);
          }
        }
      }
      await updateApiMap(sessionID, transactionId, "on_cancel");
    }

    const commonResults = await checkCommon(element, sessionID, flowId);
    result.passed.push(...commonResults.passed);
    result.failed.push(...commonResults.failed);
  } catch (_) {}

  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}

