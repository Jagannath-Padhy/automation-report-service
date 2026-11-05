import { Payload, TestResult } from "../../../types/payload";
import { createBaseValidationSetup, addDefaultValidationMessage, tagLayer } from "../commonValidations";
import { runExternalSchemaAndL1Validation } from "../externalSchemaValidator";
import { getActionData } from "../../../services/actionDataService";
import { RET10_FULFILLMENT_TYPES, isRecognizedFulfillmentType } from "./fulfillmentTypes";
import { checkProviderCredsConsistency } from "./credsValidation";

/**
 * RET10 (Grocery) init/confirm family — ported from
 * log-validation-utility/utils/Retail/{Init,Confirm}/*.ts.
 *
 * Schema validation (AJV) from the source files has been stripped — that is
 * now handled by runExternalSchemaAndL1Validation (L0 schema + L1 JVAL rules
 * via the live api-service). What's kept below is genuine cross-message /
 * business logic that schema alone cannot express.
 *
 * Cross-action data from THIS family's own actions (init, on_init, confirm,
 * on_confirm) is read via getActionData, which depends on save-spec YAMLs
 * under src/config/save-specs/ONDC:RET10/1.2.5/*.yaml existing for those
 * actions with the right keys. Cross-action data from the search/select
 * family (provider id/location, buyer gps/area_code, item-fulfillment maps,
 * on_select quote, np_type, TAT) is read the same way but defensively —
 * every read is null-checked and the dependent check is skipped (not
 * failed) if the upstream save-spec doesn't yet capture that key, since
 * those save-specs are owned by sibling forks working in parallel. See the
 * end-of-port report for the exact key names assumed to exist upstream.
 */

// ---------------------------------------------------------------------------
// Local helpers (ported faithfully from log-validation-utility/utils/index.ts)
// ---------------------------------------------------------------------------

function isCodFlow(flowId: string, payment: any): boolean {
  // Payload-driven signal (preferred): COD orders are collected by the BPP
  // and are NOT-PAID until delivery.
  if (payment?.collected_by === "BPP" && payment?.status === "NOT-PAID") return true;
  // Flow-name signal (fallback): matches this project's established flow
  // naming convention (e.g. "Cash_On_Delivery_Flow").
  return /cash.?on.?delivery|\bcod\b/i.test(flowId || "");
}

// Numeric fields (amounts, fees, quantities) are routinely re-serialized with
// different formatting across calls — "3" vs "3.0", "100" vs "100.00" — by
// different BPP/BAP implementations without it being a real inconsistency.
// Treat two values as equal if they're strictly equal OR both parse as the
// same finite number, so leaf comparisons below don't flag formatting noise
// as a mismatch.
function valuesEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if ((typeof a === "string" || typeof a === "number") && (typeof b === "string" || typeof b === "number")) {
    const na = Number(a);
    const nb = Number(b);
    if (!isNaN(na) && !isNaN(nb) && String(a).trim() !== "" && String(b).trim() !== "") return na === nb;
  }
  return false;
}

function compareObjects(obj1: any, obj2: any, parentKey?: string): string[] {
  const errors: string[] = [];
  if (obj1 === null || obj1 === undefined || obj2 === null || obj2 === undefined) {
    errors.push("One of the objects is undefined or null");
    return errors;
  }
  const keys1 = Object.keys(obj1);
  const keys2 = Object.keys(obj2);
  if (keys1.length !== keys2.length) {
    errors.push(`Key length mismatch for ${parentKey || "root"}`);
    return errors;
  }
  for (const key of keys1) {
    const fullKey = parentKey ? `${parentKey}.${key}` : key;
    if (typeof obj1[key] === "object" && typeof obj2[key] === "object") {
      errors.push(...compareObjects(obj1[key], obj2[key], fullKey));
    } else if (!valuesEqual(obj1[key], obj2[key])) {
      errors.push(`Key '${fullKey}' mismatch: ${obj1[key]} !== ${obj2[key]}`);
    }
  }
  return errors;
}

function deepEqual(a: any, b: any): boolean {
  if (valuesEqual(a, b)) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

function sumQuoteBreakUp(quote: any): boolean {
  const totalPrice = Number(quote?.price?.value);
  let currentPrice = 0;
  (quote?.breakup || []).forEach((item: any) => {
    currentPrice += Number(item?.price?.value);
  });
  return Math.round(totalPrice) === Math.round(currentPrice);
}

// Strips breakup[].item.quantity before comparing — per the shared Quotation
// schema (automation-specifications RET10 config/specs/openapi.yaml), this
// sub-field only carries stock-availability context (available/maximum
// count) that's meaningful during search/select and has no reason to persist
// once the order is placed at /init onward. Treating its disappearance as a
// quote mismatch was a false positive, not a real inconsistency.
function stripVolatileBreakupFields(item: any): any {
  if (!item?.item || typeof item.item !== "object") return item;
  const { quantity, ...restItem } = item.item;
  return { ...item, item: restItem };
}

function compareQuoteObjects(obj1: any, obj2: any, api1: string, api2: string): string[] {
  const errors: string[] = [];
  if (!obj1 || !obj2) return errors; // nothing to compare against yet
  const rootKeys1 = Object.keys(obj1);
  const rootKeys2 = Object.keys(obj2);
  if (rootKeys1.length !== rootKeys2.length) {
    errors.push(`Root level quote properties mismatch between ${api1} and ${api2}`);
    return errors;
  }
  (obj1.breakup || []).forEach((item1: any) => {
    const matchingItem = (obj2.breakup || []).find(
      (item2: any) =>
        item1["@ondc/org/item_id"] === item2["@ondc/org/item_id"] &&
        item1["@ondc/org/title_type"] === item2["@ondc/org/title_type"]
    );
    if (!matchingItem || !deepEqual(stripVolatileBreakupFields(item1), stripVolatileBreakupFields(matchingItem))) {
      errors.push(
        `Mismatch found for item with item_id ${item1["@ondc/org/item_id"]} while comparing quote object of ${api1} and ${api2}`
      );
    }
  });
  return errors;
}

function findGSTNumber(tags: any[], termToMatch: string): string | undefined {
  const termObject = tags?.find((tag) => tag.code === termToMatch);
  const taxNumberObject = termObject?.list?.find((item: any) => item.code === "tax_number");
  const value = taxNumberObject?.value;
  return typeof value === "string" && value.length <= 15 ? value : undefined;
}

function areGSTNumbersMatching(tags1: any[], tags2: any[], termToMatch: string): boolean {
  const g1 = findGSTNumber(tags1, termToMatch);
  const g2 = findGSTNumber(tags2, termToMatch);
  // tax_number is optional on the /confirm request's own bap_terms/bpp_terms
  // (validations/RET10/1.2.5/index.yaml guards the whole TAGS_BPP_TERMS group
  // with `_CONTINUE_: "!(attr are present)"`) — it only becomes mandatory on
  // the on_init/on_confirm response (enforced separately, further down this
  // file). So when the request side simply didn't carry a value, there is
  // nothing to compare against; that is not the same as a mismatch.
  if (typeof g1 !== "string" || typeof g2 !== "string") return true;
  return g1 === g2;
}

function isTagsValid(tags: any[], entity: string): boolean {
  const termsObject = tags?.find((tag) => tag.code === entity);
  const taxNumberObject = termsObject?.list?.find((item: any) => item.code === "tax_number");
  const value = taxNumberObject?.value;
  return typeof value === "string" && value.length <= 15;
}

// np_type and accept_bap_terms are both legitimately introduced partway through
// the init/confirm sequence rather than carried from the start — np_type only
// from on_init onward, accept_bap_terms only once the buyer has something to
// accept it in (/confirm onward) — so their absence further upstream is not a
// mismatch. Per the authoritative JVAL spec (validations/RET10/1.2.5/index.yaml,
// TAGS_BPP_TERMS_VALID_TAGS, shared verbatim between confirm/on_confirm via the
// &a11/*a11 anchor), accept_bap_terms is an explicitly valid bpp_terms code.
const BPP_TERMS_CODES_NOT_REQUIRED_UPSTREAM = ["np_type", "accept_bap_terms"];

function compareLists(list1: any[], list2: any[]): string[] {
  const errors: string[] = [];
  for (const obj1 of list1 || []) {
    const matchingObj = (list2 || []).find((obj2) => obj2.code === obj1.code);
    if (!matchingObj) {
      if (!BPP_TERMS_CODES_NOT_REQUIRED_UPSTREAM.includes(obj1.code))
        errors.push(`Code '${obj1.code}' present in bpp_terms but missing downstream`);
    } else if (obj1.value !== matchingObj.value) {
      errors.push(`Code '${obj1.code}' value not matching`);
    }
  }
  return errors;
}

function checkItemTag(item: any, itemArray: string[]): boolean {
  if (!item?.tags) return false;
  for (const tag of item.tags) {
    if (tag.code === "parent") {
      for (const l of tag.list || []) {
        if (l.code === "id" && !itemArray.includes(l.value)) return true;
      }
    }
  }
  return false;
}

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

function compareCoordinates(gps1?: string, gps2?: string): boolean {
  if (!gps1 || !gps2) return true; // nothing to compare — don't fail on absence
  const parse = (s: string) => s.split(",").map((v) => parseFloat(v.trim()));
  const [lat1, lon1] = parse(gps1);
  const [lat2, lon2] = parse(gps2);
  if ([lat1, lon1, lat2, lon2].some((n) => Number.isNaN(n))) return true;
  const EPSILON = 0.0005; // ~50m tolerance
  return Math.abs(lat1 - lat2) < EPSILON && Math.abs(lon1 - lon2) < EPSILON;
}

const SETTLEMENT_TYPES = ["neft", "rtgs", "upi"];

function checkSettlementDetails(testResults: TestResult, settlementDetails: any, label: string) {
  if (!settlementDetails) {
    testResults.failed.push(`${label}: @ondc/org/settlement_details is missing`);
    return;
  }
  testResults.passed.push(`${label}: @ondc/org/settlement_details is present`);
  const d = settlementDetails;
  if (!SETTLEMENT_TYPES.includes(d.settlement_type)) {
    testResults.failed.push(
      `${label}: settlement_type should be one of ${SETTLEMENT_TYPES.join("/")}, got "${d.settlement_type}"`
    );
    return;
  }
  testResults.passed.push(`${label}: settlement_type is one of ${SETTLEMENT_TYPES.join("/")}`);
  if (d.settlement_type === "upi") {
    if (!d.upi_address || String(d.upi_address).trim() === "") {
      testResults.failed.push(`${label}: upi_address is required when settlement_type is "upi"`);
    } else {
      testResults.passed.push(`${label}: upi_address is present`);
    }
    return;
  }
  const missing: string[] = [];
  if (!d.bank_name) missing.push("bank_name");
  if (!d.branch_name) missing.push("branch_name");
  if (!d.beneficiary_name || String(d.beneficiary_name).trim() === "") missing.push("beneficiary_name");
  if (!d.settlement_phase) missing.push("settlement_phase");
  if (!d.settlement_ifsc_code) missing.push("settlement_ifsc_code");
  if (!d.settlement_counterparty) missing.push("settlement_counterparty");
  if (!d.settlement_bank_account_no || String(d.settlement_bank_account_no).trim() === "")
    missing.push("settlement_bank_account_no");
  if (missing.length > 0) {
    testResults.failed.push(`${label}: settlement_details missing fields: ${missing.join(", ")}`);
  } else {
    testResults.passed.push(
      `${label}: settlement_details has all required fields (bank_name, branch_name, beneficiary_name, settlement_phase, settlement_ifsc_code, settlement_counterparty, settlement_bank_account_no)`
    );
  }
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

export async function validateRet10Init(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const { testResults, jsonRequest, context, message, action } = createBaseValidationSetup(element);
  await runExternalSchemaAndL1Validation(jsonRequest, testResults);

  const order = message?.order;
  if (!order) {
    testResults.failed.push("init: message.order is missing");
    return testResults;
  }

  const txnId = context?.transaction_id as string | undefined;

  try {
    // Address component rules — not expressible as plain schema (cross-field
    // length and uniqueness constraints across three sibling fields).
    tagLayer(testResults, "L2", () => {
      for (const fulfillment of order.fulfillments || []) {
        const address = fulfillment?.end?.location?.address;
        if (!address) continue;
        const lenName = (address.name || "").length;
        const lenBuilding = (address.building || "").length;
        const lenLocality = (address.locality || "").length;

        if (lenName + lenBuilding + lenLocality >= 190) {
          testResults.failed.push(
            "init: address.name + address.building + address.locality should be less than 190 chars"
          );
        } else {
          testResults.passed.push("init: address.name + address.building + address.locality is less than 190 chars");
        }
        if (lenBuilding <= 3) testResults.failed.push("init: address.building should be more than 3 chars");
        else testResults.passed.push("init: address.building is more than 3 chars");
        if (lenName <= 3) testResults.failed.push("init: address.name should be more than 3 chars");
        else testResults.passed.push("init: address.name is more than 3 chars");
        if (lenLocality <= 3) testResults.failed.push("init: address.locality should be more than 3 chars");
        else testResults.passed.push("init: address.locality is more than 3 chars");
        if (
          address.building === address.locality ||
          address.name === address.building ||
          address.name === address.locality
        ) {
          testResults.failed.push(
            "init: address.name, address.building and address.locality should be unique values"
          );
        } else {
          testResults.passed.push("init: address.name, address.building and address.locality are unique values");
        }
      }
    });
  } catch (_) {}

  // Cross-action: compare against /select (owned by sibling fork's save-spec).
  if (txnId) {
    try {
      const selectData = await getActionData(sessionID, flowId, txnId, "select");
      if (selectData) {
        tagLayer(testResults, "L2", () => {
          if (selectData.provider_id && selectData.provider_id !== order.provider?.id) {
            testResults.failed.push("init: provider.id mismatches the provider selected in /select");
          } else if (selectData.provider_id) {
            testResults.passed.push("init: provider.id matches the provider selected in /select");
          }
          const selectDeliveryFf = (Array.isArray(selectData.fulfillments) ? selectData.fulfillments : []).find((f: any) => f?.end);
          const buyerGps = selectDeliveryFf?.end?.location?.gps;
          if (buyerGps) {
            for (const ff of order.fulfillments || []) {
              if (!deepEqual(ff?.end?.location?.gps, buyerGps)) {
                testResults.failed.push(`init: fulfillment "${ff?.id}".end.location.gps mismatches /select`);
              } else {
                testResults.passed.push(`init: fulfillment "${ff?.id}".end.location.gps matches /select`);
              }
            }
          }
          const itemFulfillmentMap: Record<string, string> = Object.fromEntries(
            (Array.isArray(selectData.items) ? selectData.items : []).map((i: any) => [i?.id, i?.fulfillment_id])
          );
          for (const item of order.items || []) {
            const expectedFfId = itemFulfillmentMap[item.id];
            if (expectedFfId && item.fulfillment_id !== expectedFfId) {
              testResults.failed.push(
                `init: items[id=${item.id}].fulfillment_id mismatches the fulfillment selected in /select`
              );
            } else if (expectedFfId) {
              testResults.passed.push(
                `init: items[id=${item.id}].fulfillment_id matches the fulfillment selected in /select`
              );
            }
          }
        });
      }
    } catch (_) {
      // Upstream save-spec may not capture these keys yet — degrade gracefully.
    }
  }

  addDefaultValidationMessage(testResults, action);
  return testResults;
}

// ---------------------------------------------------------------------------
// on_init
// ---------------------------------------------------------------------------

export async function validateRet10OnInit(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const { testResults, jsonRequest, context, message, action } = createBaseValidationSetup(element);
  await runExternalSchemaAndL1Validation(jsonRequest, testResults);

  const order = message?.order;
  if (!order) {
    testResults.failed.push("on_init: message.order is missing");
    return testResults;
  }

  const txnId = context?.transaction_id as string | undefined;

  try {
    tagLayer(testResults, "L2", () => {
      if (order.cancellation_terms && order.cancellation_terms.length > 0) {
        testResults.failed.push("on_init: cancellation_terms should not be provided — not enabled for this version");
      } else {
        testResults.passed.push("on_init: cancellation_terms correctly not provided");
      }
    });
  } catch (_) {}

  try {
    // Delivery fulfillments must not carry tags (RET10-specific rule) — but
    // the type itself just needs to be one of the real recognized values,
    // not literally "Delivery" (Self-Pickup/Buyer-Delivery are equally
    // valid and don't carry this tags restriction).
    tagLayer(testResults, "L2", () => {
      for (const ff of order.fulfillments || []) {
        if (!isRecognizedFulfillmentType(ff.type)) {
          testResults.failed.push(
            `on_init: fulfillment type should be one of ${RET10_FULFILLMENT_TYPES.join("/")}, got "${ff.type}"`
          );
        } else if (ff.type === "Delivery" && ff.tags?.length > 0) {
          testResults.failed.push(`on_init: fulfillment "${ff.id}" of type Delivery should not have tags`);
        } else {
          testResults.passed.push(`on_init: fulfillment "${ff.id}" has a recognized type ("${ff.type}") with no disallowed tags`);
        }
        if (!ff.id) testResults.failed.push("on_init: fulfillment.id must be present");
        else testResults.passed.push("on_init: fulfillment.id is present");
      }
    });
  } catch (_) {}

  try {
    // Price = sum(breakup)
    tagLayer(testResults, "L2", () => {
      if (order.quote && !sumQuoteBreakUp(order.quote)) {
        testResults.failed.push("on_init: quote.price does not equal the sum of quote.breakup line items");
      } else if (order.quote) {
        testResults.passed.push("on_init: quote.price equals the sum of quote.breakup line items");
      }
    });
  } catch (_) {}

  try {
    tagLayer(testResults, "L2", () => {
      const bppTerms = (order.tags || []).find((t: any) => t.code === "bpp_terms");
      if (bppTerms) {
        const taxNumber = bppTerms.list?.find((i: any) => i.code === "tax_number");
        const providerTaxNumber = bppTerms.list?.find((i: any) => i.code === "provider_tax_number");
        if (!taxNumber?.value) {
          testResults.failed.push("on_init: tax_number must be present in bpp_terms");
        } else if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(taxNumber.value)) {
          testResults.failed.push("on_init: tax_number has an invalid GSTIN format");
        } else {
          testResults.passed.push("on_init: tax_number has a valid GSTIN format");
        }
        if (!providerTaxNumber?.value) {
          testResults.failed.push("on_init: provider_tax_number must be present in bpp_terms");
        } else if (!/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(providerTaxNumber.value)) {
          testResults.failed.push("on_init: provider_tax_number has an invalid PAN format");
        } else {
          testResults.passed.push("on_init: provider_tax_number has a valid PAN format");
        }
        if (taxNumber?.value?.length === 15 && providerTaxNumber?.value?.length === 10) {
          const panFromGstin = taxNumber.value.slice(2, 12);
          if (panFromGstin !== providerTaxNumber.value) {
            testResults.failed.push("on_init: PAN embedded in tax_number does not match provider_tax_number");
          } else {
            testResults.passed.push("on_init: PAN embedded in tax_number matches provider_tax_number");
          }
        }
      }

    });
  } catch (_) {}

  try {
    tagLayer(testResults, "L2", () => {
      if (order.payment?.collected_by === "BPP") {
        const validSettlementBasis = ["delivery", "shipment"];
        if (!validSettlementBasis.includes(order.payment["@ondc/org/settlement_basis"])) {
          testResults.failed.push(
            `on_init: @ondc/org/settlement_basis should be one of ${validSettlementBasis.join("/")}`
          );
        } else {
          testResults.passed.push(
            `on_init: @ondc/org/settlement_basis is one of ${validSettlementBasis.join("/")}`
          );
        }
        if (!/^PT\d+[MH]$/.test(order.payment["@ondc/org/settlement_window"] || "")) {
          testResults.failed.push("on_init: @ondc/org/settlement_window should match format PT<n>[M|H], e.g. PT1H");
        } else {
          testResults.passed.push("on_init: @ondc/org/settlement_window matches format PT<n>[M|H]");
        }
        checkSettlementDetails(
          testResults,
          order.payment["@ondc/org/settlement_details"]?.[0],
          "on_init (payment.collected_by=BPP)"
        );
        if (order.payment["@ondc/org/settlement_details"]?.[0]?.settlement_counterparty !== "seller-app") {
          testResults.failed.push("on_init: settlement_counterparty should be 'seller-app'");
        } else {
          testResults.passed.push("on_init: settlement_counterparty is 'seller-app'");
        }
      } else if (!isCodFlow(flowId, order.payment)) {
        if (!order.payment?.hasOwnProperty?.("@ondc/org/settlement_details")) {
          testResults.failed.push("on_init: payment.settlement_details missing (required outside COD flow)");
        } else {
          testResults.passed.push("on_init: payment.settlement_details present (required outside COD flow)");
        }
      }
    });
  } catch (_) {}

  try {
    tagLayer(testResults, "L2", () => {
      if (!order.payment) {
        testResults.failed.push("on_init: payment object cannot be null");
      } else {
        const status = payment_status(order.payment, flowId);
        if (status !== true) {
          testResults.failed.push(
            typeof status === "object" ? status.message : "on_init: payment status/transaction_id check failed"
          );
        } else {
          testResults.passed.push("on_init: payment status/transaction_id checks passed");
        }
      }
    });
  } catch (_) {}

  if (txnId) {
    try {
      const initData = await getActionData(sessionID, flowId, txnId, "init");
      const onSelectData = await getActionData(sessionID, flowId, txnId, "on_select");
      const searchData = await getActionData(sessionID, flowId, txnId, "search");

      tagLayer(testResults, "L2", () => {
        if (initData?.billing) {
          const billingErrors = compareObjects(initData.billing, order.billing);
          if (billingErrors.length > 0) {
            billingErrors.forEach((e) => testResults.failed.push(`on_init: billing mismatch vs /init — ${e}`));
          } else {
            testResults.passed.push("on_init: billing matches /init");
          }
        }

        if (onSelectData?.quote) {
          const quoteErrors = compareQuoteObjects(onSelectData.quote, order.quote, "on_select", "on_init");
          if (quoteErrors.length > 0) {
            quoteErrors.forEach((e) => testResults.failed.push(`on_init: ${e}`));
          } else {
            testResults.passed.push("on_init: quote object matches /on_select");
          }
        }
        const onSelectPrice = parseFloat(onSelectData?.quote?.price?.value);
        if (!isNaN(onSelectPrice)) {
          const onInitPrice = parseFloat(order.quote?.price?.value);
          if (Math.round(onSelectPrice) !== Math.round(onInitPrice)) {
            testResults.failed.push(
              `on_init: quote.price ${onInitPrice} does not match /on_select quote.price ${onSelectPrice}`
            );
          } else {
            testResults.passed.push(`on_init: quote.price ${onInitPrice} matches /on_select quote.price`);
          }
        }
        if (searchData?.buyer_app_finder_fee !== undefined) {
          const bff = parseFloat(order.payment?.["@ondc/org/buyer_app_finder_fee_amount"]);
          const expectedBff = parseFloat(searchData.buyer_app_finder_fee);
          if (isNaN(bff) || (!isNaN(expectedBff) && bff !== expectedBff)) {
            testResults.failed.push("on_init: buyer_app_finder_fee_amount must not change from /search onward");
          } else {
            testResults.passed.push("on_init: buyer_app_finder_fee_amount unchanged from /search");
          }
        }
      });
    } catch (_) {}
  }

  function payment_status(payment: any, flowId: string): true | { message: string } {
    if (isCodFlow(flowId, payment) && payment.status === "PAID") {
      return { message: "on_init: payment.status cannot be PAID for a cash-on-delivery flow" };
    }
    if (payment.status === "PAID" && !payment.params?.transaction_id) {
      return { message: "on_init: payment.params.transaction_id is required when status is PAID" };
    }
    return true;
  }

  addDefaultValidationMessage(testResults, action);
  return testResults;
}

// ---------------------------------------------------------------------------
// confirm
// ---------------------------------------------------------------------------

export async function validateRet10Confirm(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const { testResults, jsonRequest, context, message, action } = createBaseValidationSetup(element);
  await runExternalSchemaAndL1Validation(jsonRequest, testResults);

  const order = message?.order;
  if (!order) {
    testResults.failed.push("confirm: message.order is missing");
    return testResults;
  }
  const txnId = context?.transaction_id as string | undefined;

  tagLayer(testResults, "L2", () => {
    if (order.state !== "Created") {
      testResults.failed.push('confirm: order.state should default to "Created"');
    } else {
      testResults.passed.push('confirm: order.state defaults to "Created"');
    }
  });

  try {
    tagLayer(testResults, "L2", () => {
      for (const [index, ff] of (order.fulfillments || []).entries()) {
        const isKerbside = ff.type === "Self-Pickup" && ff["@ondc/org/category"] === "Kerbside";
        if (isKerbside) {
          if (!ff.vehicle) {
            testResults.failed.push(`confirm: fulfillments[${index}] requires a vehicle object (Self-Pickup/Kerbside)`);
          } else if (!ff.vehicle.registration) {
            testResults.failed.push(`confirm: fulfillments[${index}].vehicle.registration is required (Kerbside)`);
          } else {
            testResults.passed.push(`confirm: fulfillments[${index}] has a valid vehicle object (Kerbside)`);
          }
        } else if (ff.vehicle) {
          testResults.failed.push(
            `confirm: fulfillments[${index}] should not carry a vehicle object (type=${ff.type})`
          );
        } else {
          testResults.passed.push(`confirm: fulfillments[${index}] correctly has no vehicle object (type=${ff.type})`);
        }
        if (ff.end && !ff.end.person) {
          testResults.failed.push(`confirm: fulfillments[${index}].end.person is required`);
        } else if (ff.end) {
          testResults.passed.push(`confirm: fulfillments[${index}].end.person is present`);
        }
        if (!ff.id) testResults.failed.push(`confirm: fulfillments[${index}].id is required`);
        else testResults.passed.push(`confirm: fulfillments[${index}].id is present`);
      }
    });
  } catch (_) {}

  try {
    tagLayer(testResults, "L2", () => {
      if (order.quote && order.payment?.params?.amount !== undefined) {
        if (parseFloat(order.payment.params.amount) !== parseFloat(order.quote.price?.value)) {
          testResults.failed.push("confirm: payment.params.amount does not match quote.price.value");
        } else {
          testResults.passed.push("confirm: payment.params.amount matches quote.price.value");
        }
      }
      if (order.quote && !sumQuoteBreakUp(order.quote)) {
        testResults.failed.push("confirm: quote.price does not equal the sum of quote.breakup line items");
      } else if (order.quote) {
        testResults.passed.push("confirm: quote.price equals the sum of quote.breakup line items");
      }
    });
  } catch (_) {}

  try {
    tagLayer(testResults, "L2", () => {
      if (!order.hasOwnProperty("created_at") || !order.hasOwnProperty("updated_at")) {
        testResults.failed.push("confirm: order.created_at and order.updated_at are mandatory");
      } else if (order.created_at !== order.updated_at) {
        testResults.failed.push("confirm: order.updated_at should equal order.created_at at confirm time");
      } else {
        testResults.passed.push("confirm: order.created_at equals order.updated_at at confirm time");
      }
    });
  } catch (_) {}

  if (txnId) {
    try {
      const initData = await getActionData(sessionID, flowId, txnId, "init");
      const onInitData = await getActionData(sessionID, flowId, txnId, "on_init");
      const selectData = await getActionData(sessionID, flowId, txnId, "select");
      const onSelectData = await getActionData(sessionID, flowId, txnId, "on_select");
      const searchData = await getActionData(sessionID, flowId, txnId, "search");

      tagLayer(testResults, "L2", () => {
        if (initData?.billing) {
          const billingErrors = compareObjects(initData.billing, order.billing);
          if (billingErrors.length > 0) {
            billingErrors.forEach((e) => testResults.failed.push(`confirm: billing mismatch vs /init — ${e}`));
          } else {
            testResults.passed.push("confirm: billing matches /init");
          }
        }
        if (selectData?.provider_id && selectData.provider_id !== order.provider?.id) {
          testResults.failed.push("confirm: provider.id mismatches /select");
        } else if (selectData?.provider_id) {
          testResults.passed.push("confirm: provider.id matches /select");
        }
        if (onSelectData?.quote) {
          const quoteErrors = compareQuoteObjects(onSelectData.quote, order.quote, "on_select", "confirm");
          if (quoteErrors.length > 0) {
            quoteErrors.forEach((e) => testResults.failed.push(`confirm: ${e}`));
          } else {
            testResults.passed.push("confirm: quote object matches /on_select");
          }
        }
        const onInitPrice = parseFloat(onInitData?.quote?.price?.value);
        if (!isNaN(onInitPrice) && order.quote?.price?.value !== undefined) {
          const confirmPrice = parseFloat(order.quote.price.value);
          if (Math.round(onInitPrice) !== Math.round(confirmPrice)) {
            testResults.failed.push(
              `confirm: quote.price ${confirmPrice} does not match /on_init quote.price ${onInitPrice}`
            );
          } else {
            testResults.passed.push(`confirm: quote.price ${confirmPrice} matches /on_init quote.price`);
          }
        }
        const onInitSettlementDetails = onInitData?.payment?.["@ondc/org/settlement_details"]?.[0];
        if (!isCodFlow(flowId, order.payment) && onInitSettlementDetails) {
          if (!deepEqual(onInitSettlementDetails, order.payment?.["@ondc/org/settlement_details"]?.[0])) {
            testResults.failed.push("confirm: payment.settlement_details mismatches /on_init");
          } else {
            testResults.passed.push("confirm: payment.settlement_details matches /on_init");
          }
        }
        if (searchData?.buyer_app_finder_fee !== undefined) {
          const bff = parseFloat(order.payment?.["@ondc/org/buyer_app_finder_fee_amount"]);
          const expectedBff = parseFloat(searchData.buyer_app_finder_fee);
          if (isNaN(bff) || (!isNaN(expectedBff) && bff !== expectedBff)) {
            testResults.failed.push("confirm: buyer_app_finder_fee_amount must not change from /search onward");
          } else {
            testResults.passed.push("confirm: buyer_app_finder_fee_amount unchanged from /search");
          }
        }
      });
    } catch (_) {}
  }

  // COD-flow-specific checks
  try {
    if (isCodFlow(flowId, order.payment)) {
      tagLayer(testResults, "L3", () => {
        if (order.payment?.status !== "NOT-PAID") {
          testResults.failed.push("confirm: payment.status should be NOT-PAID for a cash-on-delivery flow");
        } else {
          testResults.passed.push("confirm: payment.status is NOT-PAID for a cash-on-delivery flow");
        }
        if (order.payment?.["@ondc/org/settlement_details"]?.[0]?.settlement_counterparty !== "buyer-app") {
          testResults.failed.push("confirm: settlement_counterparty should be 'buyer-app' for a COD flow");
        } else {
          testResults.passed.push("confirm: settlement_counterparty is 'buyer-app' for a COD flow");
        }
        checkSettlementDetails(
          testResults,
          order.payment?.["@ondc/org/settlement_details"]?.[0],
          "confirm (COD flow)"
        );
      });
    }
  } catch (_) {}

  addDefaultValidationMessage(testResults, action);
  return testResults;
}

// ---------------------------------------------------------------------------
// on_confirm
// ---------------------------------------------------------------------------

export async function validateRet10OnConfirm(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const { testResults, jsonRequest, context, message, action } = createBaseValidationSetup(element);
  await runExternalSchemaAndL1Validation(jsonRequest, testResults);

  const order = message?.order;
  if (!order) {
    testResults.failed.push("on_confirm: message.order is missing");
    return testResults;
  }
  const txnId = context?.transaction_id as string | undefined;

  try {
    tagLayer(testResults, "L2", () => {
      if (order.cancellation_terms && order.cancellation_terms.length > 0) {
        testResults.failed.push("on_confirm: cancellation_terms should not be provided — not enabled for this version");
      } else {
        testResults.passed.push("on_confirm: cancellation_terms correctly not provided");
      }
    });
  } catch (_) {}

  try {
    tagLayer(testResults, "L2", () => {
      for (const ff of order.fulfillments || []) {
        if (!ff["@ondc/org/TAT"]) {
          testResults.failed.push(`on_confirm: fulfillment "${ff.id}" is missing @ondc/org/TAT`);
        } else {
          testResults.passed.push(`on_confirm: fulfillment "${ff.id}" has @ondc/org/TAT`);
        }
        const isKerbside = ff.type === "Self-Pickup" && ff["@ondc/org/category"] === "Kerbside";
        if (isKerbside) {
          if (!ff.vehicle) testResults.failed.push(`on_confirm: fulfillment "${ff.id}" requires a vehicle object`);
          else if (!ff.vehicle.registration)
            testResults.failed.push(`on_confirm: fulfillment "${ff.id}".vehicle.registration is required`);
          else testResults.passed.push(`on_confirm: fulfillment "${ff.id}" has a valid vehicle object (Kerbside)`);
        } else if (ff.vehicle) {
          testResults.failed.push(`on_confirm: fulfillment "${ff.id}" should not carry a vehicle object`);
        } else {
          testResults.passed.push(`on_confirm: fulfillment "${ff.id}" correctly has no vehicle object`);
        }
        if (!ff.type) testResults.failed.push(`on_confirm: fulfillment "${ff.id}" is missing a type`);
        else testResults.passed.push(`on_confirm: fulfillment "${ff.id}" has a type`);
        if (!ff.id) testResults.failed.push("on_confirm: a fulfillment is missing its id");

        const stateCode = ff.state?.descriptor?.code;
        if (order.state === "Created" && stateCode !== "Pending") {
          testResults.failed.push(`on_confirm: fulfillment "${ff.id}" should default to state "Pending"`);
        } else if (order.state === "Created") {
          testResults.passed.push(`on_confirm: fulfillment "${ff.id}" defaults to state "Pending"`);
        }
        if (!ff.start || !ff.end) {
          testResults.failed.push(`on_confirm: fulfillment "${ff.id}" start and end are both mandatory`);
        } else {
          testResults.passed.push(`on_confirm: fulfillment "${ff.id}" has both start and end`);
        }
      }

      if (order.state === "Accepted") {
        // Any recognized fulfillment type counts — Self-Pickup/Buyer-Delivery
        // orders are "Accepted" with no "Delivery"-typed fulfillment at all,
        // confirmed from a real Self_Pickup_Flow session.
        const hasRecognizedFulfillment = (order.fulfillments || []).some((f: any) =>
          isRecognizedFulfillmentType(f?.type)
        );
        if (!hasRecognizedFulfillment) {
          testResults.failed.push(
            `on_confirm: a recognized fulfillment (${RET10_FULFILLMENT_TYPES.join("/")}) must be present when order.state is "Accepted"`
          );
        } else {
          testResults.passed.push('on_confirm: a recognized fulfillment is present (order.state is "Accepted")');
        }
      }
    });
  } catch (_) {}

  try {
    tagLayer(testResults, "L2", () => {
      if (order.quote) {
        if (order.payment?.params?.amount !== undefined) {
          if (parseFloat(order.payment.params.amount) !== parseFloat(order.quote.price?.value)) {
            testResults.failed.push("on_confirm: payment.params.amount does not match quote.price.value");
          } else {
            testResults.passed.push("on_confirm: payment.params.amount matches quote.price.value");
          }
        }
        if (!sumQuoteBreakUp(order.quote)) {
          testResults.failed.push("on_confirm: quote.price does not equal the sum of quote.breakup line items");
        } else {
          testResults.passed.push("on_confirm: quote.price equals the sum of quote.breakup line items");
        }
      }
    });
  } catch (_) {}

  try {
    tagLayer(testResults, "L2", () => {
      if (context?.timestamp && order.updated_at) {
        if (context.timestamp !== order.updated_at) {
          testResults.failed.push("on_confirm: order.updated_at should equal context.timestamp");
        } else {
          testResults.passed.push("on_confirm: order.updated_at equals context.timestamp");
        }
      }
    });
  } catch (_) {}

  try {
    tagLayer(testResults, "L2", () => {
      const bppTerms = (order.tags || []).find((t: any) => t.code === "bpp_terms");
      if (bppTerms) {
        const npType = bppTerms.list?.find((i: any) => i.code === "np_type");
        if (!npType) testResults.failed.push("on_confirm: np_type is missing in bpp_terms");
        else testResults.passed.push("on_confirm: np_type is present in bpp_terms");
        const taxNumber = bppTerms.list?.find((i: any) => i.code === "tax_number");
        const providerTaxNumber = bppTerms.list?.find((i: any) => i.code === "provider_tax_number");
        if (!taxNumber?.value) testResults.failed.push("on_confirm: tax_number must be present in bpp_terms");
        else if (taxNumber.value.length !== 15)
          testResults.failed.push("on_confirm: tax_number should be 15 characters (GSTIN)");
        else testResults.passed.push("on_confirm: tax_number is 15 characters (GSTIN)");
        if (!providerTaxNumber?.value)
          testResults.failed.push("on_confirm: provider_tax_number must be present in bpp_terms");
        else if (providerTaxNumber.value.length !== 10)
          testResults.failed.push("on_confirm: provider_tax_number should be 10 characters (PAN)");
        else testResults.passed.push("on_confirm: provider_tax_number is 10 characters (PAN)");
        if (taxNumber?.value?.length === 15 && providerTaxNumber?.value?.length === 10) {
          const pan = taxNumber.value.slice(2, 12);
          if (pan !== providerTaxNumber.value) {
            testResults.failed.push("on_confirm: PAN embedded in tax_number does not match provider_tax_number");
          } else {
            testResults.passed.push("on_confirm: PAN embedded in tax_number matches provider_tax_number");
          }
        }
      }

    });
  } catch (_) {}

  try {
    if (!order.payment) {
      tagLayer(testResults, "L2", () => {
        testResults.failed.push("on_confirm: payment object cannot be null");
      });
    } else if (isCodFlow(flowId, order.payment)) {
      tagLayer(testResults, "L3", () => {
        if (order.payment.status !== "NOT-PAID") {
          testResults.failed.push("on_confirm: payment.status should be NOT-PAID for a cash-on-delivery flow");
        } else {
          testResults.passed.push("on_confirm: payment.status is NOT-PAID for a cash-on-delivery flow");
        }
      });
    } else {
      tagLayer(testResults, "L2", () => {
        testResults.passed.push("on_confirm: payment object is present");
      });
    }
  } catch (_) {}

  if (txnId) {
    try {
      const confirmData = await getActionData(sessionID, flowId, txnId, "confirm");
      const onInitData = await getActionData(sessionID, flowId, txnId, "on_init");
      const selectData = await getActionData(sessionID, flowId, txnId, "select");
      const onSelectData = await getActionData(sessionID, flowId, txnId, "on_select");
      const onSearchData = await getActionData(sessionID, flowId, txnId, "on_search");

      tagLayer(testResults, "L2", () => {
        if (confirmData?.order_id && confirmData.order_id !== order.id) {
          testResults.failed.push("on_confirm: order.id mismatches /confirm");
        } else if (confirmData?.order_id) {
          testResults.passed.push("on_confirm: order.id matches /confirm");
        }
        if (selectData?.provider_id && selectData.provider_id !== order.provider?.id) {
          testResults.failed.push("on_confirm: provider.id mismatches /select");
        } else if (selectData?.provider_id) {
          testResults.passed.push("on_confirm: provider.id matches /select");
        }
        if (confirmData?.billing) {
          const billingErrors = compareObjects(confirmData.billing, order.billing);
          if (billingErrors.length > 0) {
            billingErrors.forEach((e) => testResults.failed.push(`on_confirm: billing mismatch vs /confirm — ${e}`));
          } else {
            testResults.passed.push("on_confirm: billing matches /confirm");
          }
        }
        if (confirmData?.payment) {
          if (!deepEqual(confirmData.payment, order.payment)) {
            testResults.failed.push("on_confirm: payment object mismatches /confirm");
          } else {
            testResults.passed.push("on_confirm: payment object matches /confirm");
          }
        }
        if (onSelectData?.quote) {
          const quoteErrors = compareQuoteObjects(onSelectData.quote, order.quote, "on_select", "on_confirm");
          if (quoteErrors.length > 0) {
            quoteErrors.forEach((e) => testResults.failed.push(`on_confirm: ${e}`));
          } else {
            testResults.passed.push("on_confirm: quote object matches /on_select");
          }
        }
        const onInitPrice = parseFloat(onInitData?.quote?.price?.value);
        if (!isNaN(onInitPrice) && order.quote?.price?.value !== undefined) {
          const onConfirmPrice = parseFloat(order.quote.price.value);
          if (Math.round(onInitPrice) !== Math.round(onConfirmPrice)) {
            testResults.failed.push(
              `on_confirm: quote.price ${onConfirmPrice} does not match /on_init quote.price ${onInitPrice}`
            );
          } else {
            testResults.passed.push(`on_confirm: quote.price ${onConfirmPrice} matches /on_init quote.price`);
          }
        }
        if (confirmData?.tags && order.tags) {
          if (areGSTNumbersMatching(confirmData.tags, order.tags, "bap_terms") === false) {
            testResults.failed.push("on_confirm: bap_terms GST number mismatches /confirm");
          } else {
            testResults.passed.push("on_confirm: bap_terms GST number matches /confirm");
          }
          if (areGSTNumbersMatching(confirmData.tags, order.tags, "bpp_terms") === false) {
            testResults.failed.push("on_confirm: bpp_terms GST number mismatches /confirm");
          } else {
            testResults.passed.push("on_confirm: bpp_terms GST number matches /confirm");
          }
        }
        if (onInitData?.tags && order.tags) {
          const bppTermsTag = order.tags.find((t: any) => t.code === "bpp_terms");
          const onInitBppTermsTag = onInitData.tags.find((t: any) => t.code === "bpp_terms");
          if (bppTermsTag && onInitBppTermsTag) {
            const mismatches = compareLists(bppTermsTag.list || [], onInitBppTermsTag.list || []);
            if (mismatches.length > 0) {
              testResults.failed.push(`on_confirm: bpp_terms list mismatches /on_init — ${mismatches.join("; ")}`);
            } else {
              testResults.passed.push("on_confirm: bpp_terms list matches /on_init");
            }
          }
        }
        // TAT is BPP-quoted, so it's compared against /on_select (not /select).
        const onSelectFulfillmentTat: Record<string, number> = Object.fromEntries(
          (onSelectData?.fulfillments || [])
            .filter((f: any) => f?.id)
            .map((f: any) => [f.id, isoDurToSec(f["@ondc/org/TAT"])])
        );
        for (const ff of order.fulfillments || []) {
          const expected = onSelectFulfillmentTat[ff.id];
          if (expected !== undefined) {
            if (isoDurToSec(ff["@ondc/org/TAT"]) !== expected) {
              testResults.failed.push(
                `on_confirm: fulfillment "${ff.id}" TAT ${isoDurToSec(ff["@ondc/org/TAT"])}s mismatches on_select's ${expected}s`
              );
            } else {
              testResults.passed.push(`on_confirm: fulfillment "${ff.id}" TAT matches /on_select's TAT`);
            }
          }
        }
        // Store (provider) gps is catalog info, so it's compared against /on_search.
        // A provider can have multiple serviceable locations (common for
        // multi-outlet chains), each with its own gps — comparing every
        // fulfillment against locations[0] unconditionally flagged a false
        // mismatch whenever the order's actual store was a different one.
        // Match by the fulfillment's own start.location.id when present
        // (this is how a multi-location provider's catalog ties an item to
        // the store it's served from); only fall back to locations[0] when
        // there's no id to match on, preserving prior behaviour for
        // single-location providers.
        const onSearchProviders = Array.isArray(onSearchData?.providers)
          ? onSearchData.providers
          : onSearchData?.providers
          ? [onSearchData.providers]
          : [];
        const matchedProvider = onSearchProviders.find((p: any) => p?.id === order.provider?.id);
        checkProviderCredsConsistency(order, onSearchData, flowId, "on_confirm", testResults);
        const providerLocations = Array.isArray(matchedProvider?.locations) ? matchedProvider.locations : [];
        if (providerLocations.length > 0) {
          for (const ff of order.fulfillments || []) {
            const ffLocationId = ff?.start?.location?.id;
            const matchedLocation =
              (ffLocationId && providerLocations.find((l: any) => l?.id === ffLocationId)) || providerLocations[0];
            const providerGps = matchedLocation?.gps;
            if (providerGps) {
              if (!compareCoordinates(ff?.start?.location?.gps, providerGps)) {
                testResults.failed.push(`on_confirm: fulfillment "${ff.id}".start.location.gps (store location) changed`);
              } else {
                testResults.passed.push(`on_confirm: fulfillment "${ff.id}".start.location.gps (store location) unchanged`);
              }
            }
          }
        }
      });
    } catch (_) {}
  }

  addDefaultValidationMessage(testResults, action);
  return testResults;
}
