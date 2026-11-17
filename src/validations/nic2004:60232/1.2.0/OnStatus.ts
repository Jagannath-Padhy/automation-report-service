import assert from "assert";
import { TestResult, Payload } from "../../../types/payload";
import logger from "@ondc/automation-logger";
import { runExternalSchemaAndL1Validation } from "../../shared/externalSchemaValidator";
import { fetchData, saveData } from "../../../utils/redisUtils";

const PRE_PICKUP_STATES = [
  "Pending",
  "Searching-for-Agent",
  "Agent-assigned",
  "At-pickup",
];
const POST_PICKUP_IMMUTABLE_STATES = [
  "Out-for-delivery",
  "At-destination-hub",
  "In-transit",
];

export async function checkOnStatus(
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
  const transactionId = context?.transaction_id;
  const contextTimestamp = context?.timestamp;
  const order = message?.order;
  const fulfillments = order?.fulfillments || [];
  const orderState = order?.state;
  const payment = order?.payment;

  if (orderState === "Completed" && payment?.type === "ON-FULFILLMENT") {
    try {
      assert.ok(
        payment?.status === "PAID",
        "order/payment/status should be 'PAID' once the order is complete for payment type 'ON-FULFILLMENT'"
      );
      testResults.passed.push("Payment status validation passed");
    } catch (error: any) {
      logger.error(`Error during ${action} validation: ${error.message}`);
      testResults.failed.push(error.message);
    }
  }

  for (const fulfillment of fulfillments) {
    if (fulfillment.type !== "Delivery") continue;

    const ffState = fulfillment?.state?.descriptor?.code;
    const pickupTimestamp = fulfillment?.start?.time?.timestamp;
    const deliveryTimestamp = fulfillment?.end?.time?.timestamp;

    try {
      const hasTimestamps = !!(pickupTimestamp || deliveryTimestamp);
      assert.ok(
        !(PRE_PICKUP_STATES.includes(ffState) && hasTimestamps),
        `Pickup/Delivery timestamp should not be provided while fulfillment state is '${ffState}'`
      );
      testResults.passed.push("Pickup/Delivery timestamp requirement validation passed");
    } catch (error: any) {
      logger.error(`Error during ${action} validation: ${error.message}`);
      testResults.failed.push(error.message);
    }

    if (ffState === "Order-picked-up" && pickupTimestamp) {
      saveData(sessionID, transactionId, "pickupTimestamp", pickupTimestamp);
      try {
        assert.ok(
          contextTimestamp >= pickupTimestamp,
          "Pickup timestamp cannot be future-dated w.r.t context timestamp"
        );
        testResults.passed.push("Pickup timestamp validation passed");
      } catch (error: any) {
        logger.error(`Error during ${action} validation: ${error.message}`);
        testResults.failed.push(error.message);
      }
    }

    const pickedTimestamp = await fetchData(sessionID, transactionId, "pickupTimestamp");
    if (POST_PICKUP_IMMUTABLE_STATES.includes(ffState) && pickedTimestamp) {
      try {
        assert.ok(
          pickupTimestamp === pickedTimestamp,
          `Pickup timestamp cannot change once fulfillment state is '${ffState}'`
        );
        testResults.passed.push("Pickup timestamp immutability validation passed");
      } catch (error: any) {
        logger.error(`Error during ${action} validation: ${error.message}`);
        testResults.failed.push(error.message);
      }
    }

    if (ffState === "Order-delivered" && deliveryTimestamp) {
      try {
        assert.ok(
          contextTimestamp >= deliveryTimestamp,
          "Delivery timestamp cannot be future-dated w.r.t context timestamp"
        );
        testResults.passed.push("Delivery timestamp validation passed");
      } catch (error: any) {
        logger.error(`Error during ${action} validation: ${error.message}`);
        testResults.failed.push(error.message);
      }
    }

    // v1.2.0 contract: fulfillment tracking becomes active after pickup and
    // inactive after delivery.
    const isBetweenPickupAndDelivery =
      ffState === "Order-picked-up" || ffState === "Out-for-delivery" || ffState === "In-transit";
    if (isBetweenPickupAndDelivery) {
      try {
        assert.ok(
          Boolean(fulfillment.tracking),
          `fulfillments/tracking should be enabled (true) while fulfillment state is '${ffState}'`
        );
        testResults.passed.push("Tracking-enabled validation passed");
      } catch (error: any) {
        logger.error(`Error during ${action} validation: ${error.message}`);
        testResults.failed.push(error.message);
      }
    }
  }

  if (testResults.passed.length < 1 && testResults.failed.length < 1)
    testResults.passed.push(`Validated ${action}`);
  return testResults;
}
