import { TestResult, Payload } from "../../../types/payload";
import { saveFromElement } from "../../../utils/specLoader";
import { validateTrv11Cancel } from "../../shared/trv11Validations";
import { updateApiMap } from "../../../utils/redisUtils";
import {
  validatePramaanContext,
  CANCELLATION_REASON_IDS,
} from "./pramaanChecks";

export default async function cancel(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string,
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
    const transactionId = context?.transaction_id;

    // 1. Pramaan Context Verification
    validatePramaanContext(context, "cancel", result);

    // 2. Pramaan Message Verification
    if (!message || typeof message !== "object") {
      result.failed.push("Verify the presence of 'message' which is an object");
      await saveFromElement(element, sessionID, flowId, "jsonRequest");
      return result;
    }
    result.passed.push("Verify the presence of 'message' which is an object");

    // Cancellation Reason ID
    if (message.cancellation_reason_id && typeof message.cancellation_reason_id === "string") {
      result.passed.push("Verify the presence of 'message.cancellation_reason_id' which is a string");

      const isTechnical = actionId?.includes("technical") || message.cancellation_reason_id === "000";
      if (isTechnical) {
        if (message.cancellation_reason_id === "000") {
          result.passed.push("'message.cancellation_reason_id' should equal '000'");
        } else {
          result.failed.push(`'message.cancellation_reason_id' should equal '000', found '${message.cancellation_reason_id}'`);
        }
      } else {
        if (CANCELLATION_REASON_IDS.includes(message.cancellation_reason_id)) {
          result.passed.push(`'message.cancellation_reason_id' is valid (${message.cancellation_reason_id})`);
        } else {
          result.passed.push(`'message.cancellation_reason_id' provided (${message.cancellation_reason_id})`);
        }
      }
    } else {
      result.failed.push("Verify the presence of 'message.cancellation_reason_id' which is a string");
    }

    // Descriptor
    if (message.descriptor && typeof message.descriptor === "object") {
      result.passed.push("Verify the presence of 'message.descriptor' which is an object");

      if (message.descriptor.name && typeof message.descriptor.name === "string") {
        result.passed.push("Verify the presence of 'message.descriptor.name' which is a string");
      }

      const code = message.descriptor.code;
      if (code && typeof code === "string") {
        result.passed.push("Verify the presence of 'message.descriptor.code' which is a string");

        const isConfirm = actionId?.includes("confirm") || actionId?.includes("two") || actionId?.includes("technical");
        const isSoft = actionId?.includes("soft") || actionId?.includes("one");

        if (isConfirm && code === "CONFIRM_CANCEL") {
          result.passed.push("'message.descriptor.code' should be equal to 'CONFIRM_CANCEL'");
        } else if (isSoft && code === "SOFT_CANCEL") {
          result.passed.push("'message.descriptor.code' should be equal to 'SOFT_CANCEL'");
        } else if (["SOFT_CANCEL", "CONFIRM_CANCEL"].includes(code)) {
          result.passed.push(`'message.descriptor.code' is valid (${code})`);
        }

        if (transactionId) {
          if (code === "SOFT_CANCEL") {
            await updateApiMap(sessionID, transactionId, "soft_cancel");
          } else if (code === "CONFIRM_CANCEL") {
            await updateApiMap(sessionID, transactionId, "confirm_cancel");
          }
        }
      } else {
        result.failed.push("Verify the presence of 'message.descriptor.code' which is a string");
      }
    } else {
      result.failed.push("Verify the presence of 'message.descriptor' which is an object");
    }

    // Order ID
    if (message.order_id && typeof message.order_id === "string") {
      result.passed.push(`Verify the presence of 'message.order_id' which is a string (${message.order_id})`);
    } else {
      result.failed.push("Verify the presence of 'message.order_id' which is a string");
    }

    validateTrv11Cancel(message, result);
  } catch (_) {}

  if (result.passed.length < 1 && result.failed.length < 1) {
    result.passed.push("Validated cancel");
  }

  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}

