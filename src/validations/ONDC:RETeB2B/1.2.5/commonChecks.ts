import { TestResult } from "../../../types/payload";
import { failureGate } from "./onSearchB2BChecks";

/**
 * Common validation utilities for RETeB2B 1.2.5 flows.
 */

/**
 * ISO-8601 duration, as eB2B actually uses it. Accepts the date-part designators
 * (`P1D`, `P3M`) as well as the time part (`PT4H`, `PT30S`), and rejects a bare `P`
 * or a `T` with nothing after it.
 *
 * Deliberately broader than the B2C retail prior art's `^PT\d+[MH]$`: eB2B's
 * `@ondc/org/settlement_window` is `P1D` in every reference payload across all nine
 * order flows, which that narrower pattern would reject. Lives here rather than in
 * selectChecks.ts because both the select leg (`@ondc/org/TAT`) and the order-formation
 * leg (`@ondc/org/settlement_window`) need it.
 */
export const ISO8601_DURATION = /^P(?!$)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/;

/**
 * Validate GPS coordinates format: "lat,lng"
 */
/**
 * Parses a timestamp to epoch milliseconds, tolerating a `Date` as well as a string.
 * Returns null when unparseable.
 *
 * The `Date` branch matters. A live payload arrives as JSON, so these fields are strings and
 * plain `Date.parse` would do. But the reference flows in automation-specifications write
 * their timestamps UNQUOTED, so `js-yaml` hands any fixture-driven harness real `Date`
 * objects — and `String(someDate)` renders "Tue May 19 2026 16:07:17 GMT+0530", with the
 * MILLISECONDS DROPPED. Comparing via `Date.parse(String(x))` therefore collapses two
 * timestamps that differ only in milliseconds, which is exactly the case for
 * order.created_at / updated_at across confirm -> on_confirm (15-74 ms) and across
 * successive on_status legs (12-23 ms). Any cross-leg timestamp comparison must go through
 * this, or it will read as "equal" under test and only behave correctly in production.
 */
export function toMillis(value: any): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = Date.parse(String(value ?? ""));
  return Number.isFinite(ms) ? ms : null;
}

export function validateGpsFormat(gps: string | undefined, fieldPath: string, result: TestResult): void {
  if (!gps) return;
  const parts = gps.split(",");
  if (parts.length !== 2) {
    result.failed.push(`${fieldPath}: GPS must be in 'lat,lng' format, got '${gps}'`);
    return;
  }
  const [lat, lng] = parts.map(Number);
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    result.failed.push(`${fieldPath}: GPS coordinates must be numeric, got '${gps}'`);
  } else if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    result.failed.push(`${fieldPath}: GPS coordinates out of range: lat=${lat}, lng=${lng}`);
  } else {
    result.passed.push(`${fieldPath}: GPS format is valid`);
  }
}

/** Breakup line types whose amounts take money OFF the order, so may be negative. */
const PRICE_REDUCING_TITLE_TYPES = new Set(["offer", "discount"]);

/**
 * Only discount and offer lines may carry negative amounts. Every other `quote.breakup`
 * line (`item`, `delivery`, `packing`, `misc`, `tax`) must have a non-negative line
 * `price.value` and a non-negative unit `item.price.value`, and `quote.price.value` must be
 * non-negative too.
 *
 * Contract basis:
 * - fn 213: `item` is product cost, `delivery` / `packing` / `misc` are charges, `tax` is tax;
 *   `discount` and the order-level offer construct are the reductions.
 * - fn 214: the item price is "exactly as defined in the catalog", and a catalog price is
 *   never negative (validateItemPricing).
 * - Across every contract quote (on_select through on_cancel, part cancel and all return
 *   states), the only negatives are offer line prices and one discount line's unit price
 *   (on_cancel, `item.price.value: "-1201.30"` with a "0.00" line price).
 * - `quote.price.value` is "0.00" on the OOS on_select and on full cancels, and never below
 *   zero.
 *
 * Zero is allowed everywhere: an OOS item quoted at count 0, a cancelled line, free delivery.
 * Calibration (2026-10-22): all spec examples, every mock defaultPayload and the two real log
 * bundles have 0 negatives outside offer lines.
 *
 * Absent values are skipped here (L1 asserts presence); a present non-numeric value fails.
 * Offer lines' own sign ("never positive") is offerChecks' job, so discount and offer lines
 * are exempt here rather than checked twice.
 */
export function validateQuoteAmountSigns(quote: any, result: TestResult, context: string = "quote"): void {
  const breakup: any[] = Array.isArray(quote?.breakup) ? quote.breakup : [];
  if (breakup.length === 0 && quote?.price?.value === undefined) return;

  const cleanRun = failureGate(result);
  // null when the amount is acceptable, otherwise the reason it is not.
  const amountProblem = (raw: any): string | null => {
    const value = Number(raw);
    if (raw === null || String(raw).trim() === "" || Number.isNaN(value)) return "is not a number";
    return value < 0 ? "must be a non-negative amount" : null;
  };

  const total = quote?.price?.value;
  const totalProblem = total === undefined ? null : amountProblem(total);
  if (totalProblem) {
    result.failed.push(`${context}: quote.price.value '${total}' ${totalProblem} — an order total is never below zero`);
  }

  let checked = 0;
  let exempt = 0;
  breakup.forEach((line: any, index: number) => {
    const titleType = line?.["@ondc/org/title_type"];
    if (PRICE_REDUCING_TITLE_TYPES.has(titleType)) {
      exempt++;
      return;
    }
    checked++;
    const ref = `quote.breakup[${index}] (title_type '${titleType ?? "?"}', item '${line?.["@ondc/org/item_id"] ?? "?"}')`;
    const linePrice = line?.price?.value;
    const lineProblem = linePrice === undefined ? null : amountProblem(linePrice);
    if (lineProblem) {
      result.failed.push(`${context}: ${ref} price.value '${linePrice}' ${lineProblem} — only discount/offer lines may be negative`);
    }
    const unitPrice = line?.item?.price?.value;
    const unitProblem = unitPrice === undefined ? null : amountProblem(unitPrice);
    if (unitProblem) {
      result.failed.push(`${context}: ${ref} item.price.value '${unitPrice}' ${unitProblem} — the unit price is the catalog price`);
    }
  });

  if (cleanRun()) {
    result.passed.push(
      `${context}: quote.price and all ${checked} non-discount quote.breakup line(s) carry non-negative amounts` +
        (exempt ? ` (${exempt} discount/offer line(s) exempt)` : "")
    );
  }
}

/**
 * Validate quote breakup: price.value must match sum(breakup[].price.value)
 */
export function validateQuoteBreakup(
  quote: any,
  result: TestResult,
  context: string = "quote"
): void {
  if (!quote?.breakup || !Array.isArray(quote.breakup)) {
    return;
  }

  validateQuoteAmountSigns(quote, result, context);

  const breakup = quote.breakup;

  if (quote?.price?.value) {
    const total = parseFloat(quote.price.value);
    const breakupSum = breakup.reduce((sum: number, b: any) => {
      const val = parseFloat(b?.price?.value || "0");
      return sum + (Number.isNaN(val) ? 0 : val);
    }, 0);

    if (!Number.isNaN(total) && Math.abs(total - breakupSum) > 0.01) {
      result.failed.push(
        `${context}: quote.price.value (${total}) does not match breakup sum (${breakupSum})`
      );
    } else if (!Number.isNaN(total)) {
      result.passed.push(`${context}: quote total matches breakup sum`);
    }
  }
}

/**
 * Validate per-item pricing (price.value is a non-negative number) and, when present,
 * that quantity.selected.count is > 0.
 */
export function validateItemPricing(
  items: any[] | undefined,
  result: TestResult,
  context: string = "items"
): void {
  if (!items || !Array.isArray(items)) return;

  for (const item of items) {
    const priceValue = item?.price?.value;
    if (priceValue !== undefined) {
      const price = parseFloat(String(priceValue));
      if (Number.isNaN(price) || price < 0) {
        result.failed.push(`${context}: item ${item?.id} has invalid price.value '${priceValue}'`);
      } else {
        result.passed.push(`${context}: item ${item?.id} price.value is valid`);
      }
    }

    const count = item?.quantity?.selected?.count;
    if (count !== undefined) {
      const parsedCount = parseInt(count, 10);
      if (Number.isNaN(parsedCount) || parsedCount <= 0) {
        result.failed.push(`${context}: item ${item?.id} quantity.selected.count must be > 0`);
      } else {
        result.passed.push(`${context}: item ${item?.id} quantity ${parsedCount} is valid`);
      }
    }
  }
}

/**
 * Validate order.state against a list of expected values. Note: ONDC retail
 * (unlike mobility/TRV domains) uses `order.state` with title-case values
 * ("Created", "Accepted", "In-progress", "Completed", "Cancelled") — not
 * `order.status`. Confirmed against log-validation-utility's retail 1.2.5
 * checkers (e.g. utils/Retail_.1.2.5/Confirm/onConfirm.ts, Cancel/onCancel.ts).
 */
export function validateOrderState(
  order: any,
  result: TestResult,
  expectedStates: string[],
  context: string = "order"
): void {
  if (!order?.state) return;

  if (expectedStates.includes(order.state)) {
    result.passed.push(`${context}: order.state '${order.state}' is valid`);
  } else {
    result.failed.push(
      `${context}: order.state '${order.state}' is unexpected, expected one of: ${expectedStates.join(", ")}`
    );
  }
}

/**
 * Validate fulfillment state codes — only flags states that are explicitly
 * recognized as valid; does not fail on unrecognized codes.
 */
export function validateFulfillmentState(
  fulfillments: any[] | undefined,
  result: TestResult,
  expectedStates: string[],
  context: string = "order"
): void {
  if (!fulfillments || !Array.isArray(fulfillments)) return;

  for (const f of fulfillments) {
    const stateCode = f?.state?.descriptor?.code;
    if (stateCode && expectedStates.length > 0 && expectedStates.includes(stateCode)) {
      result.passed.push(`${context}: fulfillment ${f.id} state '${stateCode}' is valid`);
    }
  }
}

/**
 * Compare an order id against the order id stored from the flow's CONFIRM call
 * (via the `confirm` save-spec). No-ops when no prior CONFIRM data is stored yet
 * (e.g. save-specs not configured, or this action legitimately precedes confirm).
 */
export function compareOrderIdContinuity(
  currentOrderId: string | undefined,
  storedOrderId: string | undefined,
  actionLabel: string,
  result: TestResult
): void {
  if (!storedOrderId) return;

  if (!currentOrderId) {
    result.failed.push(`${actionLabel}: order id missing, expected '${storedOrderId}' from CONFIRM`);
    return;
  }

  if (String(currentOrderId) === String(storedOrderId)) {
    result.passed.push(`${actionLabel}: order id matches CONFIRM`);
  } else {
    result.failed.push(
      `${actionLabel}: order id '${currentOrderId}' does not match CONFIRM order id '${storedOrderId}'`
    );
  }
}

/**
 * Cross-check a SELECT's chosen provider/items against the provider catalog
 * captured from ON_SEARCH (via the `on_search` save-spec). Written directly
 * against RETeB2B's multi-provider catalog shape (providers: array) rather than
 * reusing actionDataService's compareSelectVsOnSearch, which assumes a single
 * (non-array) provider shape and produces false positives against a retail catalog.
 */
export function validateSelectAgainstCatalog(
  message: any,
  onSearchData: Record<string, any> | null,
  result: TestResult
): void {
  // extractBySpec unwraps a single-element JSONPath match to a bare object, so a
  // one-provider catalog arrives here as an object rather than an array.
  const stored = onSearchData?.providers;
  const providers: any[] = Array.isArray(stored) ? stored : stored ? [stored] : [];
  if (providers.length === 0) return;

  const selectedProviderId = message?.order?.provider?.id;
  if (!selectedProviderId) return;

  const provider = providers.find((p: any) => p?.id === selectedProviderId);
  if (!provider) {
    result.failed.push(`select: provider '${selectedProviderId}' not found in ON_SEARCH catalog`);
    return;
  }
  result.passed.push("select: provider exists in ON_SEARCH catalog");

  const catalogItemIds = new Set((provider.items || []).map((it: any) => it?.id).filter(Boolean));
  const selectedItemIds: string[] = (message?.order?.items || [])
    .map((it: any) => it?.id)
    .filter(Boolean);
  const missingItems = selectedItemIds.filter((id: string) => !catalogItemIds.has(id));

  if (missingItems.length === 0) {
    result.passed.push("select: all selected items exist in ON_SEARCH catalog");
  } else {
    result.failed.push(`select: items not found in ON_SEARCH catalog: ${missingItems.join(", ")}`);
  }
}
