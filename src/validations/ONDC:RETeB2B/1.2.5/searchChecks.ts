import { TestResult } from "../../../types/payload";
import { failureGate, tagGroupsByCode, tagValue } from "./onSearchB2BChecks";

// Business checks for the search request. Rules come from three sources:
//  - the eB2B development guide (broadcast must not carry bpp_id, etc.)
//  - automation-specifications' search-1_validate.js (P2P leg)
//  - log-validation-utility's retail search.ts (finder fee, gps, item/category exclusivity)

const URL_PATTERN = /^https?:\/\/[^\s]+$/;
const BAP_TERMS_CODES = ["static_terms", "static_terms_new", "effective_date"];

// ---------------------------------------------------------------------------
// Context — leg-specific bpp routing rules
// ---------------------------------------------------------------------------

/**
 * The broadcast leg must reach the gateway, not a single BPP. Per the eB2B guide:
 * "Broadcast search with a bpp_id in context is a defect — it silently becomes P2P."
 */
export function validateBroadcastRouting(context: any, result: TestResult): void {
  const cleanRun = failureGate(result);

  for (const key of ["bpp_id", "bpp_uri"]) {
    if (context?.[key] !== undefined && String(context[key]).trim()) {
      result.failed.push(
        `search: broadcast search must not carry context.${key} ('${context[key]}') — it silently becomes a P2P search`
      );
    }
  }

  if (cleanRun()) {
    result.passed.push("search: broadcast search correctly omits bpp_id/bpp_uri");
  }
}

/** The P2P leg targets one seller, so both bpp_id and bpp_uri are mandatory. */
export function validateP2PRouting(context: any, result: TestResult): void {
  const cleanRun = failureGate(result);

  for (const key of ["bpp_id", "bpp_uri"]) {
    if (context?.[key] === undefined || !String(context[key]).trim()) {
      result.failed.push(`search-1: context.${key} is required for a P2P search`);
    }
  }

  if (cleanRun()) {
    result.passed.push(
      `search-1: search sent directly to seller bpp_id '${context?.bpp_id}' with a bpp_uri`
    );
  }
}

/** Ported from search-1_validate.js — a wildcard city defeats seller routing. */
export function validateSearchCity(context: any, result: TestResult): void {
  if (context?.city === "*") {
    result.failed.push("search: context.city must not be '*'");
    return;
  }
  if (context?.city) {
    result.passed.push(`search: context.city '${context.city}' is specific`);
  }
}

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------

export function validateIntentPresence(intent: any, result: TestResult): void {
  if (!intent || typeof intent !== "object" || Object.keys(intent).length === 0) {
    result.failed.push("search: message.intent must be present and non-empty");
    return;
  }
  result.passed.push(`search: message.intent present with [${Object.keys(intent).join(", ")}]`);
}

/** Ported from retail search.ts — intent cannot be both item-scoped and category-scoped. */
export function validateItemCategoryExclusivity(intent: any, result: TestResult): void {
  const hasItem = intent?.item !== undefined;
  const hasCategory = intent?.category !== undefined;

  if (hasItem && hasCategory) {
    result.failed.push(
      "search: message.intent cannot declare both 'item' and 'category' — pick one search scope"
    );
    return;
  }

  result.passed.push(
    hasItem
      ? "search: intent is item-scoped"
      : hasCategory
      ? `search: intent is category-scoped ('${intent.category?.id}')`
      : "search: intent is an open/broad search (neither item nor category)"
  );
}

/**
 * The buyer-app finder fee is how the BPP knows the BAP's commission. The OpenAPI
 * IntentPayment schema requires both the type and the amount together.
 */
export function validateBuyerFinderFee(intent: any, result: TestResult): void {
  const payment = intent?.payment;
  if (!payment) {
    result.failed.push(
      "search: message.intent.payment is required so the buyer-app finder fee is declared"
    );
    return;
  }

  const cleanRun = failureGate(result);
  const feeType = payment["@ondc/org/buyer_app_finder_fee_type"];
  const feeAmount = payment["@ondc/org/buyer_app_finder_fee_amount"];

  if (feeType !== "amount" && feeType !== "percent") {
    result.failed.push(
      `search: buyer_app_finder_fee_type '${feeType}' must be 'amount' or 'percent'`
    );
  }

  const parsed = parseFloat(String(feeAmount ?? ""));
  if (feeAmount === undefined) {
    result.failed.push("search: payment is missing @ondc/org/buyer_app_finder_fee_amount");
  } else if (Number.isNaN(parsed) || parsed < 0) {
    result.failed.push(
      `search: buyer_app_finder_fee_amount '${feeAmount}' must be a non-negative decimal`
    );
  } else if (feeType === "percent" && parsed > 100) {
    result.failed.push(
      `search: buyer_app_finder_fee_amount '${feeAmount}' cannot exceed 100 when the type is 'percent'`
    );
  }

  if (cleanRun()) {
    result.passed.push(`search: buyer-app finder fee is ${feeAmount} (${feeType})`);
  }
}

/** Ported from retail search.ts — when a delivery end is given, it needs usable coordinates. */
export function validateIntentFulfillment(intent: any, result: TestResult): void {
  const fulfillment = intent?.fulfillment;
  if (!fulfillment) {
    result.passed.push("search: intent declares no fulfillment — nothing to validate");
    return;
  }

  const cleanRun = failureGate(result);

  if (fulfillment.type !== undefined) {
    const valid = ["Delivery", "Pickup", "Delivery and Pickup"];
    if (!valid.includes(fulfillment.type)) {
      result.failed.push(
        `search: intent.fulfillment.type '${fulfillment.type}' must be one of ${valid.join(", ")}`
      );
    }
  }

  if (fulfillment.end) {
    const gps = fulfillment.end?.location?.gps;
    if (!gps) {
      result.failed.push(
        "search: intent.fulfillment.end requires location.gps so the seller can judge serviceability"
      );
    } else {
      // "At least 4 decimal places" — matching retail search.ts's own wording, which is
      // looser than the 6 decimals its on_search counterpart demands. eB2B payloads use 4.
      const parts = String(gps).split(",");
      const precise = parts.length === 2 && parts.every((p) => (p.split(".")[1] || "").length >= 4);
      if (!precise) {
        result.failed.push(
          `search: intent.fulfillment.end.location.gps '${gps}' must give at least 4 decimal places of precision`
        );
      }
    }
  }

  if (cleanRun()) {
    result.passed.push(
      `search: intent.fulfillment valid${fulfillment.type ? ` (type '${fulfillment.type}')` : ""}`
    );
  }
}

// ---------------------------------------------------------------------------
// Intent tags — bap_terms / bap_features
// ---------------------------------------------------------------------------

/**
 * bap_terms must carry all three codes, the two term URLs must be URLs, and
 * effective_date must be in the future.
 *
 * Deviation from log-validation-utility's validateTermsList: it compares
 * effective_date against wall-clock `new Date()`, which makes the same captured
 * payload pass today and fail tomorrow. We compare against context.timestamp so a
 * report is reproducible.
 */
export function validateBapTerms(intent: any, contextTimestamp: any, result: TestResult): void {
  const groups = tagGroupsByCode(intent?.tags, "bap_terms");
  if (groups.length === 0) {
    result.failed.push("search: message.intent.tags is missing its bap_terms tag group");
    return;
  }

  const cleanRun = failureGate(result);

  for (const group of groups) {
    for (const code of BAP_TERMS_CODES) {
      const value = tagValue(group.list, code);

      if (value === undefined) {
        result.failed.push(`search: bap_terms is missing required code '${code}'`);
        continue;
      }

      if (code === "effective_date") {
        const effective = new Date(String(value)).getTime();
        if (Number.isNaN(effective)) {
          result.failed.push(`search: bap_terms effective_date '${value}' is not a valid date`);
          continue;
        }
        const reference = contextTimestamp ? new Date(String(contextTimestamp)).getTime() : NaN;
        if (!Number.isNaN(reference) && effective <= reference) {
          result.failed.push(
            `search: bap_terms effective_date '${value}' must be later than context.timestamp '${contextTimestamp}'`
          );
        }
      } else if (!URL_PATTERN.test(String(value))) {
        result.failed.push(`search: bap_terms ${code} '${value}' must be an http(s) URL`);
      }
    }
  }

  if (cleanRun()) {
    result.passed.push(
      "search: bap_terms declares static_terms, static_terms_new and a future effective_date"
    );
  }
}

/**
 * bap_features advertises which optional protocol features the BAP supports. The
 * OpenAPI enum fixes the code list and restricts value to "yes" — a feature is
 * advertised by presence, never disclaimed with "no".
 */
export function validateBapFeatures(intent: any, result: TestResult): void {
  const groups = tagGroupsByCode(intent?.tags, "bap_features");
  if (groups.length === 0) {
    result.passed.push("search: intent declares no bap_features — nothing to validate");
    return;
  }

  const cleanRun = failureGate(result);
  const codes: string[] = [];

  for (const group of groups) {
    if (!Array.isArray(group.list) || group.list.length === 0) {
      result.failed.push("search: bap_features list must not be empty");
      continue;
    }
    for (const entry of group.list) {
      if (!entry?.code || !String(entry.code).trim()) {
        result.failed.push("search: bap_features entry is missing its code");
        continue;
      }
      codes.push(entry.code);
      if (entry.value !== "yes") {
        result.failed.push(
          `search: bap_features '${entry.code}' value '${entry.value}' must be 'yes' — features are advertised by presence`
        );
      }
    }
  }

  if (cleanRun()) {
    result.passed.push(`search: bap_features advertises [${codes.join(", ")}]`);
  }
}

/**
 * P2P retailer identification. search-1_validate.js asks for
 * intent.fulfillment.customer, but the spec's own P2P example identifies the
 * retailer through retailer_mapping tags instead (customer_id, or phone_number/PAN
 * for a retailer the seller hasn't onboarded yet). Either mechanism satisfies this.
 */
export function validateP2PRetailerIdentification(intent: any, result: TestResult): void {
  const cleanRun = failureGate(result);
  const groups = tagGroupsByCode(intent?.tags, "retailer_mapping");
  const hasCustomerObject = Boolean(intent?.fulfillment?.customer);

  if (groups.length === 0 && !hasCustomerObject) {
    result.failed.push(
      "search-1: P2P search must identify the retailer via intent.fulfillment.customer or a retailer_mapping tag group"
    );
    return;
  }

  const identifiers = ["customer_id", "phone_number", "PAN"];
  for (const group of groups) {
    if (!Array.isArray(group.list) || group.list.length === 0) {
      result.failed.push("search-1: retailer_mapping list must not be empty");
      continue;
    }
    const present = identifiers.filter((code) => tagValue(group.list, code));
    if (present.length === 0) {
      result.failed.push(
        `search-1: retailer_mapping must carry at least one of ${identifiers.join(", ")}`
      );
    }
  }

  if (cleanRun()) {
    result.passed.push(
      hasCustomerObject
        ? `search-1: retailer identified via intent.fulfillment.customer${groups.length ? ` and ${groups.length} retailer_mapping group(s)` : ""}`
        : `search-1: retailer identified via ${groups.length} retailer_mapping group(s)`
    );
  }
}
