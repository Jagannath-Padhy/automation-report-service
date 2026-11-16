import assert from "assert";
import { TestResult, Payload } from "../../../types/payload";
import logger from "@ondc/automation-logger";
import { fetchData } from "../../../utils/redisUtils";
import { hasTwoOrLessDecimalPlaces } from "../../../utils/constants";

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

  const { context, message } = jsonRequest;
  const contextTimestamp = context?.timestamp;
  const transactionId = context.transaction_id;
  const quote = message?.order?.quote;

  if ("quote" in message.order) {
    try {
      assert.ok(
        hasTwoOrLessDecimalPlaces(quote.price.value),
        "Quote price value should not have more than 2 decimal places"
      );
      testResults.passed.push("Quote price decimal validation passed");
    } catch (error: any) {
      testResults.failed.push(error.message);
    }

    let totalBreakup = 0;
    let taxPresent = false;

    quote.breakup.forEach((breakup: { price: { value: string }; "@ondc/org/title_type": string; "@ondc/org/item_id"?: string }, i: number) => {
      try {
        assert.ok(
          hasTwoOrLessDecimalPlaces(breakup.price.value),
          `Price value for '${breakup["@ondc/org/title_type"]}' should not have more than 2 decimal places`
        );
        testResults.passed.push(`Decimal validation passed for breakup price - '${breakup["@ondc/org/title_type"]}'`);
      } catch (error: any) {
        testResults.failed.push(error.message);
      }

      totalBreakup += parseFloat(breakup.price.value);
      totalBreakup = parseFloat(totalBreakup.toFixed(2));

      if (breakup["@ondc/org/title_type"] === "tax") taxPresent = true;
    });

    try {
      assert.ok(
        taxPresent,
        "Fulfillment charges will have a separate quote line item for taxes"
      );
      testResults.passed.push("Tax line item validation passed");
    } catch (error: any) {
      testResults.failed.push(error.message);
    }

    try {
      assert.ok(
        parseFloat(quote.price.value) === totalBreakup,
        `Quote price ${parseFloat(quote.price.value)} does not match the breakup total ${totalBreakup}`
      );
      testResults.passed.push(`Quote price ${parseFloat(quote.price.value)} matches the breakup total ${totalBreakup}`);
    } catch (error: any) {
      testResults.failed.push(error.message);
    }
  }

  if (testResults.passed.length < 1 && testResults.failed.length < 1)
    testResults.passed.push(`Validated ${action}`);
  return testResults;
}
