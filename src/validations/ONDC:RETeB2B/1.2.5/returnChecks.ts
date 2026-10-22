import { TestResult } from "../../../types/payload";
import { failureGate, tagGroupsByCode, tagValue } from "./onSearchB2BChecks";

// Business checks for the post-delivery adjustment legs of ONDC:RETeB2B 1.2.5 — the
// buyer-initiated return (`update_return`, `on_update_return_*`, `*_settlement_trail`) and
// the seller-side part cancellation (`on_update_part_cancel`, `update_settlement_trail`).
//
// ---------------------------------------------------------------------------
// CALIBRATION
// ---------------------------------------------------------------------------
// Every rule below holds on all three sources, and was written against them:
//
//   live    session C9fAExqD2HDYdrY4Pln6_R3kiQozxBBy — PARTIAL return, 6 of 12 x I1 @ 52.00
//           quote 624.00 -> 312.00, quote_trail -312, refund 312
//   spec    Buyer_Initiated_Return__Full_Order_and_Partial_Order_.yaml examples — FULL
//           return, 20 of 20 x I1 @ 52.00, quote 1040.00 -> 0.00, quote_trail -1040, refund 1040
//   spec    Merchant_Side_RTO_and_Part_Order_Cancellation_Flow.yaml examples — part CANCEL,
//           1 of 1 x I1 @ 52.00, quote 52.00 -> 0.00, quote_trail -52.00, refund 52.00
//
// Shapes the rules depend on, identical across the three:
//   - the adjusting fulfillment is a SEPARATE fulfillment of type `Return` / `Cancel`; the
//     original `Delivery` fulfillment stays in place;
//   - once the adjustment is booked, the moved quantity sits on an items[] entry whose
//     fulfillment_id is the Return/Cancel fulfillment, and the Delivery entry keeps the rest;
//   - the money moves as a `quote_trail` tag group on the Return/Cancel fulfillment, one group
//     per item, with a NEGATIVE value;
//   - the refund is a `settlement_phase: refund` entry on `update_settlement_trail`.
//
// Shapes that differ, and which the rules therefore tolerate:
//   - `update_return`'s Return fulfillment has an `id` in the live run but NONE in the spec
//     example — the raised id is `return_request.id`, with fulfillment.id as the fallback;
//   - a part cancel drops the item's breakup line entirely (RTO), where a full return keeps it
//     at count 0 (spec) — a missing breakup line counts as quantity 0, and the unit price is
//     read from confirm's breakup first for that reason;
//   - quote_trail first appears at `Return_Picked` (spec + live). The spec TEMPLATE also shows
//     one at `Return_Initiated`, but the example does not, and the example is authoritative.
//
// Deliberate non-checks are listed in docs/RETeB2B-return-validations.md.

/** Ordered lifecycle of a Return fulfillment in the eB2B flows. */
const RETURN_STATE_RANK: Record<string, number> = {
  Return_Initiated: 1,
  Return_Approved: 2,
  Return_Picked: 3,
  Return_Delivered: 4,
};

/** The Return fulfillment state each buyer-return `on_update` leg must report. */
export const RETURN_LEGS: Record<string, string> = {
  on_update_return_init: "Return_Initiated",
  on_update_return_approved: "Return_Approved",
  on_update_return_picked: "Return_Picked",
  on_update_settlement_trail: "Return_Delivered",
};

/** From these states on, the seller has booked the return and must show the money moving. */
const TRAIL_REQUIRED_STATES = new Set(["Return_Picked", "Return_Delivered"]);

const MONEY_EPSILON = 0.01;

/** Saved save-spec values come back as a bare object when the match has one element. */
export function asArray(value: any): any[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function stateCode(fulfillment: any): string | undefined {
  return fulfillment?.state?.descriptor?.code;
}

function returnFulfillments(fulfillments: any): any[] {
  return asArray(fulfillments).filter((f: any) => f?.type === "Return");
}

/**
 * Fulfillments that take quantity (and money) off the order: a buyer Return, a seller part
 * Cancel, and — since the RTO on_cancel books its returned quantity the same way (contract
 * "/on_cancel (RTO flow)": items move onto the RTO fulfillment, which carries the quote_trail)
 * — an RTO.
 */
const ADJUSTMENT_TYPES = new Set(["Return", "Cancel", "RTO"]);

function adjustmentFulfillments(fulfillments: any): any[] {
  return asArray(fulfillments).filter((f: any) => ADJUSTMENT_TYPES.has(f?.type));
}

function toAmount(value: any): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sameAmount(a: number, b: number): boolean {
  return Math.abs(a - b) < MONEY_EPSILON;
}

interface ReturnRequest {
  id?: string;
  itemId?: string;
  quantity?: string;
  images?: unknown;
}

function returnRequestOf(fulfillment: any): ReturnRequest | null {
  const list = tagGroupsByCode(fulfillment?.tags, "return_request")[0]?.list;
  if (!Array.isArray(list)) return null;
  return {
    id: tagValue(list, "id"),
    itemId: tagValue(list, "item_id"),
    quantity: tagValue(list, "item_quantity"),
    images: tagValue(list, "images"),
  };
}

const HTTP_URL = /^https?:\/\/\S+$/i;

/**
 * `return_request.images`: every /update return example in the contract carries it (a
 * comma-separated list of https URLs) with no "optional" annotation, and both the spec
 * example and the workbench buyer mock send one https URL. Raised by the manual tester
 * (docs/RETeB2B-tester-bugs-coverage.md B13); L1 only validates it when sent.
 */
function returnImagesProblem(images: unknown): string | null {
  if (images === undefined || images === null) return "return_request.images is missing";
  if (typeof images !== "string" || !images.trim()) {
    return "return_request.images must be a non-empty, comma-separated list of image URLs";
  }
  const bad = images.split(",").map((u) => u.trim()).filter((u) => !HTTP_URL.test(u));
  return bad.length > 0
    ? `return_request.images has ${bad.length} entry/entries that are not http(s) URLs ('${bad.join("', '")}')`
    : null;
}

interface TrailEntry {
  type?: string;
  id?: string;
  value: number | null;
  raw?: string;
}

function quoteTrailOf(fulfillment: any): TrailEntry[] {
  return tagGroupsByCode(fulfillment?.tags, "quote_trail").map((group: any) => {
    const raw = tagValue(group?.list, "value");
    return {
      type: tagValue(group?.list, "type"),
      id: tagValue(group?.list, "id"),
      value: toAmount(raw),
      raw,
    };
  });
}

/** Sum of item quantity.count for `itemId`, optionally restricted to one fulfillment. */
function itemQuantity(items: any, itemId: string, fulfillmentId?: string): number {
  return asArray(items)
    .filter((it: any) => it?.id === itemId)
    .filter((it: any) => fulfillmentId === undefined || it?.fulfillment_id === fulfillmentId)
    .reduce((sum: number, it: any) => sum + (Number(it?.quantity?.count) || 0), 0);
}

function breakupItemLine(breakup: any, itemId: string): any | undefined {
  return asArray(breakup).find(
    (b: any) => b?.["@ondc/org/item_id"] === itemId && b?.["@ondc/org/title_type"] === "item"
  );
}

/**
 * The id the buyer raised the return under. `update_return` carries it as
 * `return_request.id`; the live run also repeats it as fulfillment.id, the spec example does
 * not. `update_settlement_trail` overwrites the saved `update`, and carries only
 * fulfillment.id — so both are read.
 */
export function resolveRaisedReturnId(savedUpdate: any): string | undefined {
  const fulfillment = returnFulfillments(savedUpdate?.fulfillments)[0];
  if (!fulfillment) return undefined;
  return returnRequestOf(fulfillment)?.id || fulfillment?.id;
}

// ---------------------------------------------------------------------------
// update (update_target: item) — the buyer raising the return
// ---------------------------------------------------------------------------

/**
 * The return request is the anchor every later leg is reconciled against, so it must be
 * complete: an id to follow, the item, and a positive quantity no larger than was ordered.
 */
export function validateReturnRequest(
  order: any,
  confirmItems: any,
  label: string,
  result: TestResult
): void {
  const returns = returnFulfillments(order?.fulfillments);
  if (returns.length === 0) {
    result.failed.push(`${label}: update_target 'item' raises no fulfillment of type 'Return'`);
    return;
  }

  const ok = failureGate(result);
  const ordered = asArray(confirmItems);
  returns.forEach((fulfillment: any, index: number) => {
    const ref = `fulfillments[type=Return][${index}]`;
    const request = returnRequestOf(fulfillment);
    if (!request) {
      result.failed.push(`${label}: ${ref} has no return_request tag`);
      return;
    }
    if (!request.id) result.failed.push(`${label}: ${ref} return_request.id is missing`);
    if (fulfillment?.id && request.id && fulfillment.id !== request.id) {
      result.failed.push(
        `${label}: ${ref}.id '${fulfillment.id}' does not match its return_request.id '${request.id}'`
      );
    }
    if (!request.itemId) result.failed.push(`${label}: ${ref} return_request.item_id is missing`);
    const imagesProblem = returnImagesProblem(request.images);
    if (imagesProblem) result.failed.push(`${label}: ${ref} ${imagesProblem}`);

    const qty = Number(request.quantity);
    if (!Number.isInteger(qty) || qty <= 0) {
      result.failed.push(
        `${label}: ${ref} return_request.item_quantity '${request.quantity}' must be a positive integer`
      );
      return;
    }

    if (request.itemId && ordered.length > 0) {
      const orderedQty = itemQuantity(ordered, request.itemId);
      if (orderedQty === 0) {
        result.failed.push(`${label}: ${ref} returns item '${request.itemId}', which was not in the confirmed order`);
      } else if (qty > orderedQty) {
        result.failed.push(
          `${label}: ${ref} returns ${qty} x '${request.itemId}' but only ${orderedQty} were ordered`
        );
      }
    }
  });

  if (ok()) {
    const summary = returns
      .map((f: any) => {
        const r = returnRequestOf(f);
        const imageCount = String(r?.images ?? "").split(",").filter((u) => u.trim()).length;
        return `'${r?.id}' (${r?.quantity} x ${r?.itemId}, ${imageCount} image(s))`;
      })
      .join(", ");
    result.passed.push(`${label}: return request ${summary} is complete and within the ordered quantity`);
  }
}

// ---------------------------------------------------------------------------
// on_update — the seller walking the return through its lifecycle
// ---------------------------------------------------------------------------

/**
 * Each buyer-return leg must report exactly the Return state its action_id promises, and a
 * Return fulfillment must never move backwards relative to the previous on_update. An
 * unrecognised action_id (e.g. `on_update_part_cancel`) skips the per-leg rule.
 */
export function validateReturnStateProgression(
  order: any,
  actionId: string,
  previousOnUpdate: any,
  label: string,
  result: TestResult
): void {
  const returns = returnFulfillments(order?.fulfillments);
  const expected = RETURN_LEGS[actionId];

  if (expected) {
    if (returns.length === 0) {
      result.failed.push(`${label}: no fulfillment of type 'Return' — this return update must include one in state '${expected}'`);
      return;
    }
    const wrong = returns.filter((f: any) => stateCode(f) !== expected);
    if (wrong.length > 0) {
      wrong.forEach((f: any) =>
        result.failed.push(
          `${label}: Return fulfillment '${f?.id}' is in state '${stateCode(f)}', expected '${expected}' at this step of the return`
        )
      );
    } else {
      result.passed.push(`${label}: all ${returns.length} Return fulfillment(s) report the expected state '${expected}'`);
    }
  }

  if (returns.length === 0) return;

  const previous = returnFulfillments(previousOnUpdate?.fulfillments);
  if (previous.length === 0) {
    result.passed.push(`${label}: first on_update carrying a Return fulfillment — no earlier state to compare`);
    return;
  }

  const ok = failureGate(result);
  const transitions: string[] = [];
  returns.forEach((f: any) => {
    const before = previous.find((p: any) => p?.id === f?.id);
    const from = stateCode(before);
    const to = stateCode(f);
    if (!before || !from || !to) return;
    const fromRank = RETURN_STATE_RANK[from];
    const toRank = RETURN_STATE_RANK[to];
    if (fromRank === undefined || toRank === undefined) return;
    if (toRank < fromRank) {
      result.failed.push(`${label}: Return fulfillment '${f.id}' moved backwards from '${from}' to '${to}'`);
    } else {
      transitions.push(`'${f.id}' ${from} -> ${to}`);
    }
  });
  if (ok()) {
    result.passed.push(
      transitions.length > 0
        ? `${label}: Return state progresses in order (${transitions.join(", ")})`
        : `${label}: no Return fulfillment shared with the previous on_update in a ranked state — progression not compared`
    );
  }
}

/**
 * A return is raised against a delivered order, so while a Return fulfillment is in play the
 * forward `Delivery` fulfillment must still read `Order-delivered`: the Return fulfillment
 * carries the return's lifecycle, and the Delivery leg does not change because of it. All 10
 * contract `/on_update` return examples (Return_Initiated through Liquidated, Return_Rejected
 * and Return_Delivered) keep Delivery at `Order-delivered`, as do all four BIR spec legs.
 *
 * SELF-GATING on the presence of a Return fulfillment. A part-cancel on_update (a `Cancel`
 * fulfillment, Delivery still `Pending`) and an order with no return are skipped, not passed.
 */
export function validateDeliveryStaysDeliveredDuringReturn(order: any, label: string, result: TestResult): void {
  const fulfillments = asArray(order?.fulfillments);
  if (returnFulfillments(fulfillments).length === 0) return;

  const deliveries = fulfillments.filter((f: any) => f?.type === "Delivery");
  if (deliveries.length === 0) {
    result.failed.push(`${label}: a return is in progress but the order carries no Delivery fulfillment — the delivered forward shipment must stay on the order`);
    return;
  }

  const cleanRun = failureGate(result);
  for (const f of deliveries) {
    const code = stateCode(f);
    if (code !== "Order-delivered") {
      result.failed.push(
        `${label}: Delivery fulfillment ${f?.id ?? "?"} is '${code ?? "missing"}' during a return — it must stay 'Order-delivered' (the return's state belongs on the Return fulfillment)`
      );
    }
  }
  if (cleanRun()) {
    result.passed.push(`${label}: ${deliveries.length} Delivery fulfillment(s) remain 'Order-delivered' while the return is in progress`);
  }
}

/**
 * The seller must keep answering under the id the buyer raised: a Return fulfillment with
 * that id must be present, its own return_request.id must agree with it, and the item and
 * quantity must still be what the buyer asked to return.
 *
 * `raisedFrom` is update_return's saved data when it still holds the return_request, and the
 * previous on_update's otherwise (update_settlement_trail overwrites the saved `update`).
 */
export function validateReturnIdContinuity(
  order: any,
  raisedId: string | undefined,
  raisedFrom: any,
  label: string,
  result: TestResult
): void {
  const returns = returnFulfillments(order?.fulfillments);
  if (returns.length === 0) return;

  if (!raisedId) {
    result.passed.push(`${label}: Return fulfillment id not compared — no update_return request was found earlier in this flow`);
    return;
  }

  const ok = failureGate(result);
  const match = returns.find((f: any) => f?.id === raisedId);
  if (!match) {
    result.failed.push(
      `${label}: no Return fulfillment carries the id the buyer raised ('${raisedId}'); found ${returns
        .map((f: any) => `'${f?.id}'`)
        .join(", ")}`
    );
    return;
  }

  const request = returnRequestOf(match);
  if (request?.id && request.id !== raisedId) {
    result.failed.push(`${label}: Return fulfillment '${raisedId}' carries return_request.id '${request.id}'`);
  }

  const raisedFulfillment = returnFulfillments(raisedFrom?.fulfillments).find(
    (f: any) => (returnRequestOf(f)?.id || f?.id) === raisedId
  );
  const raised = raisedFulfillment ? returnRequestOf(raisedFulfillment) : null;
  if (raised && request) {
    if (raised.itemId && request.itemId !== raised.itemId) {
      result.failed.push(
        `${label}: return '${raisedId}' item_id changed from '${raised.itemId}' to '${request.itemId}'`
      );
    }
    if (raised.quantity && request.quantity !== raised.quantity) {
      result.failed.push(
        `${label}: return '${raisedId}' item_quantity changed from '${raised.quantity}' to '${request.quantity}'`
      );
    }
  }

  if (ok()) {
    result.passed.push(
      raised && request
        ? `${label}: Return fulfillment '${raisedId}' matches the return the buyer raised (${request.quantity} x ${request.itemId})`
        : `${label}: Return fulfillment '${raisedId}' matches the id the buyer raised`
    );
  }
}

/**
 * Reconciles the money on a Return/Cancel/RTO fulfillment:
 *  - every `quote_trail` item entry equals -(moved quantity x unit price);
 *  - for a return, the moved quantity equals what the buyer asked to return;
 *  - the item's remaining breakup count equals ordered minus moved;
 *  - the order total dropped by exactly the trail: quote = confirm quote + sum(quote_trail).
 * A Return fulfillment at Return_Picked or later must carry the quote_trail.
 */
export function validateAdjustmentArithmetic(
  order: any,
  confirmData: any,
  label: string,
  result: TestResult
): void {
  const adjustments = adjustmentFulfillments(order?.fulfillments);
  if (adjustments.length === 0) return;

  const ok = failureGate(result);
  const items = order?.items;
  const breakup = order?.quote?.breakup;
  const confirmBreakup = confirmData?.quote_breakup;
  const confirmItems = confirmData?.items;
  const notes: string[] = [];
  let trailTotal = 0;
  let trailSeen = false;
  // The remaining-quantity rule is per ITEM, but it is reached once per quote_trail entry — an
  // item cancelled in part and RTO'd for the rest carries two trails (Cancel + RTO).
  const remainingChecked = new Set<string>();

  adjustments.forEach((f: any) => {
    const trail = quoteTrailOf(f);
    const state = stateCode(f);
    if (trail.length === 0) {
      if (f?.type === "Return" && state && TRAIL_REQUIRED_STATES.has(state)) {
        result.failed.push(
          `${label}: Return fulfillment '${f?.id}' is '${state}' but carries no quote_trail — the refund is not booked`
        );
      }
      return;
    }
    trailSeen = true;
    const request = f?.type === "Return" ? returnRequestOf(f) : null;

    trail.forEach((entry: TrailEntry) => {
      if (entry.value === null) {
        result.failed.push(`${label}: ${f.type} '${f?.id}' quote_trail value '${entry.raw}' is not a number`);
        return;
      }
      trailTotal += entry.value;
      if (entry.value > 0) {
        result.failed.push(`${label}: ${f.type} '${f?.id}' quote_trail value ${entry.raw} must be negative`);
      }
      const itemId = entry.id;
      if (entry.type !== "item" || !itemId) return;

      const moved = itemQuantity(items, itemId, f?.id);
      if (request?.itemId === itemId && request.quantity !== undefined && moved !== Number(request.quantity)) {
        result.failed.push(
          `${label}: Return '${f?.id}' moves ${moved} x '${itemId}' in items[] but the buyer asked to return ${request.quantity}`
        );
      }

      const unitRaw =
        breakupItemLine(confirmBreakup, itemId)?.item?.price?.value ??
        breakupItemLine(breakup, itemId)?.item?.price?.value;
      const unit = toAmount(unitRaw);
      if (unit === null) {
        notes.push(`unit price of '${itemId}' unavailable — trail value not recomputed`);
      } else {
        const expected = -(moved * unit);
        if (!sameAmount(entry.value, expected)) {
          result.failed.push(
            `${label}: ${f.type} '${f?.id}' quote_trail for '${itemId}' is ${entry.raw}, expected ${expected.toFixed(2)} (${moved} x ${unit.toFixed(2)})`
          );
        }
      }

      if (asArray(confirmItems).length > 0 && !remainingChecked.has(itemId)) {
        remainingChecked.add(itemId);
        const ordered = itemQuantity(confirmItems, itemId);
        const allMoved = adjustments.reduce(
          (sum: number, a: any) => sum + itemQuantity(items, itemId, a?.id),
          0
        );
        const line = breakupItemLine(breakup, itemId);
        const remaining = line ? Number(line?.["@ondc/org/item_quantity"]?.count) || 0 : 0;
        if (remaining !== ordered - allMoved) {
          result.failed.push(
            `${label}: breakup still bills ${remaining} x '${itemId}', expected ${ordered - allMoved} (${ordered} ordered - ${allMoved} returned/cancelled/RTO)`
          );
        }
      }
    });
  });

  if (trailSeen) {
    const baseline = toAmount(confirmData?.quote_price);
    const current = toAmount(order?.quote?.price?.value);
    if (baseline === null || current === null) {
      notes.push("confirm quote unavailable — total reduction not reconciled");
    } else if (!sameAmount(current, baseline + trailTotal)) {
      result.failed.push(
        `${label}: quote.price.value ${current.toFixed(2)} does not equal the confirmed ${baseline.toFixed(2)} plus quote_trail ${trailTotal.toFixed(2)} (${(baseline + trailTotal).toFixed(2)})`
      );
    }
  }

  if (ok()) {
    result.passed.push(
      trailSeen
        ? `${label}: quote_trail ${trailTotal.toFixed(2)} reconciles with the returned/cancelled quantity, the remaining breakup and the quote total${notes.length ? ` (${notes.join("; ")})` : ""}`
        : `${label}: no quote_trail yet on ${adjustments.length} Return/Cancel/RTO fulfillment(s) — nothing to reconcile at this stage`
    );
  }
}

// ---------------------------------------------------------------------------
// update (update_target: payment) — the buyer app reporting the refund
// ---------------------------------------------------------------------------

/**
 * The refund the buyer app reports must be for the fulfillment the seller booked, and for
 * exactly the amount the seller took off the order in quote_trail.
 */
export function validateRefundSettlement(
  order: any,
  previousOnUpdate: any,
  label: string,
  result: TestResult
): void {
  const refunds = asArray(order?.payments).flatMap((p: any) =>
    asArray(p?.["@ondc/org/settlement_details"]).filter((s: any) => s?.settlement_phase === "refund")
  );
  if (refunds.length === 0) {
    result.failed.push(`${label}: update_target 'payment' carries no settlement_details entry with settlement_phase 'refund'`);
    return;
  }

  const ok = failureGate(result);
  let refundTotal = 0;
  refunds.forEach((s: any, index: number) => {
    const amount = toAmount(s?.settlement_amount);
    if (amount === null || amount <= 0) {
      result.failed.push(`${label}: refund[${index}].settlement_amount '${s?.settlement_amount}' must be a positive amount`);
    } else {
      refundTotal += amount;
    }
  });

  const booked = adjustmentFulfillments(previousOnUpdate?.fulfillments);
  const claimed = adjustmentFulfillments(order?.fulfillments);
  if (booked.length === 0) {
    if (ok()) {
      result.passed.push(`${label}: refund ${refundTotal.toFixed(2)} declared — no earlier on_update to reconcile it against`);
    }
    return;
  }

  claimed.forEach((f: any) => {
    if (!booked.some((b: any) => b?.id === f?.id)) {
      result.failed.push(
        `${label}: refund is for ${f?.type} fulfillment '${f?.id}', which the seller never booked (on_update has ${booked
          .map((b: any) => `'${b?.id}'`)
          .join(", ")})`
      );
    }
  });

  const trail = booked.flatMap((f: any) => quoteTrailOf(f));
  const bookedTotal = trail.reduce((sum: number, e: TrailEntry) => sum + (e.value ?? 0), 0);
  if (trail.length === 0) {
    result.failed.push(`${label}: refund ${refundTotal.toFixed(2)} declared but the previous on_update booked no quote_trail`);
  } else if (!sameAmount(refundTotal, -bookedTotal)) {
    result.failed.push(
      `${label}: refund ${refundTotal.toFixed(2)} does not match the ${(-bookedTotal).toFixed(2)} the seller took off the order in quote_trail`
    );
  }

  if (ok()) {
    result.passed.push(
      `${label}: refund ${refundTotal.toFixed(2)} matches the quote_trail on ${booked
        .map((b: any) => `${b?.type} '${b?.id}'`)
        .join(", ")}`
    );
  }
}
