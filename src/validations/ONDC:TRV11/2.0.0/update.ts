import { TestResult, Payload } from "../../../types/payload";
import { saveFromElement } from "../../../utils/specLoader";
import { validateTrv11Update } from "../../shared/trv11Validations";
import {
  validatePramaanContext,
  validatePramaanBilling,
} from "./pramaanChecks";

export default async function update(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId?: string,
  usecaseId?: string
): Promise<TestResult> {
  const result: TestResult = {
    response: {},
    passed: [],
    failed: [],
  };

  const { jsonRequest, jsonResponse } = element;
  if (jsonResponse?.response) result.response = jsonResponse?.response;

  try {
    const context = jsonRequest?.context;
    const message = jsonRequest?.message;

    // 1. Pramaan Context Verification
    validatePramaanContext(context, "update", result);

    // 2. Pramaan Message Verification
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

    validatePramaanBilling(order.billing, result);

    validateTrv11Update(message, result);
  } catch (_) {}

  if (result.passed.length < 1 && result.failed.length < 1) {
    result.passed.push("Validated update");
  }

  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}

