import { TestResult } from "../../../types/payload";
import { failureGate, tagGroupsByCode, tagValue } from "./onSearchB2BChecks";
import { toMillis } from "./commonChecks";
import { asArray } from "./returnChecks";

// Business checks for cancellation and RTO in ONDC:RETeB2B 1.2.5: `on_cancel` (buyer-initiated
// and the seller's unsolicited RTO), the merchant part cancel carried on `on_update`, and the
// RTO terminal `on_status`.
//
// ---------------------------------------------------------------------------
// SOURCES — and which one wins
// ---------------------------------------------------------------------------
// The API contract (/tmp/ebb2b_doc.txt) is the authority wherever it is unambiguous:
//   - Scenario 1 "Part Cancel by Merchant" (L10650): part cancel only while the fulfillment is
//     `Pending`; a SEPARATE Cancel fulfillment carries cancel_request + quote_trail; the order
//     stays `Accepted`.
//   - "/on_cancel (RTO flow)" (L20143): the Delivery fulfillment goes `Cancelled` with
//     cancel_request {retry_count, rto_id, reason_id, initiated_by} and precancel_state; a new
//     `RTO` fulfillment whose id is that rto_id starts at the buyer's address and ends at the
//     store, state `RTO-Initiated`, with a quote_trail for the returned quantity.
//   - "Fulfillment states & mapping to order states" (L22547): `RTO-Delivered` is the RTO
//     fulfillment's terminal state (order `Cancelled` when every fulfillment is cancelled).
//
// The spec example (automation-specifications Merchant_Side_RTO_and_Part_Order_Cancellation_Flow,
// which the mock copies) contradicts the contract in several places — see
// docs/RETeB2B-merchant-rto-part-cancel-verification.md. Where the contract contradicts ITSELF
// the example is followed instead: the RTO on_cancel example sets `order.state: Cancelled`
// although the state table says RTO-Initiated keeps "the order state before RTO".
//
// Every rule was calibrated (2026-10-14) against the live RTO, return and buyer-cancel sessions
// and the spec examples of all nine eB2B order flows. Deliberate non-checks are listed in the
// verification doc.

function fulfillmentsOf(order: any): any[] {
  return Array.isArray(order?.fulfillments) ? order.fulfillments : [];
}

function stateCode(fulfillment: any): string | undefined {
  return fulfillment?.state?.descriptor?.code;
}

function tagMap(fulfillment: any, code: string): Record<string, string> | null {
  const list = tagGroupsByCode(fulfillment?.tags, code)[0]?.list;
  if (!Array.isArray(list)) return null;
  return Object.fromEntries(list.map((entry: any) => [entry?.code, entry?.value]));
}

function sameLocation(a: any, b: any): boolean {
  return JSON.stringify(a?.address ?? null) === JSON.stringify(b?.address ?? null) && a?.gps === b?.gps;
}

// ---------------------------------------------------------------------------
// on_cancel — every cancellation
// ---------------------------------------------------------------------------

/**
 * Contract L19326: an order cancelled via on_cancel sets the order state "& all fulfillment
 * states" to `Cancelled`. The one exception is the RTO fulfillment an RTO cancellation
 * creates, which starts `RTO-Initiated`.
 */
export function validateCancelledFulfillmentStates(order: any, label: string, result: TestResult): void {
  if (order?.state !== "Cancelled") return;
  const live = fulfillmentsOf(order).filter((f: any) => f?.type !== "RTO" && stateCode(f) !== "Cancelled");
  if (live.length > 0) {
    live.forEach((f: any) =>
      result.failed.push(
        `${label}: order is Cancelled but fulfillment ${f?.id ?? "?"} (type ${f?.type ?? "?"}) is still '${stateCode(f)}' — every non-RTO fulfillment must be Cancelled`
      )
    );
    return;
  }
  result.passed.push(`${label}: order and every non-RTO fulfillment are Cancelled`);
}

/**
 * The order-level `cancellation` block must agree with the fulfillment that was actually
 * cancelled: `reason.id` equals that fulfillment's `cancel_request.reason_id`, and
 * `cancelled_by` names a participant of the transaction (bap_id or bpp_id), as the contract's
 * buyer-cancel example does (`bnp.com`).
 *
 * The contract's RTO example carries no order-level block, so it is only checked when present.
 * Catches the RTO reference's `{cancelled_by: "BPP", reason: "007"}` against the fulfillment's
 * reason `013` — 007 is a retired code in the RET 1.2.5 reason table.
 */
export function validateCancellationAttribution(
  order: any,
  context: any,
  label: string,
  result: TestResult
): void {
  const cancellation = order?.cancellation;
  if (!cancellation) return;

  const ok = failureGate(result);
  const reasonId = cancellation?.reason?.id;
  const requested = fulfillmentsOf(order)
    .filter((f: any) => f?.type === "Delivery")
    .map((f: any) => ({ id: f?.id, reason: tagMap(f, "cancel_request")?.reason_id }))
    .filter((r: any) => r.reason !== undefined);
  requested.forEach((r: any) => {
    if (reasonId !== undefined && String(reasonId) !== String(r.reason)) {
      result.failed.push(
        `${label}: cancellation.reason.id '${reasonId}' disagrees with fulfillment ${r.id}'s cancel_request.reason_id '${r.reason}'`
      );
    }
  });

  const by = cancellation?.cancelled_by;
  const participants = [context?.bap_id, context?.bpp_id].filter(Boolean);
  if (by !== undefined && participants.length > 0 && !participants.includes(by)) {
    result.failed.push(
      `${label}: cancellation.cancelled_by '${by}' is not a participant of this transaction (expected bap_id '${context?.bap_id}' or bpp_id '${context?.bpp_id}')`
    );
  }

  if (ok()) {
    result.passed.push(
      `${label}: cancellation (reason '${reasonId}', by '${by}') agrees with the cancelled fulfillment${requested.length > 1 ? "s" : ""}`
    );
  }
}

/**
 * `precancel_state` records where the fulfillment WAS when it was cancelled, so its
 * `fulfillment_state` must equal the state the seller last reported for it — the previous
 * on_status, or on_confirm when no on_status preceded the cancellation.
 *
 * `updated_at` is compared only against a previous on_status: in both buyer-cancel sources
 * (spec + live) there is none, and the value is re-stamped rather than equal to on_confirm's.
 * Catches the RTO reference's `Pending` after four on_status legs ending `Out-for-delivery`.
 */
export function validatePrecancelState(
  order: any,
  prior: { state?: any; updatedAt?: any; source: string } | null,
  label: string,
  result: TestResult
): void {
  if (!prior) return;
  const priorState = asArray(prior.state)[0];
  const tagged = fulfillmentsOf(order)
    .filter((f: any) => f?.type === "Delivery")
    .map((f: any) => ({ f, pre: tagMap(f, "precancel_state") }))
    .filter((x: any) => x.pre);
  if (tagged.length === 0) return;

  const ok = failureGate(result);
  tagged.forEach(({ f, pre }: any) => {
    if (priorState && pre.fulfillment_state !== priorState) {
      result.failed.push(
        `${label}: fulfillment ${f?.id} precancel_state.fulfillment_state is '${pre.fulfillment_state}', but the ${prior.source} reported it '${priorState}'`
      );
    }
    if (prior.updatedAt !== undefined && prior.updatedAt !== null) {
      const at = toMillis(pre.updated_at);
      const expected = toMillis(prior.updatedAt);
      if (at === null || expected === null || at !== expected) {
        result.failed.push(
          `${label}: fulfillment ${f?.id} precancel_state.updated_at '${pre.updated_at}' is not the ${prior.source}'s updated_at '${prior.updatedAt}'`
        );
      }
    }
  });
  if (ok()) {
    result.passed.push(
      `${label}: precancel_state matches the fulfillment's last reported state ('${priorState}', ${prior.source})`
    );
  }
}

// ---------------------------------------------------------------------------
// on_cancel — RTO
// ---------------------------------------------------------------------------

/**
 * Contract "/on_cancel (RTO flow)": the cancelled Delivery fulfillment carries
 * cancel_request {reason_id, initiated_by, rto_id}; exactly the fulfillment named by rto_id is
 * a new `RTO` fulfillment in `RTO-Initiated`, travelling from the buyer's address (the
 * Delivery fulfillment's end) back to a store location of the provider.
 *
 * Skips silently for a cancellation without an RTO fulfillment, unless the action_id says
 * this is the RTO leg.
 */
export function validateRtoInitiation(order: any, actionId: string, label: string, result: TestResult): void {
  const rtos = fulfillmentsOf(order).filter((f: any) => f?.type === "RTO");
  if (rtos.length === 0) {
    if (actionId === "on_cancel_rto") {
      result.failed.push(`${label}: no fulfillment of type 'RTO' — an RTO cancellation must create one in state 'RTO-Initiated'`);
    }
    return;
  }

  const ok = failureGate(result);
  const deliveries = fulfillmentsOf(order).filter((f: any) => f?.type === "Delivery");
  const providerLocations = new Set(asArray(order?.provider?.locations).map((l: any) => l?.id).filter(Boolean));

  rtos.forEach((rto: any) => {
    const ref = `RTO fulfillment '${rto?.id}'`;
    if (stateCode(rto) !== "RTO-Initiated") {
      result.failed.push(`${label}: ${ref} is '${stateCode(rto)}', expected 'RTO-Initiated' when the RTO is raised`);
    }
    const origin = deliveries.find((d: any) => tagMap(d, "cancel_request")?.rto_id === rto?.id);
    if (!origin) {
      result.failed.push(`${label}: ${ref} is not named by any Delivery fulfillment's cancel_request.rto_id`);
      return;
    }
    const request = tagMap(origin, "cancel_request") || {};
    for (const key of ["reason_id", "initiated_by"]) {
      if (!request[key]) result.failed.push(`${label}: fulfillment ${origin.id} cancel_request.${key} is missing`);
    }
    if (stateCode(origin) !== "Cancelled") {
      result.failed.push(`${label}: fulfillment ${origin.id} raised RTO '${rto.id}' but is '${stateCode(origin)}', not Cancelled`);
    }
    if (!sameLocation(rto?.start?.location, origin?.end?.location)) {
      result.failed.push(`${label}: ${ref} start.location is not the buyer's address (fulfillment ${origin.id} end.location) it returns from`);
    }
    const storeId = rto?.end?.location?.id;
    if (!storeId || (providerLocations.size > 0 && !providerLocations.has(storeId))) {
      result.failed.push(`${label}: ${ref} end.location.id '${storeId}' is not one of the provider's locations`);
    }
  });

  deliveries.forEach((d: any) => {
    const rtoId = tagMap(d, "cancel_request")?.rto_id;
    if (rtoId && !rtos.some((r: any) => r?.id === rtoId)) {
      result.failed.push(`${label}: fulfillment ${d.id} cancel_request.rto_id '${rtoId}' names no RTO fulfillment`);
    }
  });

  if (ok()) {
    result.passed.push(
      `${label}: ${rtos.map((r: any) => `RTO '${r.id}'`).join(", ")} raised from the cancelled delivery, returning from the buyer's address to a store location`
    );
  }
}

// ---------------------------------------------------------------------------
// after on_cancel — no resurrection
// ---------------------------------------------------------------------------

/**
 * `Cancelled` is terminal. A fulfillment the seller cancelled at on_cancel must still be
 * `Cancelled` on every later leg. Catches the RTO reference's `on_status_rto_delivered`,
 * which reports the cancelled Delivery fulfillment as `Packed` again.
 */
export function validateNoCancelledFulfillmentRevived(
  order: any,
  savedOnCancel: any,
  label: string,
  result: TestResult
): void {
  const cancelled = asArray(savedOnCancel?.fulfillments).filter((f: any) => stateCode(f) === "Cancelled");
  if (cancelled.length === 0) return;
  const ok = failureGate(result);
  cancelled.forEach((was: any) => {
    const now = fulfillmentsOf(order).find((f: any) => f?.id === was?.id);
    if (now && stateCode(now) !== "Cancelled") {
      result.failed.push(
        `${label}: fulfillment ${was.id} was Cancelled at on_cancel but is now '${stateCode(now)}' — Cancelled is terminal`
      );
    }
  });
  if (ok()) {
    result.passed.push(`${label}: ${cancelled.length} fulfillment(s) cancelled at on_cancel remain Cancelled`);
  }
}

/**
 * Fulfillment id continuity across a cancellation, against the ids saved at on_confirm:
 *
 *  - the Delivery fulfillment keeps its confirmed id. Contract /on_cancel: the Delivery
 *    stays `F1` and only its state moves to Cancelled. A seller renaming it (`F9`) severs the
 *    cancellation from the order the buyer confirmed (the Vistar tester's V17).
 *  - a Cancel or RTO fulfillment carries a NEW id, never one already confirmed. Contract:
 *    Cancel `cancel_id_8189`, RTO `rto_id`, both distinct from F1. Reusing `F1` makes two
 *    records share one id (V16).
 *
 * Both spec on_cancel examples comply (Buyer_Side `F1` + `cancel_id_8189`; RTO `F1` +
 * `part_cancel_id_12391` + `rto_mock_id_121`). A Cancel fulfillment raised earlier at
 * on_update is not confirmed, so carrying it forward is fine. Skips without saved ids.
 */
export function validateCancelFulfillmentIdContinuity(
  order: any,
  confirmedIds: string[],
  label: string,
  result: TestResult
): void {
  const confirmed = new Set(confirmedIds.filter(Boolean).map(String));
  if (confirmed.size === 0) return;
  const fulfillments = fulfillmentsOf(order);
  if (fulfillments.length === 0) return;

  const ok = failureGate(result);
  const confirmedList = [...confirmed].join(", ");

  fulfillments.forEach((f: any) => {
    const id = f?.id === undefined || f?.id === null ? undefined : String(f.id);
    if (f?.type === "Delivery" && id !== undefined && !confirmed.has(id)) {
      result.failed.push(
        `${label}: Delivery fulfillment '${id}' was not confirmed at on_confirm (confirmed: ${confirmedList}) — the Delivery fulfillment must keep its confirmed id`
      );
    }
    if ((f?.type === "Cancel" || f?.type === "RTO") && id !== undefined && confirmed.has(id)) {
      result.failed.push(
        `${label}: ${f.type} fulfillment reuses id '${id}', which was confirmed at on_confirm — ${f.type} fulfillments must carry a new id`
      );
    }
  });

  const present = new Set(fulfillments.map((f: any) => String(f?.id)));
  confirmed.forEach((id) => {
    if (!present.has(id)) {
      result.failed.push(`${label}: confirmed fulfillment '${id}' is missing — it must be carried on the cancellation`);
    }
  });

  if (ok()) {
    result.passed.push(
      `${label}: confirmed fulfillment id(s) ${confirmedList} kept; Cancel/RTO fulfillment(s) carry new ids`
    );
  }
}

// ---------------------------------------------------------------------------
// on_update — merchant part cancel
// ---------------------------------------------------------------------------

/**
 * Contract Scenario 1: "Cancel of item(s) can only be initiated if fulfillment state is
 * Pending", and the Cancel fulfillment carries cancel_request {reason_id, initiated_by}.
 * Applies to Cancel fulfillments that are NEW on this leg (not seen on an earlier leg), so a
 * later leg that merely carries an old part cancel forward is not held to it.
 */
export function validatePartCancelPrecondition(
  order: any,
  knownFulfillmentIds: Set<string>,
  label: string,
  result: TestResult
): void {
  // Without any earlier leg's fulfillment ids there is no way to tell a new part cancel from
  // one carried forward — skip rather than guess.
  if (knownFulfillmentIds.size === 0) return;
  const fresh = fulfillmentsOf(order).filter((f: any) => f?.type === "Cancel" && !knownFulfillmentIds.has(f?.id));
  if (fresh.length === 0) return;

  const ok = failureGate(result);
  fresh.forEach((c: any) => {
    const request = tagMap(c, "cancel_request");
    if (!request) {
      result.failed.push(`${label}: part-cancel fulfillment '${c?.id}' has no cancel_request tag`);
    } else {
      for (const key of ["reason_id", "initiated_by"]) {
        if (!request[key]) result.failed.push(`${label}: part-cancel fulfillment '${c?.id}' cancel_request.${key} is missing`);
      }
    }
  });
  const notPending = fulfillmentsOf(order).filter((f: any) => f?.type === "Delivery" && stateCode(f) !== "Pending");
  notPending.forEach((d: any) =>
    result.failed.push(
      `${label}: part cancel raised while fulfillment ${d?.id} is '${stateCode(d)}' — items can only be part-cancelled while the fulfillment is Pending`
    )
  );
  if (ok()) {
    result.passed.push(
      `${label}: part cancel ${fresh.map((c: any) => `'${c.id}'`).join(", ")} raised while the delivery was Pending, with a complete cancel_request`
    );
  }
}
