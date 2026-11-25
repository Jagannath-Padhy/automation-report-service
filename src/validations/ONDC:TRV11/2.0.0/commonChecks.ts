import { Payload, TestResult } from "../../../types/payload";

export async function checkCommon(
  payload: Payload,
  sessionID: string,
  flowId: string
): Promise<TestResult> {
  const testResults: TestResult = {
    response: {},
    passed: [],
    failed: [],
  };

  const { jsonRequest } = payload;
  const { message } = jsonRequest || {};
  const order = message?.order;
  const quote = order?.quote;
  const fulfillments = order?.fulfillments || message?.catalog?.providers?.flatMap((p: any) => p?.fulfillments || []);

  // 1. Validate GPS format and stop references if stops are present
  try {
    if (fulfillments && Array.isArray(fulfillments)) {
      for (const fulfillment of fulfillments) {
        const stops = fulfillment?.stops;
        if (stops && Array.isArray(stops)) {
          for (const stop of stops) {
            if (stop?.location?.gps) {
              const gps = stop.location.gps;
              const gpsRegex = /^-?\d{1,3}\.\d+,\s*-?\d{1,3}\.\d+$/;
              if (gpsRegex.test(gps)) {
                testResults.passed.push(`Stop ${stop?.id || ""}: GPS coordinates format is valid`);
              } else {
                testResults.failed.push(`Stop ${stop?.id || ""}: Invalid GPS format '${gps}'`);
              }
            }
          }
        }
      }
    }
  } catch (error: any) {
    testResults.failed.push(`Fulfillment GPS validation: ${error.message}`);
  }

  // 2. Validate quote.breakup titles
  try {
    if (quote && quote.breakup && Array.isArray(quote.breakup)) {
      const validTitles = [
        "BASE_FARE",
        "REFUND",
        "CANCELLATION_CHARGES",
        "DISTANCE_FARE",
        "TAX",
        "CONVENIENCE_FEE",
        "DISCOUNT"
      ];
      for (const breakupItem of quote.breakup) {
        if (breakupItem?.title) {
          const title = String(breakupItem.title).toUpperCase();
          const matches = validTitles.some((vt) => title.includes(vt));
          if (!matches) {
            testResults.failed.push(`Invalid title in quote.breakup: '${breakupItem.title}'`);
          }
        }

        // Only REFUND & CANCELLATION_CHARGES should be included if cancellation is being made
        const isCancelTitle =
          breakupItem?.title?.toUpperCase() === "REFUND" ||
          breakupItem?.title?.toUpperCase() === "CANCELLATION_CHARGES";
        if (isCancelTitle) {
          const status = order?.status;
          if (status !== "CANCELLED" && status !== "SOFT_CANCEL") {
            testResults.failed.push(
              "REFUND and CANCELLATION_CHARGES should only be included if cancellation is in progress"
            );
          }
        }
      }
      testResults.passed.push("Quote breakup titles validated");
    }
  } catch (error: any) {
    testResults.failed.push(`Quote breakup title validation: ${error.message}`);
  }

  return testResults;
}
