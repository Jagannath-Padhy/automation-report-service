import assert from "assert";
import { TestResult, Payload } from "../../../types/payload";
import logger from "@ondc/automation-logger";
import { runExternalSchemaAndL1Validation } from "../../shared/externalSchemaValidator";

export async function checkOnCancel(
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

  const { message } = jsonRequest;
  const order = message?.order;
  const fulfillments = order?.fulfillments || [];
  const cancellation = order?.cancellation;

  try {
    assert.ok(
      cancellation?.cancelled_by,
      "order/cancellation/cancelled_by is required at /on_cancel"
    );
    testResults.passed.push("cancellation.cancelled_by validation passed");
  } catch (error: any) {
    testResults.failed.push(error.message);
  }

  try {
    assert.ok(
      cancellation?.reason?.id,
      "order/cancellation/reason/id is required at /on_cancel"
    );
    testResults.passed.push("cancellation.reason.id validation passed");
  } catch (error: any) {
    testResults.failed.push(error.message);
  }

  // precancel_state: the fulfillment state right before cancellation —
  // required per the v1.2.0 changelog (23rd Dec 2023, "linking cancellation
  // with IGM, pre-cancel state").
  const precancelTag = fulfillments
    .flatMap((f: any) => f?.tags || [])
    .find((tag: any) => tag.code === "precancel_state");
  try {
    assert.ok(
      precancelTag?.list?.some((item: any) => item.code === "fulfillment_state"),
      "fulfillments/tags should include a 'precancel_state' tag with the fulfillment_state right before cancellation"
    );
    testResults.passed.push("precancel_state tag validation passed");
  } catch (error: any) {
    testResults.failed.push(error.message);
  }

  // RTO sub-flow: a dedicated "RTO" fulfillment in state "RTO-Initiated" is
  // added when the forward delivery attempt(s) fail and the shipment is
  // being returned to origin.
  const rtoFulfillment = fulfillments.find(
    (f: any) => f.type === "RTO" && f?.state?.descriptor?.code === "RTO-Initiated"
  );
  if (rtoFulfillment) {
    try {
      assert.ok(
        order?.state === "Cancelled",
        `order/state should be 'Cancelled' once an RTO fulfillment is initiated (got ${order?.state})`
      );
      testResults.passed.push("RTO order-state validation passed");
    } catch (error: any) {
      testResults.failed.push(error.message);
    }

    try {
      assert.ok(
        order?.quote?.breakup?.some((b: any) => b?.["@ondc/org/title_type"] === "rto"),
        "An 'RTO-Initiated' fulfillment is present, but order/quote/breakup has no 'rto' title_type line item for the RTO cost"
      );
      testResults.passed.push("RTO quote line-item validation passed");
    } catch (error: any) {
      testResults.failed.push(error.message);
    }
  }

  if (testResults.passed.length < 1 && testResults.failed.length < 1)
    testResults.passed.push(`Validated ${action}`);
  return testResults;
}
