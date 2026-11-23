import assert from "assert";
import { TestResult, Payload } from "../../../types/payload";
import logger from "@ondc/automation-logger";
import { runExternalSchemaAndL1Validation } from "../../shared/externalSchemaValidator";
import { hasTwoOrLessDecimalPlaces } from "../../../utils/constants";

// v1.2.0 contract's /on_init section remaps quote.breakup's
// @ondc/org/title_type onto a specific enum (replacing the older,
// tax-inclusive line items with granular ones).
const VALID_BREAKUP_TITLE_TYPES = [
  "delivery",
  "rto",
  "reverseqc",
  "tax",
  "diff",
  "tax_diff",
  "discount",
];

export async function checkOnInit(
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
  const quote = order?.quote;
  const cancellationTerms = order?.cancellation_terms;

  if (quote) {
    try {
      assert.ok(
        hasTwoOrLessDecimalPlaces(quote.price?.value),
        "order/quote/price/value should not have more than 2 decimal places"
      );
      testResults.passed.push("Quote price decimal validation passed");
    } catch (error: any) {
      testResults.failed.push(error.message);
    }

    let totalBreakup = 0;
    (quote.breakup || []).forEach((breakup: any, i: number) => {
      const titleType = breakup?.["@ondc/org/title_type"];
      try {
        assert.ok(
          VALID_BREAKUP_TITLE_TYPES.includes(titleType),
          `order/quote/breakup[${i}] @ondc/org/title_type '${titleType}' is not one of ${VALID_BREAKUP_TITLE_TYPES.join(", ")}`
        );
        testResults.passed.push(`Breakup title_type validation passed for breakup[${i}]`);
      } catch (error: any) {
        testResults.failed.push(error.message);
      }

      try {
        assert.ok(
          hasTwoOrLessDecimalPlaces(breakup.price?.value),
          `order/quote/breakup[${i}] (${titleType}) price.value should not have more than 2 decimal places`
        );
        testResults.passed.push(`Breakup price decimal validation passed for breakup[${i}]`);
      } catch (error: any) {
        testResults.failed.push(error.message);
      }

      totalBreakup += parseFloat(breakup.price?.value || "0");
      totalBreakup = parseFloat(totalBreakup.toFixed(2));
    });

    try {
      assert.ok(
        parseFloat(quote.price?.value) === totalBreakup,
        `order/quote/price/value (${quote.price?.value}) does not match the sum of breakup (${totalBreakup})`
      );
      testResults.passed.push("Quote price matches breakup total");
    } catch (error: any) {
      testResults.failed.push(error.message);
    }
  }

  // Cancellation terms, per fulfillment state, are new in v1.2.0.
  if (cancellationTerms) {
    (cancellationTerms || []).forEach((term: any, i: number) => {
      try {
        assert.ok(
          term?.fulfillment_state?.descriptor?.code,
          `order/cancellation_terms[${i}] should declare a fulfillment_state/descriptor/code`
        );
        assert.ok(
          term?.cancellation_fee?.percentage !== undefined ||
            term?.cancellation_fee?.amount?.value !== undefined,
          `order/cancellation_terms[${i}] should declare a cancellation_fee (percentage or amount)`
        );
        testResults.passed.push(
          `Cancellation terms validation passed for fulfillment_state '${term?.fulfillment_state?.descriptor?.code}'`
        );
      } catch (error: any) {
        testResults.failed.push(error.message);
      }
    });
  } else {
    testResults.failed.push(
      "order/cancellation_terms should be provided per the v1.2.0 contract"
    );
  }

  if (testResults.passed.length < 1 && testResults.failed.length < 1)
    testResults.passed.push(`Validated ${action}`);

  return testResults;
}
