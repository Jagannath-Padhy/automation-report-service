import assert from "assert";
import { TestResult, Payload } from "../../../types/payload";
import logger from "@ondc/automation-logger";
import { runExternalSchemaAndL1Validation } from "../../shared/externalSchemaValidator";
import { fetchData } from "../../../utils/redisUtils";

export async function checkOnUpdate(
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
  const order = message?.order;
  const fulfillments = order?.fulfillments || [];
  const shipmentType = order?.items?.[0]?.descriptor?.code;
  const breakup = order?.quote?.breakup || [];

  // Weight/dimension differential reconciliation, v1.2.0 contract: a "diff"
  // or "tax_diff" breakup line item must come with the diff_dim/diff_weight/
  // diff_proof tags that explain and evidence the correction.
  const hasWeightDiffCharge = breakup.some(
    (b: any) => b?.["@ondc/org/title_type"] === "diff" || b?.["@ondc/org/title_type"] === "tax_diff"
  );
  if (hasWeightDiffCharge) {
    const allTags = fulfillments.flatMap((f: any) => f?.tags || []);
    const hasDiffDim = allTags.some((tag: any) => tag.code === "diff_dim");
    const hasDiffWeight = allTags.some((tag: any) => tag.code === "diff_weight");
    const hasDiffProof = allTags.some((tag: any) => tag.code === "diff_proof");

    try {
      assert.ok(
        hasDiffDim || hasDiffWeight,
        "A weight-differential charge (title_type 'diff'/'tax_diff') is present in the quote breakup, but no 'diff_dim'/'diff_weight' tag explains the corrected dimensions/weight"
      );
      testResults.passed.push("Weight-differential dimension/weight tag validation passed");
    } catch (error: any) {
      testResults.failed.push(error.message);
    }

    try {
      assert.ok(
        hasDiffProof,
        "A weight-differential charge (title_type 'diff'/'tax_diff') is present in the quote breakup, but no 'diff_proof' tag provides evidence"
      );
      testResults.passed.push("Weight-differential proof tag validation passed");
    } catch (error: any) {
      testResults.failed.push(error.message);
    }
  }

  if (shipmentType === "P2H2P") {
    try {
      assert.ok(
        fulfillments.some((f: any) => f?.["@ondc/org/awb_no"]),
        "fulfillments/@ondc/org/awb_no is required for P2H2P shipments"
      );
      testResults.passed.push("AWB number for P2H2P validation passed");
    } catch (error: any) {
      logger.error(`Error during ${action} validation: ${error.message}`);
      testResults.failed.push(error.message);
    }

    try {
      const hasShippingLabel = fulfillments.some((f: any) =>
        (f?.start?.instructions?.images || []).length > 0
      );
      assert.ok(
        hasShippingLabel,
        "fulfillments/start/instructions/images (shipping label) is required for P2H2P shipments"
      );
      testResults.passed.push("Shipping label for P2H2P validation passed");
    } catch (error: any) {
      logger.error(`Error during ${action} validation: ${error.message}`);
      testResults.failed.push(error.message);
    }
  }

  for (const fulfillment of fulfillments) {
    if (fulfillment.type !== "Delivery") continue;
    const rts: any = await fetchData(sessionID, transactionId, `${fulfillment.id}:rts`);
    try {
      assert.ok(
        rts !== "yes" || !!fulfillment?.start?.time?.range,
        `fulfillments[${fulfillment.id}]/start/time/range (pickup time range) should be provided if ready_to_ship = 'yes' in /update`
      );
      testResults.passed.push(
        `Pickup time range validation passed for fulfillment ${fulfillment.id}`
      );
    } catch (error: any) {
      logger.error(`Error during ${action} validation: ${error.message}`);
      testResults.failed.push(error.message);
    }
  }

  if (testResults.passed.length < 1 && testResults.failed.length < 1)
    testResults.passed.push(`Validated ${action}`);
  return testResults;
}
