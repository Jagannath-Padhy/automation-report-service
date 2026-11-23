import assert from "assert";
import { TestResult, Payload } from "../../../types/payload";
import logger from "@ondc/automation-logger";
import { runExternalSchemaAndL1Validation } from "../../shared/externalSchemaValidator";

export async function checkSearch(
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
  const intent = message?.intent;
  const fulfillmentType = intent?.fulfillment?.type;
  const payloadDetails = intent?.["@ondc/org/payload_details"];

  try {
    assert.ok(
      fulfillmentType === "Delivery",
      "intent/fulfillment/type should be 'Delivery'"
    );
    testResults.passed.push("intent.fulfillment.type validation passed");
  } catch (error: any) {
    testResults.failed.push(error.message);
  }

  // Confirmed against a real 2026-11-16 session: intent.category in /search
  // is just {id}, with no nested time/duration — the buyer only names the
  // category, it doesn't declare a TAT. The per-category TAT (duration,
  // timestamp) is the seller's /on_search response field — see OnSearch.ts.

  // @ondc/org/payload_details is domain-specific (not generic Beckn) and
  // mandatory per the v1.2.0 contract's /search section.
  try {
    assert.ok(
      payloadDetails?.weight?.value !== undefined &&
        payloadDetails?.dimensions?.length?.value !== undefined &&
        payloadDetails?.dimensions?.breadth?.value !== undefined &&
        payloadDetails?.dimensions?.height?.value !== undefined &&
        payloadDetails?.category !== undefined,
      "intent/@ondc/org/payload_details should include weight, dimensions (length/breadth/height) and category"
    );
    testResults.passed.push("payload_details validation passed");
  } catch (error: any) {
    testResults.failed.push(error.message);
  }

  if (testResults.passed.length < 1 && testResults.failed.length < 1)
    testResults.passed.push(`Validated ${action}`);
  return testResults;
}
