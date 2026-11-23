import assert from "assert";
import { TestResult, Payload } from "../../../types/payload";
import logger from "@ondc/automation-logger";
import { runExternalSchemaAndL1Validation } from "../../shared/externalSchemaValidator";
import { saveData } from "../../../utils/redisUtils";

export async function checkUpdate(
  element: Payload,
  sessionID: string,
  flowId: string
): Promise<TestResult> {
  const payload = element;
  const action = payload?.action.toLowerCase();
  logger.info(`Inside ${action} validations`);

  const testResults: TestResult = {
    response: {},
    passed: [],
    failed: [],
  };

  const { jsonRequest, jsonResponse } = payload;
  if (jsonResponse?.response) testResults.response = jsonResponse?.response;

  await runExternalSchemaAndL1Validation(jsonRequest, testResults);

  const { context, message } = jsonRequest;
  const contextTimestamp = context?.timestamp;
  const transactionId = context?.transaction_id;
  const order = message?.order;
  const updatedAt = order?.updated_at;
  const fulfillments = order?.fulfillments || [];

  // update_target is the key discriminator field for /update in the v1.2.0
  // contract (notify RTS, delivery instructions, linked-order part
  // return/cancel, pickup/delivery authorization).
  try {
    assert.ok(
      message?.update_target === "fulfillment",
      `message/update_target should be 'fulfillment' (got ${message?.update_target})`
    );
    testResults.passed.push("update_target validation passed");
  } catch (error: any) {
    testResults.failed.push(error.message);
  }

  try {
    assert.ok(
      contextTimestamp >= updatedAt,
      "order/updated_at cannot be future-dated w.r.t context/timestamp"
    );
    testResults.passed.push("order.updated_at timestamp validation passed");
  } catch (error: any) {
    logger.error(`Error during ${action} validation: ${error.message}`);
    testResults.failed.push(error.message);
  }

  for (const fulfillment of fulfillments) {
    if (fulfillment.type !== "Delivery") continue;

    let rts: string | undefined;
    fulfillment?.tags?.forEach((tag: any) => {
      if (tag.code === "state" && Array.isArray(tag.list)) {
        const rtsEntry = tag.list.find((item: any) => item.code === "ready_to_ship");
        if (rtsEntry) rts = rtsEntry.value;
      }
    });
    if (rts !== undefined) {
      saveData(sessionID, transactionId, `${fulfillment.id}:rts`, rts as any);
    }

    try {
      assert.ok(
        rts !== "yes" || !!fulfillment?.start,
        `fulfillments[${fulfillment.id}]/start is required when ready_to_ship = 'yes'`
      );
      testResults.passed.push(
        `Pickup details (start) requirement validation passed for fulfillment ${fulfillment.id}`
      );
    } catch (error: any) {
      testResults.failed.push(error.message);
    }

    try {
      assert.ok(
        rts !== "yes" || !!fulfillment?.start?.instructions,
        `fulfillments[${fulfillment.id}]/start/instructions (pickup code) is missing while ready_to_ship = 'yes'`
      );
      testResults.passed.push(
        `Pickup instructions requirement validation passed for fulfillment ${fulfillment.id}`
      );
    } catch (error: any) {
      testResults.failed.push(error.message);
    }
  }

  if (testResults.passed.length < 1 && testResults.failed.length < 1)
    testResults.passed.push(`Validated ${action}`);
  return testResults;
}
