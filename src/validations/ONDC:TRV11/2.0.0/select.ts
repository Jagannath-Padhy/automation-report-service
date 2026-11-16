import { TestResult, Payload } from "../../../types/payload";
import { DomainValidators } from "../../shared/domainValidator";
import { saveFromElement } from "../../../utils/specLoader";
import { fetchData } from "../../../utils/redisUtils";
import { validatePramaanContext } from "./pramaanChecks";

export default async function select(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string,
  usecaseId?: string
): Promise<TestResult> {
  const result = await DomainValidators.trv11Select(element, sessionID, flowId, actionId);

  try {
    const context = element?.jsonRequest?.context;
    const message = element?.jsonRequest?.message;

    // 1. Pramaan Context Verification
    validatePramaanContext(context, "select", result);

    // 2. Pramaan Message & Order Verification
    if (!message || typeof message !== "object") {
      result.failed.push("Verify the presence of 'message' object");
      await saveFromElement(element, sessionID, flowId, "jsonRequest");
      return result;
    }
    result.passed.push("Verify the presence of 'message' object");

    const order = message.order;
    if (!order || typeof order !== "object") {
      result.failed.push("should have 'message.order' property");
      await saveFromElement(element, sessionID, flowId, "jsonRequest");
      return result;
    }
    result.passed.push("should have 'message.order' property");

    // Items
    if (!order.items || !Array.isArray(order.items) || order.items.length === 0) {
      result.failed.push("should have 'message.order.items' property which is an array and not empty");
    } else {
      result.passed.push("should have 'message.order.items' property");
      order.items.forEach((item: any, idx: number) => {
        if (item?.id && typeof item.id === "string") {
          result.passed.push(`should have 'message.order.items[${idx}].id' property`);
        } else {
          result.failed.push(`should have 'message.order.items[${idx}].id' property which is a string`);
        }

        if (item?.quantity && typeof item.quantity === "object") {
          result.passed.push(`should have 'message.order.items[${idx}].quantity' property`);
          if (item.quantity.selected && typeof item.quantity.selected.count === "number") {
            result.passed.push(`should have 'message.order.items[${idx}].quantity.selected.count' property which is an integer`);
          }
        } else {
          result.failed.push(`should have 'message.order.items[${idx}].quantity' property`);
        }
      });
    }

    // Provider
    if (order.provider && typeof order.provider === "object") {
      result.passed.push("should have 'message.order.provider' property");
      if (order.provider.id && typeof order.provider.id === "string") {
        result.passed.push("should have 'message.order.provider.id' property");
      } else {
        result.failed.push("should have 'message.order.provider.id' property which is a string");
      }
    } else {
      result.failed.push("should have 'message.order.provider' property");
    }

    // Catalog cross-reference: selected quantity within maximum limit
    const transactionId = context?.transaction_id;
    const items = order.items || [];
    if (transactionId && items.length > 0) {
      const onSearchItems = await fetchData(sessionID, transactionId, "onSearchItemArr");
      if (onSearchItems?.value && Array.isArray(onSearchItems.value)) {
        for (const item of items) {
          const catalogItem = onSearchItems.value.find((c: any) => c?.id === item?.id);
          if (catalogItem && item?.quantity?.selected?.count !== undefined && catalogItem?.quantity?.maximum?.count !== undefined) {
            if (item.quantity.selected.count <= catalogItem.quantity.maximum.count) {
              result.passed.push(`Item '${item.id}' selected quantity (${item.quantity.selected.count}) is within maximum catalog limit`);
            } else {
              result.failed.push(`Item '${item.id}': Selected count (${item.quantity.selected.count}) exceeds maximum allowed (${catalogItem.quantity.maximum.count})`);
            }
          }
        }
      }
    }
  } catch (_) {}

  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}

