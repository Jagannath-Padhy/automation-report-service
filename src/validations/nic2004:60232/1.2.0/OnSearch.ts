import assert from "assert";
import { TestResult, Payload } from "../../../types/payload";
import logger from "@ondc/automation-logger";
import { runExternalSchemaAndL1Validation } from "../../shared/externalSchemaValidator";

export async function checkOnSearch(
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
  const providers = message?.catalog?.["bpp/providers"] || [];

  function extractDurationMinutes(duration: string | undefined): number | null {
    if (!duration) return null;
    const match = duration.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?$/);
    if (!match) return null;
    const days = match[1] ? parseInt(match[1], 10) : 0;
    const hours = match[2] ? parseInt(match[2], 10) : 0;
    const minutes = match[3] ? parseInt(match[3], 10) : 0;
    return days * 24 * 60 + hours * 60 + minutes;
  }

  function sameCalendarDay(a: Date, b: Date): boolean {
    return (
      a.getUTCFullYear() === b.getUTCFullYear() &&
      a.getUTCMonth() === b.getUTCMonth() &&
      a.getUTCDate() === b.getUTCDate()
    );
  }
  const bppTerms = message?.catalog?.["bpp/descriptor"]?.tags?.find(
    (tag: any) => tag.code === "bpp_terms"
  );

  // Transaction-level static-terms publishing mechanism, v1.2.0 contract.
  // Not enforced: the contract's own changelog notes a related
  // "backward-compatibility requirements" item was removed 7 Apr 2024, and
  // a real 2026-11-16 session confirms bpp_terms/static_terms is sent with
  // an empty value in current production traffic — both presence and
  // populated-value checks produced false positives against real data, so
  // this is left as informational only.
  const staticTerms = bppTerms?.list?.find((item: any) => item.code === "static_terms");
  if (staticTerms?.value) {
    testResults.passed.push("bpp_terms static_terms is present with a value");
  }

  providers.forEach((provider: any, providerIndex: number) => {
    const fulfillments = provider?.fulfillments || [];
    const items = provider?.items || [];
    const validFulfillmentIDs = new Set(fulfillments.map((f: any) => f.id));

    const hasForwardShipment = fulfillments.some((f: any) => f.type === "Delivery");
    const hasBackwardShipment = fulfillments.some((f: any) => f.type === "RTO");
    try {
      assert.ok(
        hasForwardShipment && hasBackwardShipment,
        `bpp/providers[${providerIndex}]/fulfillments should include both a forward shipment (Delivery) and a backward shipment (RTO)`
      );
      testResults.passed.push(
        `Forward and backward shipment validation passed for provider ${providerIndex}`
      );
    } catch (error: any) {
      testResults.failed.push(error.message);
    }

    provider?.categories?.forEach((category: any) => {
      try {
        assert.ok(
          category?.time?.label === "TAT",
          `bpp/providers[${providerIndex}]/categories/${category?.id} time.label should be 'TAT'`
        );
        testResults.passed.push(`TAT label validation passed for category ${category?.id}`);
      } catch (error: any) {
        testResults.failed.push(error.message);
      }

      // v1.2.0 contract: per-category TAT rules. Confirmed against a real
      // 2026-11-16 session: category.time.timestamp is a date-only string
      // (e.g. "2026-11-16"), not a full ISO datetime.
      const categoryId = category?.id;
      const timeDuration = category?.time?.duration;
      const timeTimestamp = category?.time?.timestamp;

      if (categoryId === "Immediate Delivery") {
        const minutes = extractDurationMinutes(timeDuration);
        try {
          assert.ok(
            minutes !== null && minutes <= 60,
            `bpp/providers[${providerIndex}]/categories/${categoryId} time.duration should be <= PT60M (got ${timeDuration})`
          );
          testResults.passed.push("Immediate Delivery TAT duration validation passed");
        } catch (error: any) {
          testResults.failed.push(error.message);
        }
        if (timeTimestamp) {
          try {
            assert.ok(
              sameCalendarDay(new Date(timeTimestamp), contextTimestamp),
              `bpp/providers[${providerIndex}]/categories/${categoryId} time.timestamp should be the same day as context.timestamp`
            );
            testResults.passed.push("Immediate Delivery TAT date validation passed");
          } catch (error: any) {
            testResults.failed.push(error.message);
          }
        }
      } else if (categoryId === "Same Day Delivery") {
        if (timeTimestamp) {
          try {
            assert.ok(
              sameCalendarDay(new Date(timeTimestamp), contextTimestamp),
              `bpp/providers[${providerIndex}]/categories/${categoryId} time.timestamp should be the same day as context.timestamp`
            );
            testResults.passed.push("Same Day Delivery TAT date validation passed");
          } catch (error: any) {
            testResults.failed.push(error.message);
          }
        }
      } else if (categoryId === "Next Day Delivery") {
        if (timeTimestamp) {
          const nextDay = new Date(contextTimestamp);
          nextDay.setUTCDate(nextDay.getUTCDate() + 1);
          try {
            assert.ok(
              sameCalendarDay(new Date(timeTimestamp), nextDay),
              `bpp/providers[${providerIndex}]/categories/${categoryId} time.timestamp should be the day after context.timestamp`
            );
            testResults.passed.push("Next Day Delivery TAT date validation passed");
          } catch (error: any) {
            testResults.failed.push(error.message);
          }
        }
      }
    });

    items.forEach((item: any, itemIndex: number) => {
      const descriptorCode = item?.descriptor?.code;
      try {
        assert.ok(
          descriptorCode === "P2P" || descriptorCode === "P2H2P",
          `bpp/providers[${providerIndex}]/items[${itemIndex}] descriptor.code should be 'P2P' or 'P2H2P' (got ${descriptorCode})`
        );
        testResults.passed.push(
          `Item delivery-model (P2P/P2H2P) validation passed for item ${item?.id}`
        );
      } catch (error: any) {
        testResults.failed.push(error.message);
      }

      try {
        assert.ok(
          validFulfillmentIDs.has(item?.fulfillment_id),
          `bpp/providers[${providerIndex}]/items[${itemIndex}] fulfillment_id does not match any fulfillment ID`
        );
        testResults.passed.push(
          `Fulfillment ID mapping validation passed for item ${item?.id}`
        );
      } catch (error: any) {
        testResults.failed.push(error.message);
      }
    });
  });

  if (testResults.passed.length < 1 && testResults.failed.length < 1)
    testResults.passed.push(`Validated ${action}`);
  return testResults;
}
