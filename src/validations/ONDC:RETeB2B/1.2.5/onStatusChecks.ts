import { TestResult } from "../../../types/payload";
import { failureGate, tagGroupsByCode, tagValue } from "./onSearchB2BChecks";
import { ISO8601_DURATION, validateGpsFormat, toMillis, validateOrderState } from "./commonChecks";
import type { PaymentMode } from "./orderFormationChecks";

// Business and cross-call checks for ONDC:RETeB2B 1.2.5 `on_status`.
//
// ---------------------------------------------------------------------------
// WHY THIS MODULE EXISTS — read before relaxing anything
// ---------------------------------------------------------------------------
// L1 (automation-specifications/config/validations/index.yaml, `on_status:` at line 3581)
// already validates this action's STRUCTURE for this domain: order.id presence + pattern,
// `order.state` against a 5-value enum, `fulfillments[].state.descriptor.code` against a
// 12-value enum, the cancellation block, items, billing, and the fulfillment start
// location / time / instructions tree.
//
// What L1 structurally CANNOT do is correlate any of that with WHICH LEG it is looking at —
// it sees one payload at a time with no flow history. The eB2B flows run up to seven
// on_status legs disambiguated by `action_id`, and the states they must report are fully
// determined by that id. So "state is one of five" (L1's rule, and the old OnStatus.ts
// rule) accepts a seller reporting `Pending` at delivery, while "state is exactly
// `Order-delivered` at `on_status_order_delivered`" does not. That per-leg pin is this
// module's entire reason to exist; it is not a duplicate of L1.
//
// ---------------------------------------------------------------------------
// CALIBRATION — measured over 47 on_status legs in all nine eB2B flows
// ---------------------------------------------------------------------------
// Every value in STATUS_LEGS below is unanimous across the flows that contain that leg.
// Rules the payloads forced us to DROP (do not re-add without re-measuring):
//
//  - Monotonic fulfillment-state advance -> not enforced as a generic rule; the per-leg pin
//    makes it unnecessary. NOTE (corrected 2026-10-14): this bullet used to say the RTO leg
//    "legitimately REVERTS the fulfillment to `Packed`". It does not — that was the RTO spec
//    example's defect, copied here. A Cancelled fulfillment is terminal (rtoChecks
//    .validateNoCancelledFulfillmentRevived) and the RTO leg is about the RTO fulfillment.
//  - `start`/`end` `time.range` or `time.timestamp` PRESENCE -> inconsistent by design.
//    Out_of_Stock never sends a range and always sends timestamps; Buyer_Initiated_Return
//    sends a range at `accepted`; (cod)/(Prepaid)/with_offers send a timestamp at
//    `accepted` and ranges from `packed` on. Only the SHAPE is checked.
//  - `order.documents` required from `picked` on -> present in six of seven flows but
//    absent throughout (Prepaid)_with_igm.
//  - `quote.price.value` no-drift -> FALSE. Merchant_Side_RTO legitimately goes 52.00 at
//    confirm to 0.00 here (part-order cancellation).
//  - `@ondc/org/TAT` echoed from an earlier leg -> FALSE, already established for the
//    confirm leg (PT4H -> P2D). Format-checked per leg only.
//  - `fulfillments[].tracking` echoed from confirm -> FALSE. `false` at confirm and `true`
//    at every on_status leg: the seller switches tracking on once the order is live.
//
// Every cross-call check returns immediately when its stored prior state is absent, adding
// NEITHER a pass NOR a failure, and every check emits exactly one aggregate `passed` entry
// on a clean run via `failureGate`.

/** `routing.type`, confirmed present on 47/47 on_status legs (all `P2H2P` in the fixtures). */
const ROUTING_TYPES = ["P2P", "P2H2P"];
const YES_NO = ["yes", "no"];

export interface StatusLeg {
  /** The exact `order.state` this leg must report. */
  orderState: string;
  /** The exact `fulfillments[].state.descriptor.code` this leg must report. */
  fulfillmentState: string;
  /** Whether a delivery agent must already be attached at this leg. */
  requireAgent: boolean;
  /** Whether this is the leg at which the order completes and COD money is collected. */
  isDelivery: boolean;
  /**
   * The fulfillment `type` this leg reports on. Omitted for the forward-delivery legs, which
   * select the live Delivery fulfillment(s); `RTO` for the RTO terminal leg, which is about the
   * RTO fulfillment — the Delivery fulfillment is already Cancelled by then.
   */
  fulfillmentType?: string;
}

/**
 * The per-leg contract. `n` is the number of reference flows containing that leg; every
 * value below is unanimous across them.
 *
 * `on_status_rto_delivered` is NOT calibrated from its (single) reference example, which is
 * defective: it reports the cancelled Delivery fulfillment as `Packed` again and drops the RTO
 * fulfillment while items still point at it. It follows the contract's state table instead
 * (API contract "Fulfillment states & mapping to order states", RTO section): `RTO-Delivered`
 * is the RTO fulfillment's terminal state, with the order `Cancelled` when every fulfillment
 * is cancelled. No agent is required — the contract's RTO fulfillment carries none. See
 * docs/RETeB2B-merchant-rto-part-cancel-verification.md.
 */
export const STATUS_LEGS: Record<string, StatusLeg> = {
  // action_id                      order.state      fulfillment code     agent  delivery   n
  on_status_accepted:         { orderState: "Accepted",    fulfillmentState: "Pending",          requireAgent: false, isDelivery: false }, // 7
  on_status_packed:           { orderState: "In-progress", fulfillmentState: "Packed",           requireAgent: false, isDelivery: false }, // 8
  on_status_agent_assigned:   { orderState: "In-progress", fulfillmentState: "Agent-assigned",   requireAgent: true,  isDelivery: false }, // 8
  on_status_picked:           { orderState: "In-progress", fulfillmentState: "Order-picked-up",  requireAgent: true,  isDelivery: false }, // 8
  on_status_out_for_delivery: { orderState: "In-progress", fulfillmentState: "Out-for-delivery", requireAgent: true,  isDelivery: false }, // 8
  on_status_order_delivered:  { orderState: "Completed",   fulfillmentState: "Order-delivered",  requireAgent: true,  isDelivery: true },  // 7
  on_status_rto_delivered:    { orderState: "Cancelled",   fulfillmentState: "RTO-Delivered",    requireAgent: false, isDelivery: false, fulfillmentType: "RTO" }, // contract
};

/**
 * Returns the contract for a leg, or null when the `action_id` is not one we have ground
 * truth for. Every leg-specific check below then SKIPS rather than failing — a spec that
 * adds an eighth on_status leg must not make the report start crying about it. The generic
 * enum membership still runs at L1 in that case.
 */
export function resolveStatusLeg(actionId: string | undefined): StatusLeg | null {
  if (!actionId) return null;
  return STATUS_LEGS[actionId] ?? null;
}

function fulfillmentsOf(order: any): any[] {
  return Array.isArray(order?.fulfillments) ? order.fulfillments : [];
}

/**
 * The fulfillments a status leg is actually about.
 *
 * A part-cancelled order carries a SECOND, terminal fulfillment alongside the live one, and
 * it must be excluded from every per-leg rule. `Merchant_Side_RTO...` is the case:
 * from `on_status_packed` onwards it sends both
 *
 *   F1                     type Delivery, state tracks the leg, tags routing+tracking
 *   part_cancel_id_12391   type Cancel,   state Cancelled forever, no agent, no routing tags
 *
 * Pinning every fulfillment to the leg's expected state false-failed that second record on
 * all five of its legs, and the agent rule false-failed it on four — 10 false failures in
 * one flow. A `Cancelled` fulfillment is terminal and a `Cancel`-type fulfillment is a
 * cancellation record rather than a shipment, so both are out of scope. Either guard alone
 * would do for today's payloads; both are kept because each is independently correct.
 */
function deliveryFulfillmentsOf(order: any): any[] {
  return fulfillmentsOf(order).filter((f: any) => {
    if (String(f?.type) === "Cancel") return false;
    // An RTO fulfillment is goods coming BACK, not a shipment to the buyer: it carries no
    // routing/tracking tags in the contract, so the forward-delivery rules must not see it.
    if (String(f?.type) === "RTO") return false;
    if (String(f?.state?.descriptor?.code) === "Cancelled") return false;
    return true;
  });
}

/** The fulfillments a leg's state/agent pin applies to: by type when the leg names one. */
function legFulfillmentsOf(order: any, leg: StatusLeg | null): any[] {
  if (leg?.fulfillmentType) {
    return fulfillmentsOf(order).filter((f: any) => String(f?.type) === leg.fulfillmentType);
  }
  return deliveryFulfillmentsOf(order);
}

function paymentsOf(order: any): any[] {
  return Array.isArray(order?.payments) ? order.payments : [];
}

function isAbsent(value: any): boolean {
  return value === undefined || value === null;
}

/**
 * The core rule: this leg must report exactly the states its `action_id` promises.
 *
 * `order.state` goes through the shared `validateOrderState` with a single-element
 * allow-list, which fails on a mismatch. The fulfillment side is checked here rather than
 * through `commonChecks.validateFulfillmentState`, because that helper only ever emits a
 * PASS — it is documented as not failing on unrecognised codes, which is the opposite of
 * what a per-leg pin needs.
 */
export function validateStatusLegStates(
  order: any,
  leg: StatusLeg | null,
  actionId: string,
  result: TestResult
): void {
  if (!leg) return;

  validateOrderState(order, result, [leg.orderState], `on_status (${actionId})`);

  const fulfillments = legFulfillmentsOf(order, leg);
  if (fulfillments.length === 0) return;

  const cleanRun = failureGate(result);
  let checked = 0;

  for (const fulfillment of fulfillments) {
    const code = fulfillment?.state?.descriptor?.code;
    if (isAbsent(code)) continue;
    checked++;
    if (String(code) !== leg.fulfillmentState) {
      result.failed.push(
        `on_status (${actionId}): fulfillment ${fulfillment?.id ?? "?"} reports state '${code}', but this status update must report '${leg.fulfillmentState}'`
      );
    }
  }

  if (checked > 0 && cleanRun()) {
    result.passed.push(
      `on_status (${actionId}): all ${checked} fulfillment(s) report the expected state '${leg.fulfillmentState}'`
    );
  }
}

/**
 * Once an agent is assigned it must stay attached, with something a buyer could actually
 * call. Required from `agent_assigned` onward (8/8, 8/8, 8/8, 7/7, 1/1) and optional at
 * `accepted`/`packed`, where the fixtures genuinely disagree — the Prepaid flow attaches
 * `Ravi Kumar` at `accepted` while igm, Buyer_Initiated_Return and Out_of_Stock attach
 * nobody until the agent is assigned.
 */
export function validateDeliveryAgent(
  order: any,
  leg: StatusLeg | null,
  actionId: string,
  result: TestResult
): void {
  if (!leg) return;

  const fulfillments = legFulfillmentsOf(order, leg);
  if (fulfillments.length === 0) return;

  const cleanRun = failureGate(result);
  let checked = 0;

  for (const fulfillment of fulfillments) {
    const agent = fulfillment?.agent;
    const ref = `fulfillment ${fulfillment?.id ?? "?"}`;

    if (!agent) {
      if (leg.requireAgent) {
        result.failed.push(
          `on_status (${actionId}): ${ref} has no agent, but the fulfillment is '${leg.fulfillmentState}' — a delivery agent must be attached from Agent-assigned onwards`
        );
      }
      continue;
    }

    checked++;
    if (isAbsent(agent.name) || !String(agent.name).trim()) {
      result.failed.push(`on_status (${actionId}): ${ref} agent.name is required`);
    }
    if (isAbsent(agent.phone) || !String(agent.phone).trim()) {
      result.failed.push(`on_status (${actionId}): ${ref} agent.phone is required`);
    }
  }

  if (checked > 0 && cleanRun()) {
    result.passed.push(`on_status (${actionId}): all ${checked} delivery agent(s) are contactable (name + phone)`);
  }
}

/**
 * THE COD RULE. An `ON-FULFILLMENT` payment is collected when the goods are handed over, so
 * across all four COD flows (`(cod)`, `with_offers(cod)`, `Out_of_Stock`,
 * `Buyer_Initiated_Return`) it is `NOT-PAID` at all five pre-delivery legs and flips to
 * `PAID` exactly at `on_status_order_delivered`. Enforced in BOTH directions:
 *
 *  - PAID is required at the delivery leg, for every payment type (7/7 flows, Prepaid
 *    included — a Prepaid order is already PAID by then).
 *  - an ON-FULFILLMENT payment must still be NOT-PAID at every leg BEFORE delivery, which
 *    catches a seller claiming it collected the money before the goods ever moved.
 *
 * The second clause is scoped to ON-FULFILLMENT on purpose: Prepaid (`ON-ORDER`) is
 * legitimately PAID from `confirm` onwards, so applying it to every payment would
 * false-fail all five Prepaid flows at every leg.
 *
 * Mode is read from the payment itself rather than the flow id: `Buyer_Initiated_Return`
 * and `Merchant_Side_RTO` carry no `(cod)`/`(prepaid)` marker in their names, so
 * `resolvePaymentMode` returns null for them, but their payments are unambiguously
 * ON-FULFILLMENT/COD and ON-ORDER/Prepaid respectively.
 */
export function validateCodSettlementAtDelivery(
  order: any,
  leg: StatusLeg | null,
  actionId: string,
  result: TestResult,
  mode?: PaymentMode | null
): void {
  if (!leg) return;

  const payments = paymentsOf(order);
  if (payments.length === 0) return;

  const cleanRun = failureGate(result);
  let checked = 0;

  payments.forEach((payment: any, index: number) => {
    const status = payment?.status;
    if (isAbsent(status)) return;
    const ref = `payments[${index}]`;
    // COD-ness is decided by the FLOW as well as the payload. Reading only
    // `payment.type` left a hole: a COD flow that flipped to ON-ORDER mid-flight escaped the
    // pre-delivery rule entirely, because nothing re-checks the mode after on_confirm.
    // Taking either signal closes that without losing the four flows whose names carry no
    // mode (Buyer_Initiated_Return, Buyer_Side_Order_Cancellation, Out_of_Stock and the RTO
    // flow) — three of those send ON-FULFILLMENT and are still covered via `type`.
    const onFulfillment = String(payment?.type) === "ON-FULFILLMENT";
    const isCod = mode === "cod" || onFulfillment;
    checked++;

    if (leg.isDelivery) {
      if (String(status) !== "PAID") {
        result.failed.push(
          `on_status (${actionId}): ${ref}.status is '${status}' when the order is delivered — payment must be PAID at delivery${isCod ? " (cash on delivery is collected at this point)" : ""}`
        );
      }
      return;
    }

    // Prepaid is legitimately PAID from `confirm` onward — measured PAID on all 18 prepaid
    // on_status legs, including `accepted` — so this must never fire for a prepaid flow.
    if (isCod && String(status) === "PAID") {
      result.failed.push(
        `on_status (${actionId}): ${ref} already reports PAID while the fulfillment is only '${leg.fulfillmentState}' — this is a cash-on-delivery order (payment type '${payment?.type}'), so payment is collected at delivery, not before`
      );
    }
  });

  if (checked > 0 && cleanRun()) {
    // Worded per mode: a prepaid payment is already PAID here, so "not yet collected" — the
    // old wording for every non-delivery leg — misdescribed every prepaid pass.
    const cod = payments.filter((p: any) => mode === "cod" || String(p?.type) === "ON-FULFILLMENT").length;
    const detail = leg.isDelivery
      ? "PAID at delivery"
      : cod > 0
        ? `COD and not yet collected (fulfillment is '${leg.fulfillmentState}')`
        : `prepaid and already PAID`;
    result.passed.push(`on_status (${actionId}): all ${checked} payment(s) are ${detail}`);
  }
}

/**
 * An order reporting its status must actually be shipping something: at least one
 * fulfillment that is neither a cancellation record nor already `Cancelled`.
 *
 * Without this the absence is INVISIBLE rather than wrong — `deliveryFulfillmentsOf` would
 * return empty and every per-leg rule below would take its `length === 0` early return, so
 * an order reporting `Order-delivered` with nothing but a `Cancel` fulfillment would pass
 * clean. Ported from the prior art's per-state "Delivery object is mandatory for
 * ON_STATUS_<state>" (e.g. log-validation-utility Status/onStatusDelivered.ts).
 *
 * Holds on 47/47 reference legs: every one carries a `type: Delivery` fulfillment.
 */
export function validateDeliveryFulfillmentPresent(
  order: any,
  actionId: string,
  result: TestResult,
  leg: StatusLeg | null = null
): void {
  if (!Array.isArray(order?.fulfillments)) return; // nothing to judge; L1 requires the array
  if (leg?.fulfillmentType) {
    if (legFulfillmentsOf(order, leg).length > 0) {
      result.passed.push(`on_status (${actionId}): the ${leg.fulfillmentType} fulfillment this status update reports on is present`);
    } else {
      const present = fulfillmentsOf(order)
        .map((f: any) => `${f?.id ?? "?"} (type ${f?.type ?? "?"}, state ${f?.state?.descriptor?.code ?? "?"})`)
        .join("; ");
      result.failed.push(
        `on_status (${actionId}): no fulfillment of type '${leg.fulfillmentType}' — this status update must include it in state '${leg.fulfillmentState}'${present ? ` [found: ${present}]` : ""}`
      );
    }
    return;
  }
  if (deliveryFulfillmentsOf(order).length > 0) {
    result.passed.push(`on_status (${actionId}): a live delivery fulfillment is present`);
    return;
  }
  const codes = fulfillmentsOf(order)
    .map((f: any) => `${f?.id ?? "?"} (type ${f?.type ?? "?"}, state ${f?.state?.descriptor?.code ?? "?"})`)
    .join("; ");
  result.failed.push(
    `on_status (${actionId}): no live delivery fulfillment — every fulfillment is a cancellation record or already Cancelled${codes ? ` [${codes}]` : ""}`
  );
}

/**
 * The `routing` tag, REQUIRED on every live delivery fulfillment — present on 47/47
 * reference legs (every fixture says `P2H2P`). The prior art likewise makes it mandatory
 * ("RoutingTag object is mandatory in Tags of Delivery Object").
 *
 * Note this is NOT a contradiction of the confirm-leg doc, which records the routing tag as
 * a B2C convention with no eB2B equivalent — that is true at `confirm`, where no eB2B
 * payload carries one. It appears from on_status onwards, where the fulfillment is actually
 * being routed.
 */
export function validateFulfillmentRouting(order: any, actionId: string, result: TestResult): void {
  const fulfillments = deliveryFulfillmentsOf(order);
  if (fulfillments.length === 0) return; // reported once by validateDeliveryFulfillmentPresent

  const cleanRun = failureGate(result);
  let checked = 0;

  for (const fulfillment of fulfillments) {
    const group = tagGroupsByCode(fulfillment?.tags, "routing")[0];
    if (!group) {
      result.failed.push(
        `on_status (${actionId}): fulfillment ${fulfillment?.id ?? "?"} is missing the required 'routing' tag group — a shipping fulfillment must declare how it is routed`
      );
      continue;
    }
    checked++;
    const type = tagValue(group.list, "type");
    if (isAbsent(type)) {
      result.failed.push(`on_status (${actionId}): fulfillment ${fulfillment?.id ?? "?"} routing tag is missing 'type'`);
    } else if (!ROUTING_TYPES.includes(String(type))) {
      result.failed.push(
        `on_status (${actionId}): fulfillment ${fulfillment?.id ?? "?"} routing.type '${type}' is not one of ${ROUTING_TYPES.join(", ")}`
      );
    }
  }

  if (checked > 0 && cleanRun()) {
    result.passed.push(`on_status (${actionId}): all ${checked} fulfillment routing tag(s) declare a valid type`);
  }
}

/**
 * Tracking, in both senses:
 *
 *  - `fulfillments[].tracking` must be a real BOOLEAN. L1 requires the field to exist but
 *    not its type, so `"true"` or `"yes"` would slip through — and a buyer app reading it as
 *    truthy would offer tracking that does not work. All 47 reference legs send a boolean.
 *  - the `tracking` TAG is REQUIRED on every live delivery fulfillment (47/47), with
 *    `gps_enabled`/`url_enabled` as yes/no flags; promising a URL means actually sending one.
 *
 * The prior art makes the tag mandatory too ("Tags are mandatory in Delivery Fulfillment")
 * and checks the boolean ("Tracking must be present for fulfillment ID: … in boolean form").
 */
export function validateTrackingTag(order: any, actionId: string, result: TestResult): void {
  const fulfillments = deliveryFulfillmentsOf(order);
  if (fulfillments.length === 0) return; // reported once by validateDeliveryFulfillmentPresent

  const cleanRun = failureGate(result);
  let checked = 0;

  for (const fulfillment of fulfillments) {
    const ref = `fulfillment ${fulfillment?.id ?? "?"}`;

    if (!isAbsent(fulfillment?.tracking) && typeof fulfillment.tracking !== "boolean") {
      result.failed.push(
        `on_status (${actionId}): ${ref} tracking is '${fulfillment.tracking}' (${typeof fulfillment.tracking}) — it must be a boolean, not a string`
      );
    }

    const group = tagGroupsByCode(fulfillment?.tags, "tracking")[0];
    if (!group) {
      result.failed.push(
        `on_status (${actionId}): ${ref} is missing the required 'tracking' tag group`
      );
      continue;
    }
    checked++;

    for (const flag of ["gps_enabled", "url_enabled"]) {
      const value = tagValue(group.list, flag);
      if (isAbsent(value)) continue;
      if (!YES_NO.includes(String(value))) {
        result.failed.push(`on_status (${actionId}): ${ref} tracking.${flag} '${value}' must be 'yes' or 'no'`);
      }
    }

    const url = tagValue(group.list, "url");
    if (String(tagValue(group.list, "url_enabled")) === "yes") {
      if (isAbsent(url) || !String(url).trim()) {
        result.failed.push(`on_status (${actionId}): ${ref} tracking declares url_enabled 'yes' but sends no url`);
      } else if (!/^https?:\/\/[^\s]+$/.test(String(url))) {
        result.failed.push(`on_status (${actionId}): ${ref} tracking.url '${url}' is not a valid http(s) URL`);
      }
    }
  }

  if (checked > 0 && cleanRun()) {
    result.passed.push(`on_status (${actionId}): all ${checked} fulfillment tracking tag(s) are coherent`);
  }
}

/**
 * The retailer the order ships to: `customer` with its `id`, REQUIRED on every live delivery
 * fulfillment. The contract's on_status fulfillment carries it, as do 47/47 reference
 * Delivery legs (all `CUST-2024-0015421`); the rest of the object varies by flow, so only
 * the id is pinned. Neither L0 nor L1 checks it, so a seller dropping `customer` entirely
 * passed every layer (the Vistar tester's V9, docs/RETeB2B-vistar-seller-tester-coverage.md).
 */
export function validateFulfillmentCustomer(order: any, actionId: string, result: TestResult): void {
  const fulfillments = deliveryFulfillmentsOf(order);
  if (fulfillments.length === 0) return; // reported once by validateDeliveryFulfillmentPresent

  const cleanRun = failureGate(result);

  for (const fulfillment of fulfillments) {
    const ref = `fulfillment ${fulfillment?.id ?? "?"}`;
    const customer = fulfillment?.customer;

    if (!customer || typeof customer !== "object") {
      result.failed.push(
        `on_status (${actionId}): ${ref} is missing 'customer' — a delivery fulfillment must identify the retailer it ships to`
      );
    } else if (isAbsent(customer.id) || !String(customer.id).trim()) {
      result.failed.push(`on_status (${actionId}): ${ref} customer.id is required`);
    }
  }

  if (cleanRun()) {
    result.passed.push(
      `on_status (${actionId}): all ${fulfillments.length} delivery fulfillment(s) carry a customer.id`
    );
  }
}

/**
 * SHAPE ONLY — presence is never required, because the fixtures genuinely disagree about
 * which of `time.range` / `time.timestamp` a leg sends (see the module header). What is
 * always true, and worth catching, is that a window does not run backwards and that an
 * event is not stamped in the future relative to the call reporting it.
 *
 * Also range-checks `@ondc/org/TAT` as an ISO-8601 duration, per leg and never echoed.
 *
 * Unlike the other checks here this runs over ALL fulfillments, not just the delivery ones:
 * a time window that runs backwards or an event stamped in the future is wrong on a
 * cancellation record too. The asymmetry is deliberate — `deliveryFulfillmentsOf` exists to
 * stop the per-LEG state/agent rules being applied to a terminal record, not to exempt it
 * from basic coherence.
 */
export function validateFulfillmentTimeWindows(
  order: any,
  context: any,
  actionId: string,
  result: TestResult
): void {
  const fulfillments = fulfillmentsOf(order);
  if (fulfillments.length === 0) return;

  const callMs = toMillis(context?.timestamp);
  const cleanRun = failureGate(result);
  let checked = 0;

  for (const fulfillment of fulfillments) {
    const ref = `fulfillment ${fulfillment?.id ?? "?"}`;

    for (const end of ["start", "end"] as const) {
      const time = fulfillment?.[end]?.time;
      if (!time) continue;

      const range = time.range;
      if (range && !isAbsent(range.start) && !isAbsent(range.end)) {
        checked++;
        const from = toMillis(range.start);
        const to = toMillis(range.end);
        if (from !== null && to !== null && from > to) {
          result.failed.push(
            `on_status (${actionId}): ${ref} ${end}.time.range runs backwards (start '${range.start}' is after end '${range.end}')`
          );
        }
      }

      if (!isAbsent(time.timestamp)) {
        checked++;
        const stamp = toMillis(time.timestamp);
        if (stamp === null) {
          result.failed.push(`on_status (${actionId}): ${ref} ${end}.time.timestamp '${time.timestamp}' is not a valid timestamp`);
        } else if (callMs !== null && stamp > callMs) {
          result.failed.push(
            `on_status (${actionId}): ${ref} ${end}.time.timestamp '${time.timestamp}' is after context.timestamp '${context?.timestamp}' — an event cannot be stamped later than the call reporting it`
          );
        }
      }
    }

    const tat = fulfillment?.["@ondc/org/TAT"];
    if (!isAbsent(tat)) {
      checked++;
      if (!ISO8601_DURATION.test(String(tat))) {
        result.failed.push(`on_status (${actionId}): ${ref} @ondc/org/TAT '${tat}' is not a valid ISO-8601 duration`);
      }
    }

    const gps = fulfillment?.start?.location?.gps;
    if (!isAbsent(gps)) {
      checked++;
      validateGpsFormat(gps, `on_status (${actionId}).${ref}.start.location`, result);
    }
  }

  if (checked > 0 && cleanRun()) {
    result.passed.push(`on_status (${actionId}): all ${checked} fulfillment time/TAT/gps value(s) are coherent`);
  }
}

/**
 * Successive on_status callbacks must move the order forward in time. Every on_status leg
 * writes to the same stored key (`saveFromElement` keys on `context.action`, not
 * `action_id`, and writes overwrite), so the stored value is always the IMMEDIATELY
 * PRECEDING on_status — which is exactly the comparison wanted here.
 *
 * Measured deltas between consecutive legs are 12-23 ms, which is why this goes through the
 * ms-safe `toMillis` rather than `Date.parse(String(x))`: the fixtures' timestamps load as
 * `Date` objects whose `String()` form has no milliseconds, and the naive form would read
 * every one of these as "equal".
 */
export function validateStatusProgression(
  order: any,
  storedUpdatedAt: any,
  actionId: string,
  result: TestResult
): void {
  if (isAbsent(storedUpdatedAt)) return;
  const current = order?.updated_at;
  if (isAbsent(current)) return;

  const before = toMillis(storedUpdatedAt);
  const now = toMillis(current);
  if (before === null || now === null) return;

  if (now <= before) {
    result.failed.push(
      `on_status (${actionId}): order.updated_at '${current}' is not later than the previous on_status ('${storedUpdatedAt}') — each status callback must move the order forward`
    );
    return;
  }

  result.passed.push(`on_status (${actionId}): order.updated_at advanced by ${now - before} ms since the previous on_status`);
}
