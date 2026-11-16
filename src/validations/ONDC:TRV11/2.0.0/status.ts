import { TestResult, Payload } from "../../../types/payload";
import { saveFromElement } from "../../../utils/specLoader";
import { validateTrv11Status } from "../../shared/trv11Validations";
import { validatePramaanContext } from "./pramaanChecks";

export default async function status(
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
    validatePramaanContext(context, "status", result);

    // 2. Pramaan Message Verification
    if (!message || typeof message !== "object") {
      result.failed.push("Verify the presence of 'message' which is an object");
    } else {
      result.passed.push("Verify the presence of 'message' which is an object");
      if ((message.order_id && typeof message.order_id === "string") || (message.ref_id && typeof message.ref_id === "string")) {
        result.passed.push("Verify the presence of 'message.ref_id' or 'message.order_id' which is a string");
      } else {
        result.failed.push("Verify the presence of 'message.ref_id' or 'message.order_id' which is a string");
      }
    }

    validateTrv11Status(message, result);
  } catch (_) {}

  if (result.passed.length < 1 && result.failed.length < 1) {
    result.passed.push("Validated status");
  }

  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}

