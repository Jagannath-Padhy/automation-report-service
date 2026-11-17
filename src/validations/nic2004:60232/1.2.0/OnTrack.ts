import assert from "assert";
import { TestResult, Payload } from "../../../types/payload";
import logger from "@ondc/automation-logger";
import { runExternalSchemaAndL1Validation } from "../../shared/externalSchemaValidator";

export async function checkOnTrack(
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
  const contextTimestamp = new Date(context?.timestamp || "");
  const tracking = message?.tracking;
  const locationTimestamp = new Date(tracking?.location?.time?.timestamp || "");
  const updatedTimestamp = new Date(tracking?.location?.updated_at || "");

  try {
    assert.ok(
      locationTimestamp <= contextTimestamp,
      "tracking/location/time/timestamp should not be future-dated w.r.t context/timestamp"
    );
    testResults.passed.push("Location timestamp validation passed");
  } catch (error: any) {
    logger.error(`Error during ${action} validation: ${error.message}`);
    testResults.failed.push(error.message);
  }

  try {
    assert.ok(
      updatedTimestamp <= contextTimestamp,
      "tracking/location/updated_at should not be future-dated w.r.t context/timestamp"
    );
    testResults.passed.push("Updated timestamp validation passed");
  } catch (error: any) {
    logger.error(`Error during ${action} validation: ${error.message}`);
    testResults.failed.push(error.message);
  }

  try {
    assert.ok(
      tracking?.status === "active",
      `tracking/status should be 'active' while /track is callable (got ${tracking?.status})`
    );
    testResults.passed.push("tracking.status validation passed");
  } catch (error: any) {
    testResults.failed.push(error.message);
  }

  if (testResults.passed.length < 1 && testResults.failed.length < 1)
    testResults.passed.push(`Validated ${action}`);

  return testResults;
}
