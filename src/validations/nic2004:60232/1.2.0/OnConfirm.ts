import assert from "assert";
import { TestResult, Payload } from "../../../types/payload";
import logger from "@ondc/automation-logger";
import { runExternalSchemaAndL1Validation } from "../../shared/externalSchemaValidator";
import { fetchData } from "../../../utils/redisUtils";

export async function checkOnConfirm(
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

  try {
    assert.ok(
      createdAt <= updatedAt,
      "order/created_at cannot be future-dated w.r.t order/updated_at"
    );
    testResults.passed.push("order.created_at vs updated_at validation passed");
  } catch (error: any) {
    logger.error(`Error during ${action} validation: ${error.message}`);
    testResults.failed.push(error.message);
  }

  for (const fulfillment of fulfillments) {
    if (fulfillment.type !== "Delivery") continue;

    try {
      assert.ok(
        !fulfillment?.start?.time?.timestamp,
        `fulfillments[${fulfillment.id}]/start/time/timestamp (pickup timestamp) should not be provided before the order is picked up`
      );
      testResults.passed.push(
        `Pickup timestamp (not yet expected) validation passed for fulfillment ${fulfillment.id}`
      );
    } catch (error: any) {
      testResults.failed.push(error.message);
    }

    try {
      assert.ok(
        !fulfillment?.end?.time?.timestamp,
        `fulfillments[${fulfillment.id}]/end/time/timestamp (delivery timestamp) should not be provided before the order is picked up`
      );
      testResults.passed.push(
        `Delivery timestamp (not yet expected) validation passed for fulfillment ${fulfillment.id}`
      );
    } catch (error: any) {
      testResults.failed.push(error.message);
    }

    const rts: any = await fetchData(sessionID, transactionId, `${fulfillment.id}:rts`);
    try {
      assert.ok(
        rts !== "yes" || !!fulfillment?.start?.time?.range,
        `fulfillments[${fulfillment.id}]/start/time/range (pickup time range) is required in /on_confirm when ready_to_ship = 'yes'`
      );
      testResults.passed.push(
        `Pickup time range requirement validation passed for fulfillment ${fulfillment.id}`
      );
    } catch (error: any) {
      testResults.failed.push(error.message);
    }
  }

  if (testResults.passed.length < 1 && testResults.failed.length < 1)
    testResults.passed.push(`Validated ${action}`);
  return testResults;
}
