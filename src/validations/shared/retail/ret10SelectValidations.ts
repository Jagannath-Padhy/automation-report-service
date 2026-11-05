import { Payload, TestResult } from "../../../types/payload";
import { createBaseValidationSetup, addDefaultValidationMessage, tagLayer } from "../commonValidations";
import { runExternalSchemaAndL1Validation } from "../externalSchemaValidator";
import {
  getActionData,
  compareSelectVsOnSearch,
} from "../../../services/actionDataService";

// ---------------------------------------------------------------------------
// Ported from log-validation-utility/utils/Retail/{Select,Select_OOS}/*.ts
// The AJV schema call (`validateSchema`) and pure format/shape checks already
// covered by the external L0+L1 call (runExternalSchemaAndL1Validation) have
// been stripped. Cross-action state (log-validation-utility's setValue/
// getValue DAO) has been rewired onto this service's actionDataService +
// save-specs (src/config/save-specs/ONDC:RET10/1.2.5/{select,on_search}.yaml).
//
// select and select_oos (log-validation-utility) turned out to be the same
// business logic on the request side — the OOS/non-OOS distinction only
// actually matters for on_select's response (presence of an error block),
// so select_oos's logic is not ported as a separate branch.
// ---------------------------------------------------------------------------

function isoDurToSec(duration?: string): number {
  if (!duration) return 0;
  const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(duration);
  if (!match) return 0;
  const [, d, h, m, s] = match;
  return (
    (Number(d) || 0) * 86400 +
    (Number(h) || 0) * 3600 +
    (Number(m) || 0) * 60 +
    (Number(s) || 0)
  );
}

function isGpsFormatValid(gps?: string): boolean {
  if (!gps || typeof gps !== "string") return false;
  const parts = gps.split(",");
  if (parts.length !== 2) return false;
  return parts.every((p) => !isNaN(parseFloat(p.trim())) && isFinite(Number(p.trim())));
}

function findProviderById(providers: any, providerId: string): any | null {
  const arr = Array.isArray(providers) ? providers : providers ? [providers] : [];
  return arr.find((p: any) => p?.id === providerId) || null;
}

const RETAIL_PAYMENT_TITLE_TYPES: Record<string, string> = {
  "delivery charges": "delivery",
  "packing charges": "packing",
  tax: "tax",
  discount: "discount",
  "convenience fee": "misc",
  offer: "offer",
};

export async function validateRet10Select(
  element: Payload,
  sessionID: string,
  flowId: string,
  _actionId: string
): Promise<TestResult> {
  const { testResults, action, jsonRequest, context, message } = createBaseValidationSetup(element);
  await runExternalSchemaAndL1Validation(jsonRequest, testResults);

  try {
    const select = message?.order;
    if (!select) {
      tagLayer(testResults, "L2", () => {
        testResults.failed.push("select: message.order is missing");
      });
      return testResults;
    }
    tagLayer(testResults, "L2", () => {
      testResults.passed.push("select: message.order is present");
    });

    const txnId = context?.transaction_id as string | undefined;
    const onSearchData = txnId
      ? await getActionData(sessionID, flowId, txnId, "on_search")
      : null;

    tagLayer(testResults, "L2", () => {
    // --- Provider existence (reuse the generic helper for the array-of-
    // providers case it already handles correctly) ---
    if (onSearchData) {
      const cmp = compareSelectVsOnSearch(message, onSearchData);
      // Only take the provider-existence verdict from this helper — its
      // item/fulfillment checks assume a single unwrapped provider object,
      // which doesn't hold for RET10's typical multi-provider catalogs.
      // We do our own provider-scoped item/fulfillment check below instead.
      const providerVerdict = cmp.failed.find((m) => m.includes("Provider"));
      if (providerVerdict) testResults.failed.push(providerVerdict);
      else testResults.passed.push("Provider exists in ON_SEARCH");
    }

    const provider = findProviderById(onSearchData?.providers, select?.provider?.id);

    if (!provider) {
      if (onSearchData) {
        // We have a catalog to check against, and this provider genuinely
        // isn't in it — a real failure.
        testResults.failed.push(
          `select: provider.id ${select?.provider?.id} does not exist in prior on_search`
        );
      } else {
        // No on_search recorded anywhere in this session (common for flows
        // that start at select — the discovery step, if any, ran under a
        // different transaction entirely). Nothing to cross-check against,
        // so skip rather than report a guaranteed false failure.
        testResults.passed.push(
          "select: no prior on_search data available in this session — skipping catalog cross-reference checks"
        );
      }
    } else {
      testResults.passed.push(`select: provider.id ${provider.id} exists in prior on_search`);

      // Provider disabled check
      if (provider?.time?.label === "disable") {
        testResults.failed.push(
          `select: provider ${provider.id} was disabled (time.label=disable) in on_search`
        );
      } else {
        testResults.passed.push(`select: provider ${provider.id} is not disabled in on_search`);
      }

      // Provider location id consistency
      const onSearchLocId = provider?.locations?.[0]?.id;
      const selectLocId = select?.provider?.locations?.[0]?.id;
      if (onSearchLocId && selectLocId && onSearchLocId !== selectLocId) {
        testResults.failed.push(
          `select: provider.locations[0].id mismatch between select (${selectLocId}) and on_search (${onSearchLocId})`
        );
      } else if (onSearchLocId && selectLocId) {
        testResults.passed.push(
          `select: provider.locations[0].id (${selectLocId}) matches on_search`
        );
      }

      // Items must exist in THIS provider's item list (provider-scoped,
      // correcting the generic helper's single-provider assumption)
      const providerItemIds: string[] = (provider?.items || []).map((it: any) => it?.id).filter(Boolean);
      const providerFulfillmentIds: string[] = (provider?.fulfillments || [])
        .map((f: any) => f?.id)
        .filter(Boolean);

      for (const item of select.items || []) {
        if (!providerItemIds.includes(item?.id)) {
          testResults.failed.push(
            `select: item ${item?.id} is not available for provider ${provider.id} in on_search`
          );
        } else {
          testResults.passed.push(`select: item ${item?.id} is available for provider ${provider.id} in on_search`);
        }
        if (item?.fulfillment_id && !providerFulfillmentIds.includes(item.fulfillment_id)) {
          testResults.failed.push(
            `select: item ${item?.id}'s fulfillment_id ${item.fulfillment_id} not found in provider ${provider.id}'s fulfillments`
          );
        } else if (item?.fulfillment_id) {
          testResults.passed.push(
            `select: item ${item?.id}'s fulfillment_id ${item.fulfillment_id} found in provider ${provider.id}'s fulfillments`
          );
        }
        // Disabled item check
        const searchItem = (provider?.items || []).find((it: any) => it?.id === item?.id);
        if (searchItem?.time?.label === "disable") {
          testResults.failed.push(`select: item ${item.id} is disabled and cannot be selected`);
        } else if (searchItem) {
          testResults.passed.push(`select: item ${item.id} is not disabled`);
        }
        // location_id consistency (skip customization sub-items)
        const tagsType = searchItem?.tags?.find((t: any) => t?.code === "type");
        const typeVal = tagsType?.list?.find((l: any) => l?.code === "type")?.value;
        const isCustomization = typeVal === "customization";
        if (searchItem && !isCustomization && searchItem.location_id !== item.location_id) {
          testResults.failed.push(
            `select: location_id mismatch for item ${item.id} vs on_search (${item.location_id} != ${searchItem.location_id})`
          );
        } else if (searchItem && !isCustomization) {
          testResults.passed.push(`select: location_id for item ${item.id} matches on_search`);
        }
      }

      // Customization parent id must map to a valid category id on the provider
      const categoryIds = new Set((provider?.categories || []).map((c: any) => c?.id));
      for (const item of select.items || []) {
        const customizationTag = item?.tags?.find(
          (t: any) =>
            t?.code === "type" && t?.list?.some((l: any) => l?.code === "type" && l?.value === "customization")
        );
        if (customizationTag) {
          const parentTag = item?.tags?.find(
            (t: any) =>
              t?.code === "parent" &&
              t?.list?.some((l: any) => l?.code === "id" && categoryIds.has(l?.value))
          );
          if (!parentTag) {
            testResults.failed.push(
              `select: customization item ${item.id}'s parent id is not one of on_search's category ids`
            );
          } else {
            testResults.passed.push(`select: customization item ${item.id}'s parent id is a valid on_search category id`);
          }
        }
      }
    }

    // GPS precision/format on fulfillment end location (own payload only)
    for (const ff of select.fulfillments || []) {
      if (ff?.end) {
        if (!isGpsFormatValid(ff.end?.location?.gps)) {
          testResults.failed.push("select: fulfillments[].end.location.gps is not a valid 'lat,lon' pair");
        } else {
          testResults.passed.push("select: fulfillments[].end.location.gps is a valid 'lat,lon' pair");
        }
        if (!ff.end?.location?.address?.area_code) {
          testResults.failed.push("select: fulfillments[].end.location.address.area_code is required");
        } else {
          testResults.passed.push("select: fulfillments[].end.location.address.area_code is present");
        }
      }
    }

    // Duplicate parent_item_id consistency: same item id must map to the same parent_item_id
    const seenParent: Record<string, string> = {};
    for (const item of select.items || []) {
      if (item?.id in seenParent) {
        if (seenParent[item.id] !== item.parent_item_id) {
          testResults.failed.push(
            `select: item ${item.id} has inconsistent parent_item_id across entries`
          );
        } else {
          testResults.passed.push(`select: item ${item.id}'s parent_item_id is consistent across entries`);
        }
      } else {
        seenParent[item.id] = item.parent_item_id;
      }
    }

    // Cross-action: city/timestamp/message_id consistency vs on_search
    if (onSearchData?.context) {
      // "*" is the wildcard city used for incremental catalog refresh
      // (search_inc_catalog) — it legitimately means "all cities", not a
      // specific one, so it can never equal a real "std:NNN" city and isn't
      // a mismatch when it's on either side of the comparison.
      if (onSearchData.context.city === "*" || context?.city === "*") {
        testResults.passed.push("select: context.city comparison skipped (on_search used the incremental-refresh wildcard city)");
      } else if (onSearchData.context.city !== context?.city) {
        testResults.failed.push("select: context.city mismatch vs on_search");
      } else {
        testResults.passed.push("select: context.city matches on_search");
      }
      if (onSearchData.context.timestamp && context?.timestamp && onSearchData.context.timestamp >= context.timestamp) {
        testResults.failed.push("select: context.timestamp must be after on_search's timestamp");
      } else if (onSearchData.context.timestamp && context?.timestamp) {
        testResults.passed.push("select: context.timestamp is after on_search's timestamp");
      }
      if (onSearchData.context.message_id === context?.message_id) {
        testResults.failed.push("select: context.message_id must differ from on_search's message_id");
      } else if (onSearchData.context.message_id && context?.message_id) {
        testResults.passed.push("select: context.message_id differs from on_search's message_id");
      }
    }
    });

    addDefaultValidationMessage(testResults, action);
  } catch (error: any) {
    testResults.failed.push(`select: validation error — ${error?.message || error}`);
  }

  return testResults;
}

export async function validateRet10OnSelect(
  element: Payload,
  sessionID: string,
  flowId: string,
  _actionId: string
): Promise<TestResult> {
  const { testResults, action, jsonRequest, context, message } = createBaseValidationSetup(element);
  await runExternalSchemaAndL1Validation(jsonRequest, testResults);

  try {
    const onSelect = message?.order;
    if (!onSelect) {
      tagLayer(testResults, "L2", () => {
        testResults.failed.push("on_select: message.order is missing");
      });
      return testResults;
    }
    tagLayer(testResults, "L2", () => {
      testResults.passed.push("on_select: message.order is present");
    });

    const txnId = context?.transaction_id as string | undefined;
    const selectData = txnId ? await getActionData(sessionID, flowId, txnId, "select") : null;
    const onSearchData = txnId ? await getActionData(sessionID, flowId, txnId, "on_search") : null;

    // Hoisted out of the tagLayer blocks below — referenced across several of
    // them, so must live in this function's scope, not inside one callback.
    const itemFulfillmentMap: Record<string, string> = {};
    let nonServiceableFlag = false;

    // OOS scenario detector: an on_select response representing an
    // out-of-stock outcome carries a top-level error block (e.g.
    // DOMAIN-ERROR 40002), unlike the normal happy-path response.
    const isOosScenario = Boolean(jsonRequest?.error);

    tagLayer(testResults, "L3", () => {
    if (isOosScenario) {
      if (!jsonRequest?.error?.code) {
        testResults.failed.push("on_select: OOS scenario detected but error.code is missing");
      } else {
        testResults.passed.push(`on_select: OOS scenario — error.code ${jsonRequest.error.code} present`);
      }
    }
    });

    tagLayer(testResults, "L2", () => {
    // Provider id/location consistency vs select
    if (selectData?.provider) {
      if (selectData.provider.id !== onSelect?.provider?.id) {
        testResults.failed.push("on_select: provider.id mismatch vs select");
      } else {
        testResults.passed.push("on_select: provider.id matches select");
      }
      const selectLocId = selectData.provider?.locations?.[0]?.id;
      const onSelectLocId = onSelect?.provider?.locations?.[0]?.id;
      if (!onSelect?.provider?.locations) {
        testResults.failed.push("on_select: provider.locations[0].id is missing");
      } else if (selectLocId && onSelectLocId && selectLocId !== onSelectLocId) {
        testResults.failed.push("on_select: provider.locations[0].id mismatch vs select");
      } else {
        testResults.passed.push("on_select: provider.locations[0].id matches select");
      }
    }

    // item -> fulfillment_id mapping must resolve
    for (const item of onSelect.items || []) {
      const found = (onSelect.fulfillments || []).some((f: any) => f?.id === item?.fulfillment_id);
      if (!found) {
        testResults.failed.push(
          `on_select: item ${item?.id}'s fulfillment_id ${item?.fulfillment_id} not found in order.fulfillments[]`
        );
      } else {
        testResults.passed.push(
          `on_select: item ${item?.id}'s fulfillment_id ${item?.fulfillment_id} found in order.fulfillments[]`
        );
      }
      itemFulfillmentMap[item?.id] = item?.fulfillment_id;
    }

    // Fulfillment state code must be Serviceable/Non-serviceable, and OOS error
    // must accompany a Non-serviceable fulfillment when one is present.
    for (const ff of onSelect.fulfillments || []) {
      if (!ff?.id) {
        testResults.failed.push("on_select: fulfillment.id must be present");
      } else {
        testResults.passed.push(`on_select: fulfillment ${ff.id} has id present`);
      }
      if (ff?.tracking !== true && ff?.tracking !== false) {
        testResults.failed.push(`on_select: fulfillment ${ff?.id} tracking must be a boolean`);
      } else {
        testResults.passed.push(`on_select: fulfillment ${ff?.id} tracking is a boolean`);
      }
      if (ff?.state) {
        const code = ff.state?.descriptor?.code;
        if (code === "Non-serviceable") nonServiceableFlag = true;
        if (code !== "Serviceable" && code !== "Non-serviceable") {
          testResults.failed.push(
            `on_select: fulfillment ${ff?.id} state.descriptor.code must be Serviceable/Non-serviceable, got ${code}`
          );
        } else {
          testResults.passed.push(`on_select: fulfillment ${ff?.id} state.descriptor.code is ${code}`);
        }
      } else {
        testResults.failed.push(`on_select: fulfillment ${ff?.id} is missing state.descriptor`);
      }
      if (!ff?.["@ondc/org/TAT"]) {
        testResults.failed.push(`on_select: fulfillment ${ff?.id} is missing @ondc/org/TAT`);
      } else {
        testResults.passed.push(`on_select: fulfillment ${ff?.id} has @ondc/org/TAT present`);
      }
    }
    });

    tagLayer(testResults, "L3", () => {
    if (nonServiceableFlag && !isOosScenario) {
      testResults.failed.push(
        "on_select: a Non-serviceable fulfillment requires a DOMAIN-ERROR (typically 30009) error block"
      );
    } else if (nonServiceableFlag) {
      testResults.passed.push("on_select: Non-serviceable fulfillment accompanied by a DOMAIN-ERROR error block");
    }
    });

    tagLayer(testResults, "L2", () => {
    // TAT must exceed the max time_to_ship quoted in on_search — scoped to
    // the items whose own fulfillment_id matches the fulfillment being
    // checked, not the whole catalog. A catalog-wide max mixes unrelated
    // fulfillment options in the same provider (e.g. a Self-Pickup option's
    // short TAT vs. a Delivery option's much longer time_to_ship), which
    // produced false failures for Self-Pickup fulfillments. Falls back to
    // the catalog-wide max only if no item declares this fulfillment_id.
    if (onSearchData?.providers) {
      const providers = Array.isArray(onSearchData.providers) ? onSearchData.providers : [onSearchData.providers];
      const allItems = providers.flatMap((p: any) => p?.items || []);
      for (const ff of onSelect.fulfillments || []) {
        const matchingItems = allItems.filter((it: any) => it?.fulfillment_id === ff?.id);
        const relevantItems = matchingItems.length > 0 ? matchingItems : allItems;
        let maxTts = 0;
        for (const it of relevantItems) {
          maxTts = Math.max(maxTts, isoDurToSec(it?.["@ondc/org/time_to_ship"]));
        }
        const tat = isoDurToSec(ff?.["@ondc/org/TAT"]);
        if (maxTts && tat <= maxTts) {
          testResults.failed.push(
            `on_select: fulfillment ${ff?.id}'s TAT (${tat}s) must exceed on_search's max time_to_ship for this fulfillment (${maxTts}s)`
          );
        } else if (maxTts) {
          testResults.passed.push(
            `on_select: fulfillment ${ff?.id}'s TAT (${tat}s) exceeds on_search's max time_to_ship for this fulfillment (${maxTts}s)`
          );
        }
      }
    }

    // Quote breakup reconciliation
    if (!onSelect.quote) {
      testResults.failed.push("on_select: message.order.quote is missing");
    } else {
      if (!onSelect.quote.ttl) {
        testResults.failed.push("on_select: quote.ttl (validity) is missing");
      } else {
        testResults.passed.push("on_select: quote.ttl (validity) is present");
      }

      const itemsById: Record<string, any> = {};
      for (const it of selectData?.items || []) itemsById[it?.id] = it;

      let computedTotal = 0;
      const deliveryLines: any[] = [];
      for (const b of onSelect.quote.breakup || []) {
        const titleType = b?.["@ondc/org/title_type"];
        const itemId = b?.["@ondc/org/item_id"];
        computedTotal += parseFloat(b?.price?.value || "0");

        if (titleType === "item") {
          if (!(itemId in itemFulfillmentMap)) {
            testResults.failed.push(`on_select: breakup item ${itemId} does not exist in items[]`);
          } else {
            testResults.passed.push(`on_select: breakup item ${itemId} exists in items[]`);
          }
          if (!b?.item?.price?.value) {
            testResults.failed.push(`on_select: breakup item ${itemId} is missing unit price (item.price.value)`);
          } else if (
            Math.abs(parseFloat(b.item.price.value) * (b?.["@ondc/org/item_quantity"]?.count ?? 0) - parseFloat(b.price.value)) > 0.01
          ) {
            testResults.failed.push(`on_select: breakup item ${itemId} unit price * count does not match total price`);
          } else {
            testResults.passed.push(`on_select: breakup item ${itemId} unit price * count matches total price`);
          }
          const expectedCount = itemsById[itemId]?.quantity?.count;
          const fulfilledCount = b?.["@ondc/org/item_quantity"]?.count;
          if (fulfilledCount === 0) {
            // A seller reporting 0 for an item it can't fulfill (out of
            // stock) is a legitimate, correct response — not a mismatch
            // against what the buyer originally requested. Confirmed from a
            // real Out_Of_Stock_Flow(Error-code) on_select: item.quantity.
            // available/maximum are also both "0" and price is zeroed to
            // "0.00" for the same line, consistent with a genuine
            // out-of-stock report rather than a seller error.
            testResults.passed.push(`on_select: breakup item ${itemId} correctly reports 0 (out of stock)`);
          } else if (expectedCount != null && expectedCount !== fulfilledCount) {
            testResults.failed.push(`on_select: breakup item ${itemId} count does not match select's requested count`);
          } else if (expectedCount != null) {
            testResults.passed.push(`on_select: breakup item ${itemId} count matches select's requested count`);
          }
        } else if (titleType === "tax" || titleType === "discount") {
          if (!(itemId in itemFulfillmentMap)) {
            testResults.failed.push(`on_select: breakup ${titleType} line references unknown item id ${itemId}`);
          } else {
            testResults.passed.push(`on_select: breakup ${titleType} line references a known item id ${itemId}`);
          }
        } else if (["packing", "delivery", "misc"].includes(titleType)) {
          if (titleType === "delivery") deliveryLines.push(b);
          if (!Object.values(itemFulfillmentMap).includes(itemId)) {
            testResults.failed.push(`on_select: breakup ${titleType} line's id ${itemId} is not a valid fulfillment_id`);
          } else {
            testResults.passed.push(`on_select: breakup ${titleType} line's id ${itemId} is a valid fulfillment_id`);
          }
        } else {
          testResults.failed.push(`on_select: breakup title_type "${titleType}" is not a recognized Retail value`);
        }

        // Payment title/title_type mapping sanity (RETAIL_PAYMENT_TITLE_TYPES)
        if (titleType !== "item") {
          const titleKey = (b?.title || "").toLowerCase().trim();
          if (!(titleKey in RETAIL_PAYMENT_TITLE_TYPES)) {
            testResults.failed.push(`on_select: breakup title "${b?.title}" is not a recognized Retail payment title`);
          } else if (RETAIL_PAYMENT_TITLE_TYPES[titleKey] !== titleType) {
            testResults.failed.push(
              `on_select: breakup title "${b?.title}" should map to title_type "${RETAIL_PAYMENT_TITLE_TYPES[titleKey]}", got "${titleType}"`
            );
          } else {
            testResults.passed.push(`on_select: breakup title "${b?.title}" correctly maps to title_type "${titleType}"`);
          }
        }
      }

      if (Math.round(computedTotal) !== Math.round(parseFloat(onSelect.quote.price?.value || "0"))) {
        testResults.failed.push(
          `on_select: quote.price.value (${onSelect.quote.price?.value}) does not match sum of breakup (${computedTotal.toFixed(2)})`
        );
      } else {
        testResults.passed.push(
          `on_select: quote.price.value (${onSelect.quote.price?.value}) matches sum of breakup`
        );
      }

      if (!deliveryLines.length && !nonServiceableFlag) {
        testResults.failed.push("on_select: a delivery line item must be present in quote.breakup when serviceable");
      } else if (deliveryLines.length) {
        testResults.passed.push("on_select: a delivery line item is present in quote.breakup");
      }
    }
    });

    addDefaultValidationMessage(testResults, action);
  } catch (error: any) {
    testResults.failed.push(`on_select: validation error — ${error?.message || error}`);
  }

  return testResults;
}
