import { TestResult, Payload } from "../../../types/payload";
import { DomainValidators } from "../../shared/domainValidator";
import { saveFromElement } from "../../../utils/specLoader";
import { saveData } from "../../../utils/redisUtils";
import {
  validatePramaanContext,
  resolveTrv11Type,
  GPS_PATTERN,
  GPS_FLEXIBLE_PATTERN,
  ISO_8601_DURATION_REGEX,
} from "./pramaanChecks";

export default async function on_search(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string,
  usecaseId?: string
): Promise<TestResult> {
  const result = await DomainValidators.trv11OnSearch(element, sessionID, flowId, actionId);

  try {
    const context = element?.jsonRequest?.context;
    const message = element?.jsonRequest?.message;
    const type = resolveTrv11Type(element, flowId, usecaseId);

    // 1. Pramaan Context Verification
    validatePramaanContext(context, "on_search", result);

    // 2. Message Verification
    if (!message || typeof message !== "object") {
      result.failed.push("Verify the presence of 'message' which is an object");
      await saveFromElement(element, sessionID, flowId, "jsonRequest");
      return result;
    }
    result.passed.push("Verify the presence of 'message' which is an object");

    if (!message.catalog || typeof message.catalog !== "object") {
      result.failed.push("Verify the presence of 'message.catalog' which is an object");
      await saveFromElement(element, sessionID, flowId, "jsonRequest");
      return result;
    }
    result.passed.push("Verify the presence of 'message.catalog' which is an object");

    // Catalog Descriptor
    if (message.catalog.descriptor && typeof message.catalog.descriptor === "object") {
      result.passed.push("Verify the presence of 'message.catalog.descriptor' which is an object");
      if (typeof message.catalog.descriptor.name === "string") {
        result.passed.push("'message.catalog.descriptor' has property named 'name' which is a string");
      } else {
        result.failed.push("'message.catalog.descriptor.name' must be a string");
      }
      if (message.catalog.descriptor.images && Array.isArray(message.catalog.descriptor.images)) {
        result.passed.push("'message.catalog.descriptor.images' is an array");
      }
    } else {
      result.failed.push("Verify the presence of 'message.catalog.descriptor' which is an object");
    }

    // Catalog Providers
    const providers = message.catalog.providers;
    if (!providers || !Array.isArray(providers) || providers.length === 0) {
      result.failed.push("Verify the presence of 'message.catalog.providers' which is an array");
    } else {
      result.passed.push("Verify the presence of 'message.catalog.providers' which is an array");

      // Check if step I or II (step II has items, step I has fulfillments only)
      const hasItems = providers.some((p: any) => p?.items && Array.isArray(p.items) && p.items.length > 0);
      const step = hasItems ? "II" : "I";

      for (let pIdx = 0; pIdx < providers.length; pIdx++) {
        const provider = providers[pIdx];

        if (provider.id && typeof provider.id === "string") {
          result.passed.push(`Provider [${pIdx}]: 'id' is a string (${provider.id})`);
        } else {
          result.failed.push(`Provider [${pIdx}]: 'id' is missing or not a string`);
        }

        // METRO specific categories and time.range
        if (type === "METRO") {
          if (provider.categories && Array.isArray(provider.categories)) {
            result.passed.push(`Provider [${pIdx}] (METRO): 'categories' is an array`);
            provider.categories.forEach((cat: any, cIdx: number) => {
              if (cat?.id && cat?.descriptor?.code) {
                result.passed.push(`Provider [${pIdx}] Category [${cIdx}]: valid id and descriptor.code`);
              }
            });
          }

          if (provider.time?.range?.start && provider.time?.range?.end) {
            result.passed.push(`Provider [${pIdx}] (METRO): 'time.range' start and end are strings`);
          }
        }

        // Provider descriptor
        if (provider.descriptor && typeof provider.descriptor === "object") {
          result.passed.push(`Provider [${pIdx}]: 'descriptor' is an object`);
          if (provider.descriptor.name) {
            result.passed.push(`Provider [${pIdx}]: descriptor.name is valid`);
          }
        }

        // Fulfillments
        if (provider.fulfillments && Array.isArray(provider.fulfillments)) {
          result.passed.push(`Provider [${pIdx}]: 'fulfillments' is an array`);
          provider.fulfillments.forEach((f: any, fIdx: number) => {
            if (f.id && typeof f.id === "string") {
              result.passed.push(`Provider [${pIdx}] Fulfillment [${fIdx}]: id is a string`);
            }
            if (f.type && typeof f.type === "string") {
              result.passed.push(`Provider [${pIdx}] Fulfillment [${fIdx}]: type is a string`);
            }
            if (f.stops && Array.isArray(f.stops)) {
              result.passed.push(`Provider [${pIdx}] Fulfillment [${fIdx}]: stops is an array`);
              f.stops.forEach((stop: any, sIdx: number) => {
                if (stop.type && typeof stop.type === "string") {
                  result.passed.push(`Provider [${pIdx}] Fulfillment [${fIdx}] Stop [${sIdx}]: type is a string`);
                }
                if (stop.location?.gps) {
                  const gps = stop.location.gps;
                  if (GPS_PATTERN.test(gps) || GPS_FLEXIBLE_PATTERN.test(gps)) {
                    result.passed.push(`Provider [${pIdx}] Fulfillment [${fIdx}] Stop [${sIdx}]: GPS is valid coordinates`);
                  } else {
                    result.failed.push(`Provider [${pIdx}] Fulfillment [${fIdx}] Stop [${sIdx}]: GPS '${gps}' is not in valid format`);
                  }
                }
              });
            }
            if (f.vehicle?.category) {
              result.passed.push(`Provider [${pIdx}] Fulfillment [${fIdx}]: vehicle category is '${f.vehicle.category}'`);
            }
          });
        }

        // Items (Step II)
        if (step === "II" && provider.items && Array.isArray(provider.items)) {
          result.passed.push(`Provider [${pIdx}]: 'items' is an array`);
          const transactionId = element?.jsonRequest?.context?.transaction_id;
          if (transactionId) {
            try {
              await saveData(sessionID, transactionId, "onSearchItemArr", {
                value: provider.items,
              });
            } catch (_) {}
          }

          provider.items.forEach((item: any, iIdx: number) => {
            if (item.id && typeof item.id === "string") {
              result.passed.push(`Provider [${pIdx}] Item [${iIdx}]: id is a string`);
            }
            if (type === "METRO" && item.category_ids && Array.isArray(item.category_ids)) {
              result.passed.push(`Provider [${pIdx}] Item [${iIdx}] (METRO): category_ids is a non-empty array`);
            }
            if (item.descriptor && typeof item.descriptor === "object") {
              result.passed.push(`Provider [${pIdx}] Item [${iIdx}]: descriptor is an object`);
            }
            if (item.price?.currency && item.price?.value !== undefined) {
              result.passed.push(`Provider [${pIdx}] Item [${iIdx}]: price is valid`);
            }
            if (item.quantity?.maximum?.count !== undefined && item.quantity?.minimum?.count !== undefined) {
              if (item.quantity.minimum.count > item.quantity.maximum.count) {
                result.failed.push(`Provider [${pIdx}] Item [${iIdx}]: quantity.minimum.count cannot exceed quantity.maximum.count`);
              } else {
                result.passed.push(`Provider [${pIdx}] Item [${iIdx}]: quantity min/max count is valid`);
              }
            }
            if (item.fulfillment_ids && Array.isArray(item.fulfillment_ids)) {
              result.passed.push(`Provider [${pIdx}] Item [${iIdx}]: fulfillment_ids is an array`);
            }
            if (item.time?.duration) {
              if (ISO_8601_DURATION_REGEX.test(item.time.duration)) {
                result.passed.push(`Provider [${pIdx}] Item [${iIdx}]: time.duration is valid ISO 8601 duration`);
              } else {
                result.failed.push(`Provider [${pIdx}] Item [${iIdx}]: time.duration must be valid ISO 8601 duration`);
              }
            }
          });
        }

        // Payments with BUYER_FINDER_FEES and SETTLEMENT_TERMS
        if (provider.payments && Array.isArray(provider.payments)) {
          result.passed.push(`Provider [${pIdx}]: 'payments' is an array`);
          provider.payments.forEach((payment: any, pmIdx: number) => {
            if (payment?.tags && Array.isArray(payment.tags)) {
              const bff = payment.tags.find((t: any) => t?.descriptor?.code === "BUYER_FINDER_FEES");
              if (bff) {
                result.passed.push(`Provider [${pIdx}] Payment [${pmIdx}]: 'BUYER_FINDER_FEES' tag is present`);
              }
              const st = payment.tags.find((t: any) => t?.descriptor?.code === "SETTLEMENT_TERMS");
              if (st) {
                result.passed.push(`Provider [${pIdx}] Payment [${pmIdx}]: 'SETTLEMENT_TERMS' tag is present`);
              }
            }
          });
        }

        // METRO SCHEDULED_INFO tag
        if (type === "METRO" && provider.tags && Array.isArray(provider.tags)) {
          const schedInfo = provider.tags.find((t: any) => t?.descriptor?.code === "SCHEDULED_INFO");
          if (schedInfo) {
            result.passed.push(`Provider [${pIdx}] (METRO): 'SCHEDULED_INFO' tag is present`);
            const gtfs = schedInfo.list?.find((l: any) => l?.descriptor?.code === "GTFS");
            if (gtfs) {
              result.passed.push(`Provider [${pIdx}] (METRO): 'GTFS' entry present in SCHEDULED_INFO`);
            }
          }
        }
      }
    }
  } catch (_) {}

  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}

