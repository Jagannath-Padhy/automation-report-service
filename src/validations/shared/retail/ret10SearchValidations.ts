/**
 * Ported custom (business-logic) validations for ONDC:RET10 search/on_search,
 * sourced from log-validation-utility/utils/Retail/{Search,SearchInc,Catalog_Rejection}/*.
 *
 * Schema validation (AJV in the source) is intentionally NOT ported — it's
 * replaced by runExternalSchemaAndL1Validation, which calls this project's
 * own live L0 (schema) + L1 (JVAL) validator. Only checks schema can't
 * express are kept here.
 *
 * createDomainValidator dispatches purely by action name (SEARCH / ON_SEARCH),
 * not by scenario, so the three source scenarios — full catalog, incremental
 * catalog refresh, and catalog rejection — are merged into these two
 * functions and distinguished at runtime from the payload's own shape:
 *   - incremental search/on_search: message.intent.tags (or message.catalog.tags)
 *     contains a `catalog_inc` tag, and context.city === "*".
 *   - catalog rejection: top-level `error` is present instead of `message.catalog`.
 */

import { Payload, TestResult } from "../../../types/payload";
import { createBaseValidationSetup, addDefaultValidationMessage, tagLayer } from "../commonValidations";
import { runExternalSchemaAndL1Validation } from "../externalSchemaValidator";
import { getActionData, compareActionData } from "../../../services/actionDataService";
import { groceryJSON, healthJSON, homeJSON, BPCJSON } from "./categoryTables/category";
import { electronicsData } from "./categoryTables/electronics";
import { applianceData } from "./categoryTables/appliance";
import { fashion } from "./categoryTables/fashion";
import {
  checkMandatoryTags,
  getStatutoryRequirement,
  checkForStatutory,
} from "./categoryTables/mandatoryTagChecks";
import { statutory_reqs } from "./categoryTables/statutoryEnum";

/**
 * Domain-specific category-tag mandatory-field table, keyed by the RET1X
 * sub-domain code (e.g. "RET10"). Ported from log-validation-utility's
 * on_search.ts `checkMandatoryTags` dispatch switch. RET11 (F&B) is
 * deliberately excluded — it has its own separate on_search port.
 */
const CATEGORY_TABLES: Record<string, { json: any; label: string }> = {
  RET10: { json: groceryJSON, label: "Grocery" },
  RET12: { json: fashion, label: "Fashion" },
  RET13: { json: BPCJSON, label: "BPC" },
  RET14: { json: electronicsData, label: "Electronics" },
  RET15: { json: applianceData, label: "Appliances" },
  RET16: { json: homeJSON, label: "Home & Kitchen" },
  RET18: { json: healthJSON, label: "Health & Wellness" },
};

const DECIMAL_PRECISION = 6;

function getDecimalPrecision(value: string): number {
  const parts = String(value).split(".");
  return parts.length > 1 ? parts[1].length : 0;
}

function checkGpsPrecision(coordinates: string | undefined): boolean {
  if (!coordinates || typeof coordinates !== "string" || !coordinates.includes(",")) return false;
  try {
    const [lat, long] = coordinates.split(",");
    return getDecimalPrecision(lat) >= DECIMAL_PRECISION && getDecimalPrecision(long) >= DECIMAL_PRECISION;
  } catch {
    return false;
  }
}

function isValidPhoneNumber(value: string | undefined): boolean {
  if (!value) return false;
  let v = value.trim();
  if (v.startsWith("0")) v = v.substring(1);
  return /^(\d{10}|\d{11})$/.test(v);
}

function emailRegex(value: string | undefined): boolean {
  if (!value) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isIncremental(context: any, intentOrCatalogTags: any[] | undefined): boolean {
  const hasCatalogIncTag =
    Array.isArray(intentOrCatalogTags) &&
    intentOrCatalogTags.some((t: any) => t?.code === "catalog_inc");
  return hasCatalogIncTag || context?.city === "*";
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------
export async function validateRet10Search(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const { testResults, action, jsonRequest, context, message } = createBaseValidationSetup(element);

  await runExternalSchemaAndL1Validation(jsonRequest, testResults);

  if (!message?.intent) {
    tagLayer(testResults, "L2", () => {
      testResults.failed.push("search: /message/intent is missing or empty");
    });
    addDefaultValidationMessage(testResults, action);
    return testResults;
  }

  tagLayer(testResults, "L2", () => {
    const intent = message.intent;
    const incremental = isIncremental(context, intent?.tags);

    if (incremental) {
      if (context?.city !== "*") {
        testResults.failed.push(
          "search (incremental catalog): context/city should be \"*\" while sending search_inc_catalog request"
        );
      } else {
        testResults.passed.push(
          "search (incremental catalog): context/city is \"*\" as expected"
        );
      }
    }

    // buyer_app_finder_fee_amount must be present & numeric
    const buyerFF = parseFloat(intent?.payment?.["@ondc/org/buyer_app_finder_fee_amount"]);
    if (isNaN(buyerFF)) {
      testResults.failed.push(
        "search: message/intent/payment should have a numeric key @ondc/org/buyer_app_finder_fee_amount"
      );
    } else {
      testResults.passed.push("search: buyer_app_finder_fee_amount is present and numeric");
    }

    // fulfillment/end/location/gps precision, when provided
    const gps = intent?.fulfillment?.end?.location?.gps;
    if (intent?.fulfillment?.end) {
      if (!gps) {
        testResults.failed.push("search: fulfillment/end/location should have a required property gps");
      } else if (!checkGpsPrecision(gps)) {
        testResults.failed.push(
          "search: fulfillment/end/location/gps coordinates must be specified with at least six decimal places of precision"
        );
      } else {
        testResults.passed.push("search: fulfillment/end/location/gps precision is valid");
      }
    }

    // item and category are mutually exclusive on intent
    if ("item" in intent && "category" in intent) {
      testResults.failed.push("search: /message/intent cannot have both properties item and category");
    } else {
      testResults.passed.push("search: /message/intent item and category are not both present (mutually exclusive)");
    }

    // incremental-specific: tags are mandatory, and catalog_inc's mode must be start/stop
    if (incremental) {
      if (!intent?.tags) {
        testResults.failed.push("search (incremental catalog): /message/intent should have a required property tags");
      } else {
        testResults.passed.push("search (incremental catalog): /message/intent/tags is present");
        const catalogIncTag = intent.tags.find((t: any) => t?.code === "catalog_inc");
        const modeTag = catalogIncTag?.list?.find((i: any) => i?.code === "mode");
        if (modeTag) {
          if (modeTag.value !== "start" && modeTag.value !== "stop") {
            testResults.failed.push(
              "search (incremental catalog): catalog_inc tags/list/mode value should be one of 'start' or 'stop'"
            );
          } else {
            testResults.passed.push(
              `search (incremental catalog): catalog_inc tags/list/mode value '${modeTag.value}' is valid`
            );
          }
        }
        const startTimeTag = catalogIncTag?.list?.find((i: any) => i?.code === "start_time");
        const endTimeTag = catalogIncTag?.list?.find((i: any) => i?.code === "end_time");
        if (startTimeTag && endTimeTag && context?.timestamp) {
          const startTime = new Date(startTimeTag.value).getTime();
          const endTime = new Date(endTimeTag.value).getTime();
          const contextTime = new Date(context.timestamp).getTime();
          if (startTime >= contextTime) {
            testResults.failed.push(
              "search (incremental catalog): catalog_inc start_time cannot be >= context/timestamp"
            );
          } else {
            testResults.passed.push("search (incremental catalog): catalog_inc start_time is before context/timestamp");
          }
          if (endTime > contextTime) {
            testResults.failed.push("search (incremental catalog): catalog_inc end_time cannot be > context/timestamp");
          } else {
            testResults.passed.push("search (incremental catalog): catalog_inc end_time is not after context/timestamp");
          }
          if (endTime <= startTime) {
            testResults.failed.push("search (incremental catalog): catalog_inc end_time cannot be <= start_time");
          } else {
            testResults.passed.push("search (incremental catalog): catalog_inc end_time is after start_time");
          }
        }
      }
    }
  });

  // Cross-action state for this action is persisted by the wiring layer's
  // saveFromElement call (src/config/save-specs/RET10/1.2.5/search.yaml),
  // not inline here — avoids a conflicting second save under the same key.

  addDefaultValidationMessage(testResults, action);
  return testResults;
}

// ---------------------------------------------------------------------------
// on_search
// ---------------------------------------------------------------------------
export async function validateRet10OnSearch(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const { testResults, action, jsonRequest, context, message, error } = createBaseValidationSetup(element);

  await runExternalSchemaAndL1Validation(jsonRequest, testResults);

  // Catalog rejection scenario: top-level `error` present instead of a catalog.
  if (error && Object.keys(error).length > 0 && !message?.catalog) {
    const errCode = (error as any)?.code;
    tagLayer(testResults, "L2", () => {
      if (!errCode) {
        testResults.failed.push("on_search (catalog rejection): error.code is required");
      } else {
        testResults.passed.push(`on_search (catalog rejection): error.code ${errCode} present`);
      }
    });
    addDefaultValidationMessage(testResults, action);
    return testResults;
  }

  if (!message?.catalog) {
    tagLayer(testResults, "L2", () => {
      testResults.failed.push("on_search: /message/catalog is missing or empty");
    });
    addDefaultValidationMessage(testResults, action);
    return testResults;
  }

  const catalog = message.catalog;
  const providers = catalog["bpp/providers"];
  if (!Array.isArray(providers) || providers.length === 0) {
    tagLayer(testResults, "L2", () => {
      testResults.failed.push("on_search: /message/catalog/bpp/providers must be a non-empty array");
    });
    addDefaultValidationMessage(testResults, action);
    return testResults;
  }

  // Cross-check against the preceding /search, when available. Kept outside
  // the tagLayer wrap below since it needs `await` (tagLayer's callback is
  // synchronous); its own messages get their own small L2-tagged wrap.
  try {
    const transactionId = context?.transaction_id;
    if (transactionId) {
      const priorSearch = await getActionData(sessionID, flowId, transactionId, "search");
      if (priorSearch) {
        const { mismatches } = compareActionData(
          { message_id: priorSearch.message_id, transaction_id: priorSearch.transaction_id },
          { message_id: context?.message_id, transaction_id: context?.transaction_id }
        );
        tagLayer(testResults, "L2", () => {
          if (mismatches.includes("message_id")) {
            testResults.failed.push("on_search: message_id does not match the preceding /search");
          } else {
            testResults.passed.push("on_search: message_id matches the preceding /search");
          }
          if (mismatches.includes("transaction_id")) {
            testResults.failed.push("on_search: transaction_id does not match the preceding /search");
          } else {
            testResults.passed.push("on_search: transaction_id matches the preceding /search");
          }
        });
      }
    }
  } catch {
    // best-effort cross-check only
  }

  tagLayer(testResults, "L2", () => {
  const incremental = isIncremental(context, catalog?.tags);
  if (incremental) {
    if (context?.city !== "*") {
      testResults.failed.push("on_search (incremental catalog): context/city should be \"*\"");
    } else {
      testResults.passed.push("on_search (incremental catalog): context/city is \"*\" as expected");
    }
  }

  const providerIds = new Set<string>();
  const providerLocationIds = new Set<string>();
  const itemIds = new Set<string>();
  const categoryIds = new Set<string>();
  const itemCategoryIds = new Set<string>();

  providers.forEach((provider: any, i: number) => {
    // Duplicate provider id
    if (providerIds.has(provider.id)) {
      testResults.failed.push(`on_search: duplicate provider id '${provider.id}' in bpp/providers`);
    } else {
      providerIds.add(provider.id);
      testResults.passed.push(`on_search: provider id '${provider.id}' is unique in bpp/providers`);
    }

    // Store enable/disable timestamp sanity
    if (provider.time?.timestamp && context?.timestamp) {
      const providerTime = new Date(provider.time.timestamp).getTime();
      const contextTime = new Date(context.timestamp).getTime();
      if (providerTime > contextTime) {
        testResults.failed.push(
          `on_search: bpp/providers[${i}]/time/timestamp cannot be greater than context/timestamp`
        );
      } else {
        testResults.passed.push(`on_search: bpp/providers[${i}]/time/timestamp is not after context/timestamp`);
      }
    }

    // Locations: gps precision, duplicate ids, store days, timing shape
    (provider.locations || []).forEach((loc: any, iter: number) => {
      if (loc?.gps) {
        if (!checkGpsPrecision(loc.gps)) {
          testResults.failed.push(
            `on_search: bpp/providers[${i}]/locations[${iter}]/gps must have at least six decimal places of precision`
          );
        } else {
          testResults.passed.push(
            `on_search: bpp/providers[${i}]/locations[${iter}]/gps has sufficient decimal precision`
          );
        }
      }
      if (loc?.id) {
        if (providerLocationIds.has(loc.id)) {
          testResults.failed.push(`on_search: duplicate location id '${loc.id}' in bpp/providers[${i}]/locations`);
        } else {
          providerLocationIds.add(loc.id);
          testResults.passed.push(`on_search: location id '${loc.id}' is unique in bpp/providers[${i}]/locations`);
        }
      }

      const days = loc?.time?.days?.split(",") || [];
      days.forEach((d: string) => {
        const day = parseInt(d, 10);
        if (isNaN(day) || day < 1 || day > 7) {
          testResults.failed.push(
            `on_search: bpp/providers[${i}]/locations[${iter}]/time/days must list days 1-7 (Mon-Sun)`
          );
        } else {
          testResults.passed.push(
            `on_search: bpp/providers[${i}]/locations[${iter}]/time/days value '${d}' is a valid day (1-7)`
          );
        }
      });

      const hasRange = !!loc?.time?.range;
      const hasSplit = !!(loc?.time?.schedule?.frequency && loc?.time?.schedule?.times);
      if (hasRange && hasSplit) {
        testResults.failed.push(
          `on_search: bpp/providers[${i}]/locations[${iter}]/time should provide either fixed (range) or split (frequency+times) timings, not both`
        );
      } else if (!hasRange && !hasSplit) {
        testResults.failed.push(
          `on_search: bpp/providers[${i}]/locations[${iter}]/time must provide fixed (range) or split (frequency+times) timings`
        );
      } else {
        testResults.passed.push(
          `on_search: bpp/providers[${i}]/locations[${iter}]/time provides exactly one of fixed (range) or split (frequency+times) timings`
        );
      }
      if (hasRange) {
        const start = parseInt(loc.time.range.start, 10);
        const end = parseInt(loc.time.range.end, 10);
        if (isNaN(start) || isNaN(end) || start > end || end > 2359) {
          testResults.failed.push(
            `on_search: bpp/providers[${i}]/locations[${iter}]/time/range end must be >= start and <= 2359`
          );
        } else {
          testResults.passed.push(
            `on_search: bpp/providers[${i}]/locations[${iter}]/time/range start/end is valid`
          );
        }
      }

      const holidays = loc?.time?.schedule?.holidays || [];
      const [currentDate] = (context?.timestamp || "").split("T");
      holidays.forEach((date: string) => {
        if (currentDate && new Date(date).getTime() < new Date(currentDate).getTime()) {
          testResults.failed.push(
            `on_search: bpp/providers[${i}]/locations[${iter}]/time/schedule/holidays cannot be in the past (${date})`
          );
        } else {
          testResults.passed.push(
            `on_search: bpp/providers[${i}]/locations[${iter}]/time/schedule/holidays date ${date} is not in the past`
          );
        }
      });
    });

    // Categories: duplicate ids, custom/variant tag rules
    const customGroupIds = new Set<string>();
    (provider.categories || []).forEach((category: any, j: number) => {
      if (categoryIds.has(category.id)) {
        testResults.failed.push(`on_search: duplicate category id '${category.id}' in bpp/providers[${i}]`);
      } else {
        categoryIds.add(category.id);
        testResults.passed.push(`on_search: category id '${category.id}' is unique in bpp/providers[${i}]`);
      }
      (category.tags || []).forEach((tag: any) => {
        if (tag.code === "type") {
          const typeValue = tag.list?.find((it: any) => it.code === "type")?.value;
          if (!["custom_menu", "custom_group", "variant_group"].includes(typeValue)) {
            testResults.failed.push(
              `on_search: bpp/providers[${i}]/categories[${j}] tags.type value must be one of custom_menu/custom_group/variant_group`
            );
          } else {
            testResults.passed.push(
              `on_search: bpp/providers[${i}]/categories[${j}] tags.type value '${typeValue}' is valid`
            );
          }
          if (typeValue === "custom_group") customGroupIds.add(category.id);
        }
        if (tag.code === "timing") {
          (tag.list || []).forEach((item: any) => {
            if (["day_from", "day_to"].includes(item.code)) {
              const v = parseInt(item.value, 10);
              if (isNaN(v) || v < 1 || v > 7) {
                testResults.failed.push(
                  `on_search: bpp/providers[${i}]/categories[${j}] timing ${item.code} must be 1-7`
                );
              } else {
                testResults.passed.push(
                  `on_search: bpp/providers[${i}]/categories[${j}] timing ${item.code} value '${item.value}' is valid`
                );
              }
            }
            if (["time_from", "time_to"].includes(item.code)) {
              if (!/^([01]\d|2[0-3])[0-5]\d$/.test(item.value)) {
                testResults.failed.push(
                  `on_search: bpp/providers[${i}]/categories[${j}] timing ${item.code} must be HHMM 24hr format`
                );
              } else {
                testResults.passed.push(
                  `on_search: bpp/providers[${i}]/categories[${j}] timing ${item.code} is valid HHMM format`
                );
              }
            }
          });
        }
      });
    });

    // Items: duplicate ids, fulfillment_id mapping, descriptor code, price/quantity sanity
    const fulfillmentIds = new Set((provider.fulfillments || []).map((f: any) => f.id));
    (provider.items || []).forEach((item: any, j: number) => {
      if (itemIds.has(item.id)) {
        testResults.failed.push(`on_search: duplicate item id '${item.id}' in bpp/providers[${i}]`);
      } else {
        itemIds.add(item.id);
        testResults.passed.push(`on_search: item id '${item.id}' is unique in bpp/providers[${i}]`);
      }
      if (item.category_id) itemCategoryIds.add(item.category_id);

      if (item.fulfillment_id) {
        if (!fulfillmentIds.has(item.fulfillment_id)) {
          testResults.failed.push(
            `on_search: bpp/providers[${i}]/items[${j}]/fulfillment_id must map to a fulfillment id in bpp/providers[${i}]/fulfillments`
          );
        } else {
          testResults.passed.push(
            `on_search: bpp/providers[${i}]/items[${j}]/fulfillment_id maps to a valid fulfillment id`
          );
        }
      }

      if (!item.descriptor?.short_desc || !item.descriptor?.long_desc) {
        testResults.failed.push(
          `on_search: bpp/providers[${i}]/items[${j}]/descriptor short_desc and long_desc must not be empty`
        );
      } else {
        testResults.passed.push(
          `on_search: bpp/providers[${i}]/items[${j}]/descriptor short_desc and long_desc are present`
        );
      }

      if (item['@ondc/org/contact_details_consumer_care']) {
        const parts = String(item['@ondc/org/contact_details_consumer_care']).split(",");
        if (parts.length < 3) {
          testResults.failed.push(
            `on_search: bpp/providers[${i}]/items[${j}] @ondc/org/contact_details_consumer_care must be "name,email,phone"`
          );
        } else {
          testResults.passed.push(
            `on_search: bpp/providers[${i}]/items[${j}] @ondc/org/contact_details_consumer_care has 3 comma-separated parts`
          );
          if (!isValidPhoneNumber(parts[2]?.trim())) {
            testResults.failed.push(
              `on_search: bpp/providers[${i}]/items[${j}] consumer-care phone number must be 10 or 11 digits`
            );
          } else {
            testResults.passed.push(
              `on_search: bpp/providers[${i}]/items[${j}] consumer-care phone number is valid`
            );
          }
          if (!emailRegex(parts[1]?.trim())) {
            testResults.failed.push(
              `on_search: bpp/providers[${i}]/items[${j}] consumer-care email is not a valid email address`
            );
          } else {
            testResults.passed.push(
              `on_search: bpp/providers[${i}]/items[${j}] consumer-care email is valid`
            );
          }
        }
      }

      if (item.price?.value) {
        const priceValue = parseFloat(item.price.value);
        if (priceValue < 1) {
          testResults.failed.push(`on_search: bpp/providers[${i}]/items[${j}] price.value must be greater than 0`);
        } else {
          testResults.passed.push(`on_search: bpp/providers[${i}]/items[${j}] price.value is greater than 0`);
        }
        if (item.price.maximum_value) {
          if (priceValue > parseFloat(item.price.maximum_value)) {
            testResults.failed.push(
              `on_search: bpp/providers[${i}]/items[${j}] price.value cannot exceed price.maximum_value`
            );
          } else {
            testResults.passed.push(
              `on_search: bpp/providers[${i}]/items[${j}] price.value does not exceed price.maximum_value`
            );
          }
        }
      }

      if (item.quantity?.available?.count && item.quantity?.maximum?.count) {
        const availCount = parseInt(item.quantity.available.count, 10);
        const maxCount = parseInt(item.quantity.maximum.count, 10);
        if (availCount < 0 || maxCount < 0) {
          testResults.failed.push(
            `on_search: bpp/providers[${i}]/items[${j}] quantity available/maximum count must be >= 0`
          );
        } else {
          testResults.passed.push(
            `on_search: bpp/providers[${i}]/items[${j}] quantity available/maximum count is >= 0`
          );
        }
        if (availCount === 99) {
          if (maxCount === 0) {
            testResults.failed.push(
              `on_search: bpp/providers[${i}]/items[${j}] quantity.maximum.count cannot be 0 while item is marked in-stock (available.count 99)`
            );
          } else {
            testResults.passed.push(
              `on_search: bpp/providers[${i}]/items[${j}] quantity.maximum.count is non-zero while in-stock`
            );
          }
        }
      }
    });

    // Domain-specific mandatory category/attribute tags, and (RET10 only,
    // matching the original source's own gating) statutory-requirement
    // field completeness for prepackaged-food / packaged-commodity items.
    const domainCode = context?.domain?.split(":")?.[1];
    const categoryTable = domainCode ? CATEGORY_TABLES[domainCode] : undefined;
    if (categoryTable) {
      const beforeCount = testResults.failed.length;
      checkMandatoryTags(i, provider.items || [], testResults.failed, categoryTable.json, categoryTable.label);
      if (testResults.failed.length === beforeCount) {
        testResults.passed.push(
          `on_search: bpp/providers[${i}] mandatory category/attribute tags (${categoryTable.label}) are present`
        );
      }
    }
    if (domainCode === "RET10") {
      (provider.items || []).forEach((item: any, j: number) => {
        if (!item?.category_id) return;
        const requirement = getStatutoryRequirement(item.category_id);
        if (requirement === statutory_reqs.PrepackagedFood || requirement === statutory_reqs.PackagedCommodities) {
          const beforeCount = testResults.failed.length;
          checkForStatutory(item, i, j, testResults.failed, requirement);
          if (testResults.failed.length === beforeCount) {
            testResults.passed.push(
              `on_search: bpp/providers[${i}]/items[${j}] statutory requirement fields are complete`
            );
          }
        } else if (requirement !== statutory_reqs.None && requirement !== undefined) {
          testResults.failed.push(
            `on_search: bpp/providers[${i}]/items[${j}] has a category_id (${item.category_id}) with no recognized statutory requirement mapping`
          );
        }
      });
    }

    // Offer structural validation, by offer type.
    (provider.offers || []).forEach((offer: any, oi: number) => {
      const tags = offer.tags;
      if (!Array.isArray(tags)) {
        testResults.failed.push(`on_search: bpp/providers[${i}]/offers[${oi}] must have a tags array`);
        return;
      }
      const findList = (code: string) => tags.find((t: any) => t.code === code);
      const hasListCode = (tag: any, code: string) => tag?.list?.some((it: any) => it.code === code);

      switch (offer.descriptor?.code) {
        case "discount": {
          const qualifier = findList("qualifier");
          if (!qualifier || !hasListCode(qualifier, "min_value")) {
            testResults.failed.push(`on_search: offers[${oi}] (discount) qualifier must include min_value`);
          } else {
            testResults.passed.push(`on_search: offers[${oi}] (discount) qualifier includes min_value`);
          }
          const benefit = findList("benefit");
          if (!benefit || !hasListCode(benefit, "value") || !hasListCode(benefit, "value_type")) {
            testResults.failed.push(`on_search: offers[${oi}] (discount) benefit must include value and value_type`);
          } else {
            testResults.passed.push(`on_search: offers[${oi}] (discount) benefit includes value and value_type`);
          }
          break;
        }
        case "buyXgetY": {
          const qualifier = findList("qualifier");
          if (!qualifier || !hasListCode(qualifier, "min_value") || !hasListCode(qualifier, "item_count")) {
            testResults.failed.push(`on_search: offers[${oi}] (buyXgetY) qualifier must include min_value and item_count`);
          } else {
            testResults.passed.push(`on_search: offers[${oi}] (buyXgetY) qualifier includes min_value and item_count`);
          }
          const benefit = findList("benefit");
          if (!benefit || !hasListCode(benefit, "item_count")) {
            testResults.failed.push(`on_search: offers[${oi}] (buyXgetY) benefit must include item_count`);
          } else {
            testResults.passed.push(`on_search: offers[${oi}] (buyXgetY) benefit includes item_count`);
          }
          break;
        }
        case "freebie": {
          const benefit = findList("benefit");
          if (
            !benefit ||
            !hasListCode(benefit, "item_count") ||
            !hasListCode(benefit, "item_id") ||
            !hasListCode(benefit, "item_value")
          ) {
            testResults.failed.push(
              `on_search: offers[${oi}] (freebie) benefit must include item_count, item_id and item_value`
            );
          } else {
            testResults.passed.push(
              `on_search: offers[${oi}] (freebie) benefit includes item_count, item_id and item_value`
            );
          }
          break;
        }
        case "slab":
        case "combo":
        case "delivery": {
          const benefit = findList("benefit");
          if (
            !benefit ||
            !hasListCode(benefit, "value") ||
            !hasListCode(benefit, "value_type") ||
            !hasListCode(benefit, "value_cap")
          ) {
            testResults.failed.push(
              `on_search: offers[${oi}] (${offer.descriptor.code}) benefit must include value, value_type and value_cap`
            );
          } else {
            testResults.passed.push(
              `on_search: offers[${oi}] (${offer.descriptor.code}) benefit includes value, value_type and value_cap`
            );
          }
          break;
        }
      }
    });

    // Serviceability construct: mandatory per category, structural shape per type.
    const tags = provider.tags;
    if (!tags || !tags.length) {
      testResults.failed.push(`on_search: bpp/providers[${i}]/tags (serviceability) must be present`);
    } else {
      const serviceabilityEntries = tags.filter((t: any) => t.code === "serviceability");
      if (serviceabilityEntries.length === 0) {
        testResults.failed.push(`on_search: bpp/providers[${i}]/tags must include a serviceability construct`);
      } else {
        testResults.passed.push(`on_search: bpp/providers[${i}]/tags includes a serviceability construct`);
      }
      serviceabilityEntries.forEach((sc: any, t: number) => {
        const list = sc.list || [];
        const location = list.find((e: any) => e.code === "location");
        const categoryTag = list.find((e: any) => e.code === "category");
        const type = list.find((e: any) => e.code === "type");
        if (!location?.value || !providerLocationIds.has(location.value)) {
          testResults.failed.push(
            `on_search: bpp/providers[${i}]/tags[${t}] serviceability location must reference a valid provider location id`
          );
        } else {
          testResults.passed.push(
            `on_search: bpp/providers[${i}]/tags[${t}] serviceability location references a valid provider location id`
          );
        }
        if (!categoryTag?.value || !itemCategoryIds.has(categoryTag.value)) {
          testResults.failed.push(
            `on_search: bpp/providers[${i}]/tags[${t}] serviceability category must reference a valid item category_id`
          );
        } else {
          testResults.passed.push(
            `on_search: bpp/providers[${i}]/tags[${t}] serviceability category references a valid item category_id`
          );
        }
        if (!type?.value || !["10", "11", "12"].includes(type.value)) {
          testResults.failed.push(
            `on_search: bpp/providers[${i}]/tags[${t}] serviceability type must be one of 10 (hyperlocal)/11 (intercity)/12 (PAN India)`
          );
        } else {
          testResults.passed.push(
            `on_search: bpp/providers[${i}]/tags[${t}] serviceability type '${type.value}' is valid`
          );
        }
      });
    }

    i; // (loop index already used above for messages)
  });
  });

  // Cross-action state for this action is persisted by the wiring layer's
  // saveFromElement call (src/config/save-specs/RET10/1.2.5/on_search.yaml:
  // context, providers as full objects) — select/on_select read full
  // provider objects from this, not narrow id lists, so this file no longer
  // duplicates that save here.

  addDefaultValidationMessage(testResults, action);
  return testResults;
}
