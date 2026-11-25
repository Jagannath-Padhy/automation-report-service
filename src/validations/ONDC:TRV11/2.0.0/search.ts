import { TestResult, Payload } from "../../../types/payload";
import { DomainValidators } from "../../shared/domainValidator";
import { saveFromElement } from "../../../utils/specLoader";
import { validatePramaanContext } from "./pramaanChecks";

export default async function search(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string,
  usecaseId?: string
): Promise<TestResult> {
  const result = await DomainValidators.trv11Search(element, sessionID, flowId, actionId);

  try {
    const context = element?.jsonRequest?.context;
    const message = element?.jsonRequest?.message;

    // 1. Pramaan Context Verification
    validatePramaanContext(context, "search", result);

    // 2. Pramaan search message verification
    if (!message || !message.intent) {
      result.failed.push("Verify the presence of 'message.intent' object");
    } else {
      result.passed.push("Verify the presence of 'message.intent' object");

      // Fulfillment and vehicle category
      const fulfillment = message.intent.fulfillment;
      if (fulfillment) {
        result.passed.push("Verify the presence of 'message.intent.fulfillment' property");
        if (fulfillment.vehicle) {
          result.passed.push("Verify the presence of 'message.intent.fulfillment.vehicle' property");
          if (fulfillment.vehicle.category && typeof fulfillment.vehicle.category === "string") {
            result.passed.push(`Verify 'message.intent.fulfillment.vehicle.category' which is a string (${fulfillment.vehicle.category})`);
          } else {
            result.failed.push("Verify 'message.intent.fulfillment.vehicle.category' which is a string");
          }
        }

        // Stops verification for step II (station / stop code based)
        if (fulfillment.stops && Array.isArray(fulfillment.stops)) {
          result.passed.push("Verify the presence of 'message.intent.fulfillment.stops' which is an array");
          fulfillment.stops.forEach((stop: any, sIdx: number) => {
            if (stop?.location?.descriptor) {
              result.passed.push(`Fulfillment Stop [${sIdx}]: location.descriptor is present`);
            }
          });
        }
      }

      // Payment
      const payment = message.intent.payment;
      if (payment) {
        result.passed.push("Verify the presence of 'message.intent.payment' property");
        if (payment.collected_by && !["BAP", "BPP"].includes(payment.collected_by)) {
          result.failed.push("'message.intent.payment.collected_by' should be one of 'BAP' or 'BPP'");
        } else if (payment.collected_by) {
          result.passed.push(`'message.intent.payment.collected_by' is '${payment.collected_by}'`);
        }

        // Pramaan payment tags (BUYER_FINDER_FEES and SETTLEMENT_TERMS)
        if (payment.tags && Array.isArray(payment.tags) && payment.tags.length > 0) {
          result.passed.push("Verify the presence of 'message.intent.payment.tags' which is an array");

          const bff = payment.tags.find((t: any) => t?.descriptor?.code === "BUYER_FINDER_FEES");
          if (bff) {
            result.passed.push("'message.intent.payment.tags' should contain BUYER_FINDER_FEES");
            if (bff.list && Array.isArray(bff.list)) {
              const bffType = bff.list.find((l: any) => l?.descriptor?.code === "BUYER_FINDER_FEES_TYPE");
              if (bffType) {
                result.passed.push("BUYER_FINDER_FEES tag contains 'BUYER_FINDER_FEES_TYPE'");
              }
            }
          }

          const st = payment.tags.find((t: any) => t?.descriptor?.code === "SETTLEMENT_TERMS");
          if (st) {
            result.passed.push("'message.intent.payment.tags' should contain SETTLEMENT_TERMS");
            if (st.list && Array.isArray(st.list)) {
              const delayInt = st.list.find((l: any) => l?.descriptor?.code === "DELAY_INTEREST");
              if (delayInt) {
                result.passed.push("SETTLEMENT_TERMS tag contains 'DELAY_INTEREST'");
              }
              const staticTerms = st.list.find((l: any) => l?.descriptor?.code === "STATIC_TERMS");
              if (staticTerms) {
                result.passed.push("SETTLEMENT_TERMS tag contains 'STATIC_TERMS'");
              }
            }
          }
        }
      }
    }
  } catch (_) {}

  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}
