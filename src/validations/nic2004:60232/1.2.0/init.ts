import assert from "assert";
import { TestResult, Payload } from "../../../types/payload";
import logger from "@ondc/automation-logger";
import { runExternalSchemaAndL1Validation } from "../../shared/externalSchemaValidator";
import { saveData } from "../../../utils/redisUtils";

export async function checkInit(
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
  const billingCreatedAt = order?.billing?.created_at;
  const billingUpdatedAt = order?.billing?.updated_at;
  const payment = order?.payment;

  if (billingCreatedAt) {
    saveData(sessionID, transactionId, "billingTimestamp", billingCreatedAt);
    try {
      assert.ok(
        billingCreatedAt <= contextTimestamp,
        "order/billing/created_at cannot be future dated w.r.t context/timestamp"
      );
      testResults.passed.push("Billing created_at timestamp validation passed");
    } catch (error: any) {
      logger.error(`Error during ${action} validation: ${error.message}`);
      testResults.failed.push(error.message);
    }

    try {
      assert.ok(
        billingCreatedAt === billingUpdatedAt,
        "order/billing/created_at should be equal to order/billing/updated_at"
      );
      testResults.passed.push("Billing updated_at timestamp validation passed");
    } catch (error: any) {
      logger.error(`Error during ${action} validation: ${error.message}`);
      testResults.failed.push(error.message);
    }
  }

  // Confirmed against a real 2026-11-16 session (ORDER_FLOW_BASELINE_WITH_IGM):
  // payment.type was "ON-ORDER" and collected_by was "BAP" — these are
  // standard Beckn enum fields describing the payment arrangement (prepaid
  // by buyer vs. pay-on-fulfillment by seller), not constants fixed to one
  // value for this domain. Only presence/enum-membership is checked here.
  const VALID_PAYMENT_TYPES = ["ON-ORDER", "ON-FULFILLMENT", "PRE-FULFILLMENT", "POST-FULFILLMENT"];
  try {
    assert.ok(
      VALID_PAYMENT_TYPES.includes(payment?.type),
      `order/payment/type should be one of ${VALID_PAYMENT_TYPES.join("/")} (got ${payment?.type})`
    );
    testResults.passed.push("payment.type validation passed");
  } catch (error: any) {
    testResults.failed.push(error.message);
  }

  const VALID_COLLECTED_BY = ["BAP", "BPP"];
  try {
    assert.ok(
      VALID_COLLECTED_BY.includes(payment?.collected_by),
      `order/payment/collected_by should be one of ${VALID_COLLECTED_BY.join("/")} (got ${payment?.collected_by})`
    );
    testResults.passed.push("payment.collected_by validation passed");
  } catch (error: any) {
    testResults.failed.push(error.message);
  }

  if (testResults.passed.length < 1 && testResults.failed.length < 1)
    testResults.passed.push(`Validated ${action}`);
  return testResults;
}
