import { TestResult, Payload } from "../../../types/payload";
import { DomainValidators } from "../../shared/domainValidator";
import { checkCommon } from "./commonChecks";
import { saveFromElement } from "../../../utils/specLoader";
import {
  validatePramaanContext,
  validatePramaanBilling,
  validatePramaanPayments,
} from "./pramaanChecks";

export default async function confirm(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string,
  usecaseId?: string
): Promise<TestResult> {
  const result = await DomainValidators.trv11Confirm(element, sessionID, flowId, actionId);

  try {
    const context = element?.jsonRequest?.context;
    const message = element?.jsonRequest?.message;

    // 1. Pramaan Context Verification
    validatePramaanContext(context, "confirm", result);

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
    if (order.items && Array.isArray(order.items) && order.items.length > 0) {
      result.passed.push("Verify the presence of 'message.order.items' which is an array");
      order.items.forEach((item: any, idx: number) => {
        if (item.id && typeof item.id === "string") {
          result.passed.push(`Verify the presence of 'message.order.items[${idx}].id' which is a string`);
        } else {
          result.failed.push(`Verify the presence of 'message.order.items[${idx}].id' which is a string`);
        }
        if (item.quantity?.selected?.count !== undefined && typeof item.quantity.selected.count === "number") {
          result.passed.push(`Verify the presence of 'message.order.items[${idx}].quantity.selected.count' which is an integer`);
        }
      });
    } else {
      result.failed.push("Verify the presence of 'message.order.items' which is an array");
    }

    // Provider
    if (order.provider && typeof order.provider === "object") {
      result.passed.push("Verify the presence of 'message.order.provider' which is an object");
      if (order.provider.id && typeof order.provider.id === "string") {
        result.passed.push("Verify the presence of 'message.order.provider.id' which is a string");
      } else {
        result.failed.push("Verify the presence of 'message.order.provider.id' which is a string");
      }
    } else {
      result.failed.push("Verify the presence of 'message.order.provider' which is an object");
    }

    // Billing
    validatePramaanBilling(order.billing, result);

    // Payments: must be PAID in confirm
    if (order.payments && Array.isArray(order.payments) && order.payments.length > 0) {
      validatePramaanPayments(order.payments, "confirm", result);
      order.payments.forEach((payment: any, pIdx: number) => {
        if (payment.status === "PAID") {
          result.passed.push(`Payment [${pIdx}]: status is 'PAID'`);
        } else {
          result.failed.push(`Payment [${pIdx}]: status should be 'PAID', found '${payment.status}'`);
        }
        if (payment.params && typeof payment.params === "object") {
          if (payment.params.transaction_id) {
            result.passed.push(`Payment [${pIdx}]: params.transaction_id is present`);
          }
        }
      });
    } else {
      result.failed.push("Verify the presence of 'message.order.payments' which is an array");
    }
  } catch (_) {}

  const commonResults = await checkCommon(element, sessionID, flowId);
  result.passed.push(...commonResults.passed);
  result.failed.push(...commonResults.failed);

  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}

