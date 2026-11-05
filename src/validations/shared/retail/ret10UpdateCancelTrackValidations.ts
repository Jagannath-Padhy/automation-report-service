import { Payload, TestResult } from "../../../types/payload";
import { createBaseValidationSetup, addDefaultValidationMessage, tagLayer } from "../commonValidations";
import { runExternalSchemaAndL1Validation } from "../externalSchemaValidator";
import { getActionData } from "../../../services/actionDataService";
import { isValidCancellationReasonId } from "./cancellationReasonCodes";
import { RET10_FULFILLMENT_TYPES, isRecognizedFulfillmentType, findPrimaryFulfillment } from "./fulfillmentTypes";
import { checkProviderCredsConsistency } from "./credsValidation";

// Reason-code tables ported from log-validation-utility/constants/reasonCode.ts
// and constants/index.ts (values copied verbatim, source retained as comments).
const BUYER_RETURN_REASON_IDS = new Set(["001", "002", "003", "004", "005"]); // buyerReturnId
const BUYER_CANCELLATION_REASON_IDS = new Set(["051", "052", "053", "999", "010"]); // buyerCancellationRid
const RETURN_REQUEST_REASON_CODES = ["001", "002", "003", "004", "005"]; // return_request_reasonCodes
const PARTCANCEL_RETURN_REASON_CODES = ["002", "012"]; // partcancel_return_reasonCodes
const RETURN_REJECTED_REQUEST_REASON_CODES = ["001", "002", "003", "004", "005", "007", "008"]; // return_rejected_request_reasonCodes
const CONDITION_IDS = ["001", "002", "003"]; // condition_id (item condition for exchange)

const VALID_ORDER_STATES = new Set(["Created", "Accepted", "In-progress", "Completed", "Cancelled"]);

// BNP/SNP cancellation reason-code validation (mapCancellationID) now lives in
// the shared ./cancellationReasonCodes — also used by ret10StatusValidations.ts
// (RTO-delivered status) — so both call sites stay in sync with one table.

/**
 * quote_trail tag check, ported from log-validation-utility's checkQuoteTrail:
 * validates the `type` enum and, for type=item entries, that the deducted value
 * matches the item's price in the prior /on_select quote.
 */
function checkQuoteTrailTags(
  fulfillment: any,
  label: string,
  onSelectPriceMap: Map<string, number> | undefined,
  onSelectItemIds: Set<string> | undefined,
  testResults: TestResult
): void {
  const quoteTrailTags = (fulfillment?.tags || []).filter((t: any) => t?.code === "quote_trail");
  if (quoteTrailTags.length === 0) {
    testResults.failed.push(`${label}: fulfillment "${fulfillment?.id}" is missing a quote_trail tag`);
    return;
  }
  testResults.passed.push(`${label}: fulfillment "${fulfillment?.id}" has a quote_trail tag`);
  const validTypes = ["misc", "packing", "delivery", "tax", "item"];
  for (const tag of quoteTrailTags) {
    const type = tagListValue(tag, "type");
    const itemId = tagListValue(tag, "id");
    const value = tagListValue(tag, "value");
    if (type && !validTypes.includes(type)) {
      testResults.failed.push(`${label}: quote_trail type "${type}" is invalid — allowed: ${validTypes.join(", ")}`);
    } else if (type) {
      testResults.passed.push(`${label}: quote_trail type "${type}" is valid`);
    }
    if (type === "item" && itemId) {
      if (onSelectItemIds && !onSelectItemIds.has(itemId)) {
        testResults.failed.push(`${label}: quote_trail item id "${itemId}" not present in /on_select items`);
      } else if (onSelectItemIds) {
        testResults.passed.push(`${label}: quote_trail item id "${itemId}" present in /on_select items`);
      }
      const expectedPrice = onSelectPriceMap?.get(itemId);
      if (expectedPrice !== undefined && value !== undefined) {
        if (Math.abs(Number(value)) !== expectedPrice) {
          testResults.failed.push(
            `${label}: quote_trail value for item "${itemId}" (${value}) does not match its /on_select quote price (${expectedPrice})`
          );
        } else {
          testResults.passed.push(`${label}: quote_trail value for item "${itemId}" matches its /on_select quote price`);
        }
      }
    }
  }
}

/** Builds {itemId -> price} and the set of item ids from a saved /on_select's quote.breakup. */
function buildOnSelectPriceMap(priorOnSelect: any): { priceMap: Map<string, number>; itemIds: Set<string> } | undefined {
  const breakup = priorOnSelect?.quote?.breakup;
  if (!Array.isArray(breakup)) return undefined;
  const priceMap = new Map<string, number>();
  for (const line of breakup) {
    if (line?.["@ondc/org/item_id"] && line?.price?.value !== undefined) {
      priceMap.set(line["@ondc/org/item_id"], Number(line.price.value));
    }
  }
  const itemIds = new Set<string>((priorOnSelect?.items || []).map((it: any) => it?.id).filter(Boolean));
  return { priceMap, itemIds };
}

function isYesNo(value: any): boolean {
  return value === "yes" || value === "no";
}

function isValidUrl(value: any): boolean {
  if (typeof value !== "string") return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** Sum of quote.breakup[].price.value should equal quote.price.value (rounded). Ported from sumQuoteBreakUp. */
function quoteBreakupSumsCorrectly(quote: any): boolean {
  if (!quote?.price?.value || !Array.isArray(quote?.breakup)) return false;
  const total = Number(quote.price.value);
  const sum = quote.breakup.reduce((acc: number, item: any) => acc + Number(item?.price?.value || 0), 0);
  return Math.round(total) === Math.round(sum);
}

function findTag(tags: any[] | undefined, code: string): any {
  return (tags || []).find((t: any) => t?.code === code);
}

function tagListValue(tag: any, code: string): string | undefined {
  return (tag?.list || []).find((e: any) => e?.code === code)?.value;
}

async function tryGetActionData(
  sessionID: string,
  flowId: string,
  transactionId: string | undefined,
  action: string
): Promise<Record<string, any> | null> {
  if (!transactionId) return null;
  try {
    return await getActionData(sessionID, flowId, transactionId, action);
  } catch {
    return null;
  }
}

export async function validateRet10Update(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const { testResults, jsonRequest, context, message, action } = createBaseValidationSetup(element);
  await runExternalSchemaAndL1Validation(jsonRequest, testResults);

  try {
    const order = message?.order;
    const fulfillments = order?.fulfillments || [];

    const priorSelect = await tryGetActionData(sessionID, flowId, context?.transaction_id, "select");
    const priorSelectItemIds: string[] | undefined = priorSelect?.item_ids;

    // return_request tags only appear in Return_Flow/Buyer_Initiated_Return
    // scenarios — flow-specific, not applicable to every /update call.
    tagLayer(testResults, "L3", () => {
      for (const fulfillment of fulfillments) {
        const returnRequest = findTag(fulfillment?.tags, "return_request");
        if (!returnRequest) continue;
        const list = returnRequest.list || [];

        const itemIdEntry = list.find((e: any) => e.code === "item_id");
        if (itemIdEntry?.value && priorSelectItemIds && !priorSelectItemIds.includes(itemIdEntry.value)) {
          testResults.failed.push(
            `update: return_request item_id "${itemIdEntry.value}" was not present in the prior /select item list`
          );
        } else if (itemIdEntry?.value) {
          testResults.passed.push(`update: return_request item_id "${itemIdEntry.value}" validated`);
        }

        const reasonIdEntry = list.find((e: any) => e.code === "reason_id");
        if (reasonIdEntry?.value && !BUYER_RETURN_REASON_IDS.has(reasonIdEntry.value)) {
          testResults.failed.push(
            `update: return_request reason_id "${reasonIdEntry.value}" is not a valid buyer-initiated return reason id`
          );
        } else if (reasonIdEntry?.value) {
          testResults.passed.push(`update: return_request reason_id "${reasonIdEntry.value}" is a valid buyer-initiated return reason id`);
        }

        const exchangeEntry = list.find((e: any) => e.code === "exchange");
        if (exchangeEntry?.value !== undefined) {
          if (!isYesNo(exchangeEntry.value)) {
            testResults.failed.push(`update: return_request exchange value "${exchangeEntry.value}" must be "yes" or "no"`);
          } else if (exchangeEntry.value === "yes") {
            testResults.passed.push(`update: return_request exchange value "${exchangeEntry.value}" is "yes" or "no"`);
            const conditionIdEntry = list.find((e: any) => e.code === "condition_id");
            if (!conditionIdEntry?.value) {
              testResults.failed.push(`update: condition_id is required in return_request when exchange="yes"`);
            } else if (!CONDITION_IDS.includes(conditionIdEntry.value)) {
              testResults.failed.push(
                `update: condition_id "${conditionIdEntry.value}" invalid — must be one of ${CONDITION_IDS.join(", ")}`
              );
            } else {
              testResults.passed.push(`update: condition_id "${conditionIdEntry.value}" is valid`);
            }
            const conditionDescEntry = list.find((e: any) => e.code === "condition_desc");
            if (!conditionDescEntry?.value) {
              testResults.failed.push(`update: condition_desc is required in return_request when exchange="yes"`);
            } else {
              testResults.passed.push(`update: condition_desc is present in return_request`);
            }
          } else {
            testResults.passed.push(`update: return_request exchange value "${exchangeEntry.value}" is "yes" or "no"`);
          }
        }

        const replaceEntry = list.find((e: any) => e.code === "replace");
        if (replaceEntry?.value !== undefined) {
          if (!isYesNo(replaceEntry.value)) {
            testResults.failed.push(`update: return_request replace value "${replaceEntry.value}" must be "yes" or "no"`);
          } else {
            testResults.passed.push(`update: return_request replace value "${replaceEntry.value}" is "yes" or "no"`);
          }
        }

        const imagesEntry = list.find((e: any) => e.code === "images");
        if (imagesEntry?.value !== undefined) {
          const images = Array.isArray(imagesEntry.value) ? imagesEntry.value : [imagesEntry.value];
          const allValid = images.every((img: any) => isValidUrl(img));
          if (!allValid) {
            testResults.failed.push(`update: return_request images must each be a valid URL`);
          } else {
            testResults.passed.push(`update: return_request images are all valid URLs`);
          }
        }
      }
    });

    if (fulfillments.length && !fulfillments.some((f: any) => f?.tags?.length)) {
      // No return/cancel request tags at all on any fulfillment — update_target presence is
      // already covered by L1/JVAL schema rules, nothing further to add here.
    }
  } catch (e: any) {
    testResults.failed.push(`update: custom validation error — ${e?.message || e}`);
  }

  addDefaultValidationMessage(testResults, action);
  return testResults;
}

export async function validateRet10OnUpdate(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const { testResults, jsonRequest, context, message, action } = createBaseValidationSetup(element);
  await runExternalSchemaAndL1Validation(jsonRequest, testResults);

  try {
    const order = message?.order;
    if (!order) return testResults;

    tagLayer(testResults, "L2", () => {
      if (order.quote && !quoteBreakupSumsCorrectly(order.quote)) {
        testResults.failed.push("on_update: quote.breakup prices do not sum to quote.price.value");
      } else if (order.quote) {
        testResults.passed.push("on_update: quote breakup sum matches quote.price.value");
      }

      const settlementDetails = order?.payment?.["@ondc/org/settlement_details"];
      if (!settlementDetails || settlementDetails.length === 0) {
        testResults.failed.push("on_update: payment.@ondc/org/settlement_details is missing or empty");
      } else {
        testResults.passed.push("on_update: payment.@ondc/org/settlement_details is present");
        for (const detail of settlementDetails) {
          if (detail?.settlement_type === "upi" && detail?.settlement_counterparty === "seller-app" && !detail?.upi_address) {
            testResults.failed.push("on_update: upi_address is required when settlement_type=upi and settlement_counterparty=seller-app");
          } else if (detail?.settlement_type === "upi" && detail?.settlement_counterparty === "seller-app") {
            testResults.passed.push("on_update: upi_address is present for settlement_type=upi, settlement_counterparty=seller-app");
          }
        }
      }
    });

    const priorSelect = await tryGetActionData(sessionID, flowId, context?.transaction_id, "select");
    const priorSelectItemIds: string[] | undefined = priorSelect?.item_ids;
    const onSearchDataForUpdate = await tryGetActionData(sessionID, flowId, context?.transaction_id, "on_search");
    tagLayer(testResults, "L2", () =>
      checkProviderCredsConsistency(order, onSearchDataForUpdate, flowId, "on_update", testResults)
    );
    const items = order.items || [];
    const seenItemKeys = new Set<string>();
    tagLayer(testResults, "L2", () => {
      for (const item of items) {
        const key = JSON.stringify(item);
        if (seenItemKeys.has(key)) {
          testResults.failed.push(`on_update: duplicate item entry found for item id "${item?.id}"`);
        } else {
          seenItemKeys.add(key);
          testResults.passed.push(`on_update: item id "${item?.id}" is not a duplicate entry`);
        }
        if (priorSelectItemIds && item?.id) {
          if (!priorSelectItemIds.includes(item.id)) {
            testResults.failed.push(`on_update: item id "${item.id}" was not present in the prior /select item list`);
          } else {
            testResults.passed.push(`on_update: item id "${item.id}" was present in the prior /select item list`);
          }
        }
      }

      const deliveryFulfillment = findPrimaryFulfillment(order);
      if (!deliveryFulfillment) {
        testResults.failed.push(`on_update: a fulfillment with a recognized type (${RET10_FULFILLMENT_TYPES.join("/")}) is mandatory`);
      } else if (!deliveryFulfillment.start?.location?.id) {
        testResults.failed.push("on_update: fulfillment start.location.id is missing");
      } else {
        testResults.passed.push("on_update: a fulfillment with start.location.id is present");
      }

      // order.state enum validity. (Simplification: the original also tracks that
      // state never regresses across successive /on_update calls for the same
      // transaction — that needs a persisted "last state" which this service
      // doesn't currently save for on_update; only the enum check is ported here.)
      if (order.state) {
        if (!VALID_ORDER_STATES.has(order.state)) {
          testResults.failed.push(
            `on_update: order.state "${order.state}" is not a valid state — allowed: ${Array.from(VALID_ORDER_STATES).join(", ")}`
          );
        } else {
          testResults.passed.push(`on_update: order.state "${order.state}" is a valid state`);
        }
      }
    });

    // Return fulfillment completeness, ported from log-validation-utility's
    // onUpdate.ts Return-fulfillment block. Flow-specific: only Return_Flow/
    // Buyer_Initiated_Return scenarios carry a Return-type fulfillment.
    //
    // All of this is checkable from this single on_update payload's own
    // Return fulfillment, with no other message or session state consulted,
    // and none of it judges a whole-transaction/lifecycle outcome — so none
    // of it is L3 (reserved for end-to-end/outcome-level checks like "a
    // return must terminate in one of its defined outcomes") — previously
    // mistagged L3 as a block. Within that, plain field-presence/format
    // checks (required field present, timestamp parses, start<end ordering)
    // are L1 per the methodology. The two checks that instead rely on a
    // domain-knowledge inference rather than pure schema/structure — that a
    // Return's start.location has no stable id because it's the buyer's own
    // address, and that the pickup window must be scheduled after "now" —
    // are L2, not L1, since L1 is schema-shape only.
    const returnFulfillment = (order.fulfillments || []).find((f: any) => f?.type === "Return");
    if (returnFulfillment) {
      {
        if (!returnFulfillment.end?.location) {
          testResults.failed.push("on_update: Return fulfillment end.location is missing");
        } else {
          testResults.passed.push("on_update: Return fulfillment end.location is present");
        }
        // Return fulfillment's start.location.id is NOT expected to be present
        // (the pickup point is the buyer's own location, which has no stable id).
        tagLayer(testResults, "L2", () => {
          if (returnFulfillment.start?.location?.id) {
            testResults.failed.push("on_update: Return fulfillment start.location.id should not be present");
          } else {
            testResults.passed.push("on_update: Return fulfillment start.location.id is correctly absent");
          }
        });
        const timeRange = returnFulfillment.start?.time?.range;
        if (!timeRange) {
          testResults.failed.push("on_update: Return fulfillment start.time.range is missing");
        } else {
          const startTime = new Date(timeRange.start);
          const endTime = new Date(timeRange.end);
          const contextTime = context?.timestamp ? new Date(context.timestamp) : null;
          if (isNaN(startTime.getTime())) {
            testResults.failed.push("on_update: Return fulfillment start.time.range.start is not a valid timestamp");
          } else {
            testResults.passed.push("on_update: Return fulfillment start.time.range.start is a valid timestamp");
          }
          if (isNaN(endTime.getTime())) {
            testResults.failed.push("on_update: Return fulfillment start.time.range.end is not a valid timestamp");
          } else {
            testResults.passed.push("on_update: Return fulfillment start.time.range.end is a valid timestamp");
          }
          if (!isNaN(startTime.getTime()) && !isNaN(endTime.getTime()) && startTime.getTime() >= endTime.getTime()) {
            testResults.failed.push("on_update: Return fulfillment start.time.range.start should be before start.time.range.end");
          } else if (!isNaN(startTime.getTime()) && !isNaN(endTime.getTime())) {
            testResults.passed.push("on_update: Return fulfillment start.time.range.start is before start.time.range.end");
          }
          tagLayer(testResults, "L2", () => {
            if (contextTime && !isNaN(startTime.getTime()) && startTime.getTime() <= contextTime.getTime()) {
              testResults.failed.push("on_update: Return fulfillment start.time.range.start should be after context.timestamp");
            } else if (contextTime && !isNaN(startTime.getTime())) {
              testResults.passed.push("on_update: Return fulfillment start.time.range.start is after context.timestamp");
            }
          });
        }
      }
    }

    // quote_trail reconciliation on the Cancel fulfillment, ported from
    // log-validation-utility's checkQuoteTrail — cross-checked against the
    // prior /on_select quote when available. Flow-specific: only cancellation
    // scenarios carry a Cancel-type fulfillment with quote_trail tags.
    const cancelFulfillmentForQuoteTrail = (order.fulfillments || []).find((f: any) => f?.type === "Cancel");
    if (cancelFulfillmentForQuoteTrail) {
      const priorOnSelectForQuote = await tryGetActionData(sessionID, flowId, context?.transaction_id, "on_select");
      const built = buildOnSelectPriceMap(priorOnSelectForQuote);
      tagLayer(testResults, "L3", () => {
        checkQuoteTrailTags(cancelFulfillmentForQuoteTrail, "on_update", built?.priceMap, built?.itemIds, testResults);
      });
    }

    for (const fulfillment of order.fulfillments || []) {
      tagLayer(testResults, "L2", () => {
        if (!fulfillment?.id) testResults.failed.push("on_update: a fulfillment is missing its id");
        else testResults.passed.push(`on_update: fulfillment "${fulfillment.id}" has an id`);
        if (!fulfillment?.type) testResults.failed.push("on_update: a fulfillment is missing its type");
        else testResults.passed.push(`on_update: fulfillment "${fulfillment?.id}" has a type`);
      });

      const cancelRequest = findTag(fulfillment?.tags, "cancel_request");
      const returnRequest = findTag(fulfillment?.tags, "return_request");

      if (fulfillment?.type === "Cancel" && cancelRequest) {
        tagLayer(testResults, "L3", () => {
          const initiatedBy = tagListValue(cancelRequest, "initiated_by");
          if (!initiatedBy) {
            testResults.failed.push("on_update: cancel_request is missing initiated_by in fulfillment.tags");
          } else if (initiatedBy !== context?.bpp_id) {
            testResults.failed.push(`on_update: cancel_request initiated_by should be ${context?.bpp_id}`);
          } else {
            testResults.passed.push(`on_update: cancel_request initiated_by is ${context?.bpp_id}`);
            const reasonId = tagListValue(cancelRequest, "reason_id");
            if (reasonId && !PARTCANCEL_RETURN_REASON_CODES.includes(reasonId)) {
              testResults.failed.push(
                `on_update: cancel_request reason_id "${reasonId}" invalid — allowed: ${PARTCANCEL_RETURN_REASON_CODES.join(", ")}`
              );
            } else if (reasonId) {
              testResults.passed.push(`on_update: cancel_request reason_id "${reasonId}" is valid`);
            }
          }
        });
      }

      if (fulfillment?.type === "Return" && returnRequest) {
        tagLayer(testResults, "L3", () => {
          const initiatedBy = tagListValue(returnRequest, "initiated_by");
          const reasonId = tagListValue(returnRequest, "reason_id");
          if (!initiatedBy) {
            testResults.failed.push("on_update: return_request is missing initiated_by in fulfillment.tags");
          } else if (initiatedBy === context?.bap_id && reasonId) {
            // Buyer-initiated return — could be a fresh return request or a rejection response;
            // accept either reason-code table since we can't always distinguish from this payload alone.
            const validInEitherTable =
              RETURN_REQUEST_REASON_CODES.includes(reasonId) || RETURN_REJECTED_REQUEST_REASON_CODES.includes(reasonId);
            if (!validInEitherTable) {
              testResults.failed.push(
                `on_update: return_request reason_id "${reasonId}" not found in known return reason-code tables`
              );
            } else {
              testResults.passed.push(`on_update: return_request reason_id "${reasonId}" found in a known return reason-code table`);
            }
          } else {
            testResults.passed.push("on_update: return_request has initiated_by in fulfillment.tags");
          }
        });
      }

      if (fulfillment?.type !== "Return" && fulfillment?.type !== "Cancel" && fulfillment?.tracking !== undefined) {
        tagLayer(testResults, "L2", () => {
          if (typeof fulfillment.tracking !== "boolean") {
            testResults.failed.push(`on_update: fulfillment "${fulfillment?.id}" tracking must be boolean when present`);
          } else {
            testResults.passed.push(`on_update: fulfillment "${fulfillment?.id}" tracking is boolean`);
          }
        });
      }
    }

    if (order.provider?.id) {
      const priorOnSelect = await tryGetActionData(sessionID, flowId, context?.transaction_id, "on_select");
      tagLayer(testResults, "L2", () => {
        if (priorOnSelect?.provider_id && priorOnSelect.provider_id !== order.provider.id) {
          testResults.failed.push("on_update: provider.id mismatches the provider.id seen in /on_select");
        } else if (priorOnSelect?.provider_id) {
          testResults.passed.push("on_update: provider.id matches the provider.id seen in /on_select");
        }
      });
    }
  } catch (e: any) {
    testResults.failed.push(`on_update: custom validation error — ${e?.message || e}`);
  }

  addDefaultValidationMessage(testResults, action);
  return testResults;
}

export async function validateRet10Cancel(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const { testResults, jsonRequest, context, message, action } = createBaseValidationSetup(element);
  await runExternalSchemaAndL1Validation(jsonRequest, testResults);

  try {
    // Buyer-initiated cancellation reason-code validation — flow-specific to
    // cancellation scenarios.
    tagLayer(testResults, "L3", () => {
      const reasonId = message?.cancellation_reason_id;
      if (reasonId && !BUYER_CANCELLATION_REASON_IDS.has(reasonId)) {
        testResults.failed.push(
          `cancel: cancellation_reason_id "${reasonId}" is not a valid buyer-initiated cancellation reason id`
        );
      } else if (reasonId) {
        testResults.passed.push(`cancel: cancellation_reason_id "${reasonId}" is valid`);
      }
    });

    const priorConfirm = await tryGetActionData(sessionID, flowId, context?.transaction_id, "confirm");
    tagLayer(testResults, "L2", () => {
      if (priorConfirm?.order_id && message?.order_id) {
        if (priorConfirm.order_id !== message.order_id) {
          testResults.failed.push("cancel: order_id does not match the order_id from /confirm");
        } else {
          testResults.passed.push("cancel: order_id matches the order_id from /confirm");
        }
      }
    });
  } catch (e: any) {
    testResults.failed.push(`cancel: custom validation error — ${e?.message || e}`);
  }

  addDefaultValidationMessage(testResults, action);
  return testResults;
}

export async function validateRet10OnCancel(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const { testResults, jsonRequest, context, message, action } = createBaseValidationSetup(element);
  await runExternalSchemaAndL1Validation(jsonRequest, testResults);

  try {
    const order = message?.order;
    if (!order) return testResults;

    const priorSelect = await tryGetActionData(sessionID, flowId, context?.transaction_id, "select");
    const priorSelectItemIds: string[] | undefined = priorSelect?.item_ids;
    const priorConfirm = await tryGetActionData(sessionID, flowId, context?.transaction_id, "confirm");
    const priorOnSelect = await tryGetActionData(sessionID, flowId, context?.transaction_id, "on_select");
    const priorOnSearch = await tryGetActionData(sessionID, flowId, context?.transaction_id, "on_search");

    tagLayer(testResults, "L2", () => {
      checkProviderCredsConsistency(order, priorOnSearch, flowId, "on_cancel", testResults);
      if (order.quote && !quoteBreakupSumsCorrectly(order.quote)) {
        testResults.failed.push("on_cancel: quote.breakup prices do not sum to quote.price.value");
      } else if (order.quote) {
        testResults.passed.push("on_cancel: quote.breakup prices sum to quote.price.value");
      }

      if (priorSelectItemIds) {
        for (const item of order.items || []) {
          if (item?.id) {
            if (!priorSelectItemIds.includes(item.id)) {
              testResults.failed.push(`on_cancel: item id "${item.id}" was not present in the prior /select item list`);
            } else {
              testResults.passed.push(`on_cancel: item id "${item.id}" was present in the prior /select item list`);
            }
          }
        }
      }

      if (priorConfirm?.order_id && order.id) {
        if (priorConfirm.order_id !== order.id) {
          testResults.failed.push("on_cancel: order.id does not match the order_id from /confirm");
        } else {
          testResults.passed.push("on_cancel: order.id matches the order_id from /confirm");
        }
      }

      if (priorOnSelect?.provider_id && order.provider?.id) {
        if (priorOnSelect.provider_id !== order.provider.id) {
          testResults.failed.push("on_cancel: provider.id mismatches the provider.id seen in /on_select");
        } else {
          testResults.passed.push("on_cancel: provider.id matches the provider.id seen in /on_select");
        }
      }
    });

    const cancellation = order.cancellation;
    if (cancellation) {
      const cancelledBy = cancellation.cancelled_by;
      const reasonId = cancellation.reason?.id;
      tagLayer(testResults, "L2", () => {
        if (!reasonId) {
          testResults.failed.push("on_cancel: cancellation.reason.id is mandatory");
        } else {
          testResults.passed.push("on_cancel: cancellation.reason.id is present");
        }
        if (!cancelledBy) {
          testResults.failed.push("on_cancel: cancellation.cancelled_by is mandatory");
        } else {
          testResults.passed.push("on_cancel: cancellation.cancelled_by is present");
        }
      });

      // BNP/SNP reason-code mapping, ported from log-validation-utility's
      // mapCancellationID — flow-specific to cancellation scenarios.
      if (reasonId && cancelledBy) {
        tagLayer(testResults, "L3", () => {
          const role: "BNP" | "SNP" = cancelledBy === context?.bap_id ? "BNP" : "SNP";
          const version = context?.version || context?.core_version;
          if (!isValidCancellationReasonId(role, reasonId, version)) {
            testResults.failed.push(
              `on_cancel: cancellation reason_id "${reasonId}" is not a valid reason for cancelled_by=${role}`
            );
          } else {
            testResults.passed.push(`on_cancel: cancellation reason_id "${reasonId}" is valid for cancelled_by=${role}`);
          }
        });
      }
    } else {
      tagLayer(testResults, "L2", () => {
        testResults.failed.push("on_cancel: order.cancellation is missing");
      });
    }

    // RTO-vs-Delivery cross-check, ported from log-validation-utility's
    // onCancel.ts RTO flow — an RTO fulfillment should reference the same
    // location as the original Delivery fulfillment. Flow-specific to RTO
    // scenarios.
    const rtoFulfillmentForCrossCheck = (order.fulfillments || []).find((f: any) => f?.type === "RTO");
    if (rtoFulfillmentForCrossCheck) {
      tagLayer(testResults, "L3", () => {
        // No fallback here (unlike findPrimaryFulfillment) — this check must
        // genuinely fail when no forward fulfillment exists alongside the
        // RTO one, not silently fall back to the RTO fulfillment itself.
        const deliveryFulfillmentForCrossCheck = (order.fulfillments || []).find((f: any) =>
          isRecognizedFulfillmentType(f?.type)
        );
        if (!deliveryFulfillmentForCrossCheck) {
          testResults.failed.push("on_cancel: an RTO fulfillment is present but no matching forward fulfillment was found");
        } else {
          testResults.passed.push("on_cancel: an RTO fulfillment has a matching forward fulfillment");
          const rtoLocId = rtoFulfillmentForCrossCheck.end?.location?.id;
          const deliveryLocId = deliveryFulfillmentForCrossCheck.start?.location?.id ?? deliveryFulfillmentForCrossCheck.end?.location?.id;
          if (rtoLocId && deliveryLocId && rtoLocId !== deliveryLocId) {
            testResults.failed.push(
              `on_cancel: RTO fulfillment end.location.id (${rtoLocId}) does not match the original Delivery fulfillment's location (${deliveryLocId})`
            );
          } else if (rtoLocId && deliveryLocId) {
            testResults.passed.push("on_cancel: RTO fulfillment end.location.id matches the original Delivery fulfillment's location");
          }
        }
      });
    }

    // quote_trail reconciliation on Cancel/RTO fulfillments, ported from
    // log-validation-utility's checkQuoteTrail. The original gates this by
    // flow id (flow==='5' => RTO, else => Cancel) rather than by whether an
    // RTO fulfillment happens to be present — confirmed from a real RTO
    // on_cancel payload that carries BOTH a Cancel fulfillment (with the
    // real quote_trail tag) and an RTO fulfillment (with empty tags) side
    // by side. Prefer the Cancel-type fulfillment, where quote_trail
    // normally lives, and only fall back to RTO when no Cancel fulfillment
    // exists at all (the flow==='5' scenario, which has no separate Cancel
    // fulfillment to carry it instead).
    const cancelTypeFulfillmentsForQuoteTrail = (order.fulfillments || []).filter((f: any) => f?.type === "Cancel");
    const quoteTrailFulfillmentType = cancelTypeFulfillmentsForQuoteTrail.length > 0 ? "Cancel" : "RTO";
    const quoteTrailFulfillments = (order.fulfillments || []).filter((f: any) => f?.type === quoteTrailFulfillmentType);
    if (quoteTrailFulfillments.length > 0) {
      const built = buildOnSelectPriceMap(priorOnSelect);
      tagLayer(testResults, "L3", () => {
        for (const f of quoteTrailFulfillments) {
          checkQuoteTrailTags(f, "on_cancel", built?.priceMap, built?.itemIds, testResults);
        }
      });
    }

    // Generic cancel_request / precancel_state presence checks (L2) with an
    // RTO-specific rto_id requirement nested inside (L3).
    for (const fulfillment of order.fulfillments || []) {
      const cancelRequest = findTag(fulfillment?.tags, "cancel_request");
      if (cancelRequest) {
        tagLayer(testResults, "L2", () => {
          if (!tagListValue(cancelRequest, "reason_id")) {
            testResults.failed.push(`on_cancel: cancel_request on fulfillment "${fulfillment?.id}" is missing reason_id`);
          } else {
            testResults.passed.push(`on_cancel: cancel_request on fulfillment "${fulfillment?.id}" has reason_id`);
          }
          if (!tagListValue(cancelRequest, "initiated_by")) {
            testResults.failed.push(`on_cancel: cancel_request on fulfillment "${fulfillment?.id}" is missing initiated_by`);
          } else {
            testResults.passed.push(`on_cancel: cancel_request on fulfillment "${fulfillment?.id}" has initiated_by`);
          }
        });
        if (fulfillment?.type === "RTO") {
          tagLayer(testResults, "L3", () => {
            if (!tagListValue(cancelRequest, "rto_id")) {
              testResults.failed.push(`on_cancel: cancel_request on RTO fulfillment "${fulfillment?.id}" is missing rto_id`);
            } else {
              testResults.passed.push(`on_cancel: cancel_request on RTO fulfillment "${fulfillment?.id}" has rto_id`);
            }
          });
        }
      }
      const preCancel = findTag(fulfillment?.tags, "precancel_state");
      if (preCancel) {
        tagLayer(testResults, "L2", () => {
          if (!tagListValue(preCancel, "updated_at")) {
            testResults.failed.push(`on_cancel: precancel_state on fulfillment "${fulfillment?.id}" is missing updated_at`);
          } else {
            testResults.passed.push(`on_cancel: precancel_state on fulfillment "${fulfillment?.id}" has updated_at`);
          }
          if (!tagListValue(preCancel, "fulfillment_state")) {
            testResults.failed.push(`on_cancel: precancel_state on fulfillment "${fulfillment?.id}" is missing fulfillment_state`);
          } else {
            testResults.passed.push(`on_cancel: precancel_state on fulfillment "${fulfillment?.id}" has fulfillment_state`);
          }
        });
      }
    }
  } catch (e: any) {
    testResults.failed.push(`on_cancel: custom validation error — ${e?.message || e}`);
  }

  addDefaultValidationMessage(testResults, action);
  return testResults;
}

export async function validateRet10Track(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const { testResults, jsonRequest, message, action } = createBaseValidationSetup(element);
  await runExternalSchemaAndL1Validation(jsonRequest, testResults);

  try {
    tagLayer(testResults, "L2", () => {
      if (!message?.order_id) {
        testResults.failed.push("track: message.order_id is mandatory");
      } else {
        testResults.passed.push("track: message.order_id is present");
      }
    });
  } catch (e: any) {
    testResults.failed.push(`track: custom validation error — ${e?.message || e}`);
  }

  addDefaultValidationMessage(testResults, action);
  return testResults;
}

export async function validateRet10OnTrack(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const { testResults, jsonRequest, message, action } = createBaseValidationSetup(element);
  await runExternalSchemaAndL1Validation(jsonRequest, testResults);

  try {
    const tracking = message?.tracking;
    if (!tracking) {
      testResults.failed.push("on_track: message.tracking is mandatory");
      return testResults;
    }

    tagLayer(testResults, "L2", () => {
      if (tracking.status && !["active", "inactive"].includes(tracking.status)) {
        testResults.failed.push(`on_track: tracking.status "${tracking.status}" must be "active" or "inactive"`);
      } else if (tracking.status) {
        testResults.passed.push(`on_track: tracking.status "${tracking.status}" is "active" or "inactive"`);
      }

      const attr = tracking.attr;
      if (attr === "tracking.location.gps" && tracking.status === "active") {
        if (!tracking.location?.gps) {
          testResults.failed.push("on_track: tracking.location.gps is mandatory when attr=tracking.location.gps and status=active");
        } else {
          testResults.passed.push("on_track: tracking.location.gps is present for attr=tracking.location.gps and status=active");
        }
      }
      if (attr === "tracking.url" && tracking.status === "active") {
        if (!tracking.url) {
          testResults.failed.push("on_track: tracking.url is mandatory when attr=tracking.url and status=active");
        } else {
          testResults.passed.push("on_track: tracking.url is present for attr=tracking.url and status=active");
        }
      }
      if (tracking.status === "inactive") {
        if (tracking.location || tracking.url) {
          testResults.failed.push("on_track: location/url should not be populated while tracking.status=inactive");
        } else {
          testResults.passed.push("on_track: location/url are not populated while tracking.status=inactive");
        }
      }
    });
  } catch (e: any) {
    testResults.failed.push(`on_track: custom validation error — ${e?.message || e}`);
  }

  addDefaultValidationMessage(testResults, action);
  return testResults;
}
