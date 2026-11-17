import assert from "assert";
import { TestResult, Payload } from "../../../types/payload";
import logger from "@ondc/automation-logger";
import { runExternalSchemaAndL1Validation } from "../../shared/externalSchemaValidator";
import { saveData } from "../../../utils/redisUtils";

export async function checkConfirm(
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
  const createdAt = order?.created_at;
  const updatedAt = order?.updated_at;
  const fulfillments = order?.fulfillments || [];

  saveData(sessionID, transactionId, "createdAt", createdAt);

  try {
    assert.ok(
      createdAt === updatedAt,
      "order/created_at and order/updated_at must be the same at /confirm"
    );
    testResults.passed.push("order.created_at/updated_at equality validation passed");
  } catch (error: any) {
    logger.error(`Error during ${action} validation: ${error.message}`);
    testResults.failed.push(error.message);
  }

  try {
    assert.ok(
      contextTimestamp >= createdAt,
      "order/created_at cannot be future-dated w.r.t context/timestamp"
    );
    testResults.passed.push("order.created_at timestamp validation passed");
  } catch (error: any) {
    logger.error(`Error during ${action} validation: ${error.message}`);
    testResults.failed.push(error.message);
  }

  fulfillments.forEach((fulfillment: any) => {
    if (fulfillment.type !== "Delivery") return;

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
        rts !== "yes" || !!fulfillment?.start?.instructions,
        `fulfillments[${fulfillment.id}]/start/instructions (pickup confirmation code) is required when ready_to_ship = 'yes'`
      );
      testResults.passed.push(
        `Pickup instructions (PCC) requirement validation passed for fulfillment ${fulfillment.id}`
      );
    } catch (error: any) {
      testResults.failed.push(error.message);
    }
  });

  try {
    assert.ok(
      order?.id,
      "order/id should be set by the buyer app at /confirm"
    );
    testResults.passed.push("order.id presence validation passed");
  } catch (error: any) {
    testResults.failed.push(error.message);
  }

  if (testResults.passed.length < 1 && testResults.failed.length < 1)
    testResults.passed.push(`Validated ${action}`);
  return testResults;
}
