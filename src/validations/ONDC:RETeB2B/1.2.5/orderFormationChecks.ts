import { TestResult } from "../../../types/payload";
import { failureGate, tagGroupsByCode, tagValue } from "./onSearchB2BChecks";
import { ISO8601_DURATION, validateGpsFormat, toMillis } from "./commonChecks";

// Business and cross-call checks for the four order-formation actions —
// init / on_init / confirm / on_confirm — of ONDC:RETeB2B 1.2.5.
//
// One module rather than four: these actions share nearly all of their rule
// surface (payments, settlement, terms tags, quote) and most of the interesting
// rules are cross-call *between* them. commonChecks.ts stays reserved for
// genuinely cross-action utilities, as it was when selectChecks.ts was added.
//
// ---------------------------------------------------------------------------
// CALIBRATION — read this before "fixing" any rule back
// ---------------------------------------------------------------------------
// Every rule here was calibrated against the `examples[].payload` sections of
// ALL NINE eB2B order flows in automation-specifications/config/flows/eB2B:
//
//   Order_to_confirm_to_fulfillment_(cod)            Order_to_confirm_to_fulfillment_(Prepaid)
//   Order_to_confirm_to_fulfillment_with_offers(cod) Order_to_confirm_to_fulfillment_with_offers(Prepaid)
//   Order_to_confirm_to_fulfillment_(Prepaid)_with_igm_1.0.0
//   Buyer_Side_Order_Cancellation                    Merchant_Side_RTO_and_Part_Order_Cancellation_Flow
//   Buyer_Initiated_Return_(Full_Order_and_Partial_Order)
//   Out_of_Stock(Error_code)
//
// `examples[].payload` is the ONLY authoritative layer. The per-step *template*
// (between `action_id:` and `saveData:`) is contaminated with Prepaid
// copy-paste in the COD files — e.g. the COD on_init template declares
// ON-ORDER / BPP and a payment `uri` at Order_to_confirm_to_fulfillment__cod_.yaml:735-737,
// while its own adjacent example at :881 sends ON-FULFILLMENT / BPP and no uri.
// Calibrating against templates would both miss real rules and bake in false ones.
//
// Rules the examples forced us to DROP or NARROW (do not re-add):
//
//  - `bap_terms` must not carry `static_terms`  -> FALSE for eB2B. Every reference
//    confirm/on_confirm sends static_terms = https://github.com/ONDC-Official/NP-Static-Terms/...
//  - `bap_terms.tax_number` GSTIN regex        -> FALSE. Its reference value is the literal
//    placeholder `gst_number_of_buyerNP`. Only bpp_terms.tax_number and
//    order.billing.tax_number are real GSTINs, so only those two are regex-checked.
//  - `order.created_at` immutable confirm -> on_confirm -> FALSE. The reference values
//    legitimately differ (COD: ...595Z at confirm vs ...612Z at on_confirm).
//  - bpp_terms deep-equality on_init -> on_confirm -> FALSE. Four flows (Cancellation,
//    RTO, Buyer_Initiated_Return, Out_of_Stock) legitimately ADD `np_type` and
//    `accept_bap_terms` to bpp_terms at on_confirm. The echo is therefore field-scoped
//    to tax_number + provider_tax_number and tolerates added entries.
//  - payment type/collected_by continuity init -> on_init -> IMPOSSIBLE. Every flow's
//    init (Prepaid included) sends the mode-agnostic stub ON-FULFILLMENT / BPP.
//  - `quote.breakup[].item.quantity` must be absent -> FALSE. Every reference breakup
//    item line carries item.quantity.available.count / maximum.count.
//  - a message_id pairing/uniqueness check -> deliberately NOT added. One was removed
//    from shared/flowContinuityValidators.ts:28 at the user's explicit request
//    ("not needed for this domain").
//  - `settlement_counterparty === "buyer-app"` for COD -> B2C retail rule. eB2B uses
//    `seller-app` in all nine flows, for both COD and Prepaid.
//
// This module also deliberately does NOT re-implement what already runs for every
// domain and action via services/checkPayload.ts: contextValidators() (message_id /
// transaction_id / timestamp presence and ISO-8601 format, country/city, bpp_uri) and
// checkFlowContinuity() (timestamp monotonicity, bap/bpp identity stability, and
// quote total == breakup sum).
//
// ---------------------------------------------------------------------------
// Pass reporting and cross-call discipline
// ---------------------------------------------------------------------------
// Every check emits exactly one aggregate `passed` entry on a clean run, via
// `failureGate` — a check never claims a pass for the same thing it just flagged.
//
// Every cross-call check returns immediately when its stored prior state is absent,
// adding NEITHER a pass NOR a failure. Missing Redis state is a normal condition
// (first run, a flow that legitimately skips the prior step, Redis unreachable) and
// must never be reported as a protocol violation.

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

/**
 * eB2B `Payment.type`. Note: no `PRE-ORDER` — the old init.ts allowed it, wrongly.
 *
 * `POST-FULFILLMENT` is also deliberately absent, for L1 parity: the RETeB2B 1.2.5 block of
 * automation-specifications/config/validations/index.yaml declares
 * `PAYMENT_TYPE var_enum: ["ON-ORDER", "ON-FULFILLMENT"]`, and `POST-FULFILLMENT` appears in
 * none of the nine reference flows. Accepting it here would have made this report more
 * permissive than the L1 gate it sits behind.
 */
const PAYMENT_TYPES = ["ON-ORDER", "ON-FULFILLMENT"];
const PAYMENT_STATUSES = ["PAID", "NOT-PAID"];
const COLLECTED_BY = ["BAP", "BPP"];
const TL_METHODS = ["http/get", "http/post", "payto", "upi"];

const SETTLEMENT_COUNTERPARTIES = ["buyer", "buyer-app", "seller-app", "logistics-provider"];
const SETTLEMENT_PHASES = ["sale-amount", "withholding-amount", "refund"];
const SETTLEMENT_TYPES = ["neft", "rtgs", "upi"];
const SETTLEMENT_BASES = ["shipment", "delivery", "return_window_expiry"];

/** Bank-transfer settlement needs full beneficiary details; UPI needs only a VPA. */
const BANK_SETTLEMENT_FIELDS = [
  "bank_name",
  "branch_name",
  "beneficiary_name",
  "settlement_ifsc_code",
  "settlement_bank_account_no",
];

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;

const PRICE_TOLERANCE = 0.01;

export type PaymentMode = "cod" | "prepaid";

// ---------------------------------------------------------------------------
// Local helpers (no new dependencies — AJV and lodash are deliberately absent here)
// ---------------------------------------------------------------------------

/**
 * extractBySpec (src/utils/extract.ts:16) unwraps a JSONPath match of exactly ONE
 * element to a bare object. So a save-spec key written as `payments[*]` arrives as an
 * array when there are two payments and as a bare object when there is one — which is
 * the common case in every reference payload. Every consumer of a `[*]` or
 * filter-expression key must normalize through this, as commonChecks.validateSelectAgainstCatalog
 * and selectChecks.validateMinimumOrderValue already do.
 */
function normalizeSaved(value: any): any[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

/** Structural deep equality. Written locally rather than adding a dependency. */
function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
}

/**
 * Recursive field-by-field diff returning dotted paths, so a mismatch names the field
 * that actually drifted instead of just saying "the objects differ".
 *
 * `skipTopLevel` excludes keys of the ROOT object only — depth is tracked separately from
 * `prefix`, because callers pass a human-readable root label (`"billing"`) as the prefix
 * and the skip list must still apply to that object's own immediate keys.
 */
function diffPaths(
  expected: any,
  actual: any,
  skipTopLevel: string[] = [],
  prefix = "",
  depth = 0
): string[] {
  const diffs: string[] = [];
  const bothObjects =
    expected && actual && typeof expected === "object" && typeof actual === "object" &&
    !Array.isArray(expected) && !Array.isArray(actual);

  if (!bothObjects) {
    if (!deepEqual(expected, actual)) {
      diffs.push(`${prefix || "value"} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    }
    return diffs;
  }

  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const key of keys) {
    if (depth === 0 && skipTopLevel.includes(key)) continue;
    diffs.push(
      ...diffPaths(expected[key], actual[key], skipTopLevel, prefix ? `${prefix}.${key}` : key, depth + 1)
    );
  }
  return diffs;
}

function isAbsent(value: any): boolean {
  return value === undefined || value === null;
}

/** A non-negative decimal amount, given as a string in every eB2B payload. */
function isNonNegativeDecimal(value: any): boolean {
  if (isAbsent(value)) return false;
  const parsed = parseFloat(String(value));
  return !Number.isNaN(parsed) && parsed >= 0;
}

function paymentLabel(index: number): string {
  return `payments[${index}]`;
}

/** Payment entries, tolerating a payload that omits order.payments entirely. */
function paymentsOf(order: any): any[] {
  return Array.isArray(order?.payments) ? order.payments : [];
}

/** Parses an ISO-8601 duration to milliseconds. Returns null when unparseable. */
function durationToMs(duration: any): number | null {
  const text = String(duration ?? "");
  if (!ISO8601_DURATION.test(text)) return null;
  const match = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(text);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match.map((part) => (part === undefined ? 0 : Number(part)));
  // Calendar-month/year approximations are fine here: the value is only ever used as a
  // generous upper bound on a callback latency, never for date arithmetic.
  return (
    y * 365 * 86400000 + mo * 30 * 86400000 + d * 86400000 + h * 3600000 + mi * 60000 + s * 1000
  );
}

// ---------------------------------------------------------------------------
// Payment mode resolution
// ---------------------------------------------------------------------------

/**
 * The flow id carries the payment mode as a suffix marker. Matched EXACT-CASE —
 * `(cod)` is lowercase and `(Prepaid)` has a capital P in every spec flow id — so a
 * case-insensitive match cannot accidentally classify one as the other.
 *
 * Returns null for the four flows that carry no marker
 * (`Buyer_Side_Order_Cancellation`, `Merchant_Side_RTO_and_Part_Order_Cancellation_Flow`,
 * `Buyer_Initiated_Return_(...)`, `Out_of_Stock(Error_code)`). Those flows' own examples
 * are internally INCOHERENT about payment mode — e.g. Buyer_Side_Order_Cancellation sends
 * ON-FULFILLMENT/BPP at init, ON-ORDER/BPP at on_init and ON-FULFILLMENT/BPP at confirm;
 * the RTO flow sends ON-ORDER/BAP at confirm after ON-ORDER/BPP at on_init. They carry the
 * same contamination signature as the COD templates, so no mode-specific rule is enforced
 * for them: only enum validity and internal continuity apply. Verified, not guessed.
 */
export function resolvePaymentMode(flowId: string | undefined): PaymentMode | null {
  const id = String(flowId ?? "");
  if (id.includes("(cod)")) return "cod";
  if (id.includes("(Prepaid)")) return "prepaid";
  return null;
}

/**
 * Which actions each mode's type/collected_by lock may be applied at.
 *
 * `init` is excluded for BOTH modes: every flow's init example — Prepaid included —
 * sends the mode-agnostic stub `type: ON-FULFILLMENT, collected_by: BPP`. The buyer app
 * has not chosen a payment instrument yet at that point, so a COD lock there would be
 * vacuous and a Prepaid lock there would false-fail all three Prepaid flows.
 *
 * `on_init` is excluded for PREPAID only: `Order_to_confirm_to_fulfillment_with_offers(Prepaid)`
 * ships an on_init with the incoherent ON-ORDER + collected_by BPP combination, as do the
 * four mode-less flows. COD's on_init is clean in both `(cod)` flows, so the COD lock does
 * apply from on_init onward.
 *
 * `on_status` added 2026-10-13 for BOTH modes, from the COD flow analysis
 * (docs/RETeB2B-cod-flow-mandatory-validations.md §3.2). Until then the mode was last
 * checked at `on_confirm`, so an order could silently become prepaid for the whole
 * fulfillment lifecycle. Measured over all 47 on_status legs: every `(cod)` leg is
 * ON-FULFILLMENT/BPP (12) and every `(Prepaid)` leg is ON-ORDER/BAP (18), so neither lock
 * false-fails. The remaining 17 legs belong to the four mode-less flows and are skipped.
 */
const MODE_LOCK_ACTIONS: Record<PaymentMode, string[]> = {
  cod: ["on_init", "confirm", "on_confirm", "on_status"],
  prepaid: ["confirm", "on_confirm", "on_status"],
};

/**
 * The action a label refers to. `on_status` labels carry their leg id —
 * `on_status (on_status_packed)` — so an exact match against MODE_LOCK_ACTIONS would never
 * fire for them. Everything before the first space is the action.
 */
function actionOf(label: string): string {
  return String(label).split(" ")[0];
}

const MODE_EXPECTATION: Record<PaymentMode, { type: string; collected_by: string; label: string }> = {
  cod: { type: "ON-FULFILLMENT", collected_by: "BPP", label: "COD" },
  prepaid: { type: "ON-ORDER", collected_by: "BAP", label: "Prepaid" },
};

// ---------------------------------------------------------------------------
// Payments — all four actions
// ---------------------------------------------------------------------------

export function validatePaymentsPresence(order: any, label: string, result: TestResult): void {
  if (!Array.isArray(order?.payments) || order.payments.length === 0) {
    result.failed.push(`${label}: order.payments must be a non-empty array`);
    return;
  }
  result.passed.push(`${label}: order.payments has ${order.payments.length} entry/entries`);
}

/**
 * Enum validity for the payment fields, independent of flow or mode. `type` notably
 * excludes `PRE-ORDER`, which the previous init.ts accepted — it is not in the eB2B
 * OpenAPI `Payment.type` enum. `status`, `collected_by` and `tl_method` are each checked
 * only when present, since init legitimately omits status and no reference payload in any
 * of the nine flows carries a tl_method other than `http/get`.
 */
export function validatePaymentEnums(order: any, label: string, result: TestResult): void {
  const payments = paymentsOf(order);
  if (payments.length === 0) return;

  const cleanRun = failureGate(result);

  payments.forEach((payment: any, index: number) => {
    const ref = paymentLabel(index);

    if (isAbsent(payment?.type)) {
      result.failed.push(`${label}: ${ref}.type is required`);
    } else if (!PAYMENT_TYPES.includes(payment.type)) {
      result.failed.push(
        `${label}: ${ref}.type '${payment.type}' is not one of ${PAYMENT_TYPES.join(", ")}`
      );
    }

    if (!isAbsent(payment?.status) && !PAYMENT_STATUSES.includes(payment.status)) {
      result.failed.push(
        `${label}: ${ref}.status '${payment.status}' is not one of ${PAYMENT_STATUSES.join(", ")}`
      );
    }

    if (isAbsent(payment?.collected_by)) {
      result.failed.push(`${label}: ${ref}.collected_by is required`);
    } else if (!COLLECTED_BY.includes(payment.collected_by)) {
      result.failed.push(
        `${label}: ${ref}.collected_by '${payment.collected_by}' is not one of ${COLLECTED_BY.join(", ")}`
      );
    }

    if (!isAbsent(payment?.tl_method) && !TL_METHODS.includes(payment.tl_method)) {
      result.failed.push(
        `${label}: ${ref}.tl_method '${payment.tl_method}' is not one of ${TL_METHODS.join(", ")}`
      );
    }
  });

  if (cleanRun()) {
    result.passed.push(
      `${label}: all ${payments.length} payment(s) declare a valid type/status/collected_by/tl_method`
    );
  }
}

/**
 * The flow's declared payment mode must match what the payment actually says.
 *
 * Skips silently when the flow carries no mode marker, and when the action is one the
 * mode's lock does not cover — see MODE_LOCK_ACTIONS for the per-mode action list and the
 * payload evidence behind it.
 */
export function validatePaymentModeLock(
  order: any,
  label: string,
  mode: PaymentMode | null,
  flowId: string | undefined,
  result: TestResult
): void {
  if (!mode) return;
  if (!MODE_LOCK_ACTIONS[mode].includes(actionOf(label))) return;

  const payments = paymentsOf(order);
  if (payments.length === 0) return;

  const expected = MODE_EXPECTATION[mode];
  const cleanRun = failureGate(result);

  payments.forEach((payment: any, index: number) => {
    if (payment?.type !== expected.type || payment?.collected_by !== expected.collected_by) {
      result.failed.push(
        `${label}: ${paymentLabel(index)} declares type '${payment?.type}'/collected_by '${payment?.collected_by}', ` +
          `but flow '${flowId}' is ${expected.label} (expected ${expected.type}/${expected.collected_by})`
      );
    }
  });

  if (cleanRun()) {
    result.passed.push(
      `${label}: all ${payments.length} payment(s) match the ${expected.label} mode of flow '${flowId}' (${expected.type}/${expected.collected_by})`
    );
  }
}

/**
 * COD-only constraints. Cash is collected by the seller at fulfillment, so there is no
 * payment gateway in the loop: no `uri` to redirect the buyer to, no `tl_method` to
 * reconcile with, no gateway `params.transaction_id`, and the order cannot already be PAID
 * while it is still being formed.
 *
 * Scoped to COD on purpose. "Forbid uri/tl_method when collected_by is BPP" is NOT a valid
 * general rule — Prepaid-with-BPP-collect legitimately carries a payment uri, and six of the
 * nine reference flows send one at confirm.
 *
 * Each violation gets its own message so two simultaneous ones are both reported.
 */
export function validateCodPaymentConstraints(
  order: any,
  label: string,
  mode: PaymentMode | null,
  result: TestResult
): void {
  if (mode !== "cod") return;

  const payments = paymentsOf(order);
  if (payments.length === 0) return;

  const cleanRun = failureGate(result);

  payments.forEach((payment: any, index: number) => {
    const ref = paymentLabel(index);

    if (payment?.status === "PAID") {
      result.failed.push(
        `${label}: ${ref}.status must not be PAID for a COD flow — payment is collected on fulfillment`
      );
    }
    if (!isAbsent(payment?.uri)) {
      result.failed.push(
        `${label}: ${ref}.uri must not be sent for a COD flow (payment is collected on fulfillment), got '${payment.uri}'`
      );
    }
    if (!isAbsent(payment?.tl_method)) {
      result.failed.push(
        `${label}: ${ref}.tl_method must not be sent for a COD flow, got '${payment.tl_method}'`
      );
    }
    if (!isAbsent(payment?.params?.transaction_id)) {
      result.failed.push(
        `${label}: ${ref}.params.transaction_id must not be sent for a COD flow (there is no payment-gateway transaction), got '${payment.params.transaction_id}'`
      );
    }
  });

  if (cleanRun()) {
    result.passed.push(
      `${label}: all ${payments.length} payment(s) honour the COD constraints (not PAID; no uri/tl_method/params.transaction_id)`
    );
  }
}

/**
 * A payment that claims to be settled must say which gateway transaction settled it.
 * Mode-independent: it fires wherever a PAID status appears, which in the reference
 * payloads is confirm/on_confirm of the Prepaid and RTO flows (each with a
 * params.transaction_id). Prepaid on_init is NOT-PAID in all nine flows — PAID first
 * appears at confirm.
 */
export function validatePaidTransactionId(order: any, label: string, result: TestResult): void {
  const payments = paymentsOf(order);
  const paid = payments.filter((payment: any) => payment?.status === "PAID");
  if (paid.length === 0) return;

  const cleanRun = failureGate(result);

  payments.forEach((payment: any, index: number) => {
    if (payment?.status !== "PAID") return;
    const transactionId = payment?.params?.transaction_id;
    if (isAbsent(transactionId) || !String(transactionId).trim()) {
      result.failed.push(
        `${label}: ${paymentLabel(index)}.status is PAID but params.transaction_id is missing`
      );
    }
  });

  if (cleanRun()) {
    result.passed.push(`${label}: all ${paid.length} PAID payment(s) carry a params.transaction_id`);
  }
}

// ---------------------------------------------------------------------------
// Settlement — on_init, confirm, on_confirm
// ---------------------------------------------------------------------------

/**
 * `@ondc/org/settlement_details` — who gets paid, at which phase, by which instrument.
 *
 * Skips entirely when no payment declares settlement_details, which is correct for `init`:
 * the buyer app has nothing to say about seller settlement, and no reference init carries it.
 *
 * `settlement_counterparty` accepts `seller-app`, which is what eB2B uses for BOTH COD and
 * Prepaid in all nine flows. The B2C retail rule pinning COD to `buyer-app` is not ported.
 */
export function validateSettlementDetails(order: any, label: string, result: TestResult): void {
  const payments = paymentsOf(order);
  const entries: { ref: string; detail: any }[] = [];
  payments.forEach((payment: any, index: number) => {
    normalizeSaved(payment?.["@ondc/org/settlement_details"]).forEach((detail: any, detailIndex: number) => {
      entries.push({ ref: `${paymentLabel(index)}.@ondc/org/settlement_details[${detailIndex}]`, detail });
    });
  });
  if (entries.length === 0) return;

  const cleanRun = failureGate(result);

  for (const { ref, detail } of entries) {
    const counterparty = detail?.settlement_counterparty;
    if (isAbsent(counterparty)) {
      result.failed.push(`${label}: ${ref}.settlement_counterparty is required`);
    } else if (!SETTLEMENT_COUNTERPARTIES.includes(counterparty)) {
      result.failed.push(
        `${label}: ${ref} has settlement_counterparty '${counterparty}', not one of ${SETTLEMENT_COUNTERPARTIES.join(", ")}`
      );
    }

    const phase = detail?.settlement_phase;
    if (isAbsent(phase)) {
      result.failed.push(`${label}: ${ref}.settlement_phase is required`);
    } else if (!SETTLEMENT_PHASES.includes(phase)) {
      result.failed.push(
        `${label}: ${ref} has settlement_phase '${phase}', not one of ${SETTLEMENT_PHASES.join(", ")}`
      );
    }

    const type = detail?.settlement_type;
    if (isAbsent(type)) {
      result.failed.push(`${label}: ${ref}.settlement_type is required`);
      continue;
    }
    if (!SETTLEMENT_TYPES.includes(type)) {
      result.failed.push(
        `${label}: ${ref} has settlement_type '${type}', not one of ${SETTLEMENT_TYPES.join(", ")}`
      );
      continue;
    }

    if (type === "upi") {
      if (isAbsent(detail?.upi_address) || !String(detail.upi_address).trim()) {
        result.failed.push(`${label}: ${ref} has settlement_type 'upi' but no upi_address`);
      }
    } else {
      // neft / rtgs — a bank transfer needs the full beneficiary record.
      for (const field of BANK_SETTLEMENT_FIELDS) {
        if (isAbsent(detail?.[field]) || !String(detail[field]).trim()) {
          result.failed.push(`${label}: ${ref} has settlement_type '${type}' but no ${field}`);
        }
      }
    }
  }

  if (cleanRun()) {
    result.passed.push(`${label}: all ${entries.length} settlement_details entry/entries are complete and valid`);
  }
}

/** Counterparties that represent the SELLER side of a sale. */
const SELLER_SIDE_COUNTERPARTIES = ["seller-app", "logistics-provider"];

/**
 * Who gets paid for the sale must match who collected the money.
 *
 * Added 2026-10-13 from the COD flow analysis
 * (docs/RETeB2B-cod-flow-mandatory-validations.md §3.4). `validateSettlementDetails` checks
 * the counterparty against its enum and `validateSettlementDetailsEcho` freezes the block
 * after `on_init`, but nothing tied the counterparty to the payment mode — so a COD order
 * declaring `settlement_counterparty: buyer-app` on its sale-amount entry passed, which
 * would have the buyer app settled for cash the seller collected at the door.
 *
 * Scoped to `settlement_phase: sale-amount` on purpose. A `refund` phase legitimately names
 * the buyer: measured across every order leg in all nine flows, all 51 `sale-amount` entries
 * name `seller-app` and the only `buyer` entries are the 2 `refund` entries at `update`.
 *
 * COD-only, by the same either-signal rule used at on_status: a flow whose name says cod, or
 * a payment typed ON-FULFILLMENT. Prepaid is deliberately untouched — the money moves through
 * the buyer app there and the correct counterparty is a settlement-policy question this
 * project has no ground truth for.
 */
export function validateCodSettlementCounterparty(
  order: any,
  label: string,
  mode: PaymentMode | null,
  result: TestResult
): void {
  const payments = paymentsOf(order);
  if (payments.length === 0) return;

  const cleanRun = failureGate(result);
  let checked = 0;

  payments.forEach((payment: any, index: number) => {
    const isCod = mode === "cod" || String(payment?.type) === "ON-FULFILLMENT";
    if (!isCod) return;

    const entries = normalizeSaved(payment?.["@ondc/org/settlement_details"]);
    for (const [entryIndex, detail] of entries.entries()) {
      if (String(detail?.settlement_phase) !== "sale-amount") continue;
      const counterparty = detail?.settlement_counterparty;
      if (isAbsent(counterparty)) continue;
      checked++;
      if (!SELLER_SIDE_COUNTERPARTIES.includes(String(counterparty))) {
        result.failed.push(
          `${label}: ${paymentLabel(index)}.@ondc/org/settlement_details[${entryIndex}] settles the sale-amount to '${counterparty}', ` +
            `but this is a COD payment — the seller collected the cash, so it must be settled to one of ${SELLER_SIDE_COUNTERPARTIES.join(", ")}`
        );
      }
    }
  });

  if (checked > 0 && cleanRun()) {
    result.passed.push(
      `${label}: all ${checked} COD sale-amount settlement entry/entries are settled to the seller side`
    );
  }
}

/**
 * `@ondc/org/settlement_basis` / `_window` / `_withholding_amount` — the settlement terms
 * the two apps agree on when the order is placed.
 *
 * Caller gates this to confirm/on_confirm. Verified ABSENT from on_init in all nine flows,
 * so requiring it there would false-fail every one of them; the terms are fixed by confirm,
 * where all nine send `delivery` / `P1D` / `0.00`.
 *
 * The window is matched against commonChecks.ISO8601_DURATION, which accepts `P1D`. The
 * B2C prior art's `^PT\d+[MH]$` would reject it — do not port that pattern.
 */
export function validateSettlementBasisWindow(order: any, label: string, result: TestResult): void {
  const payments = paymentsOf(order);
  const relevant = payments.filter(
    (payment: any) =>
      !isAbsent(payment?.["@ondc/org/settlement_basis"]) ||
      !isAbsent(payment?.["@ondc/org/settlement_window"]) ||
      !isAbsent(payment?.["@ondc/org/withholding_amount"])
  );
  if (relevant.length === 0) return;

  const cleanRun = failureGate(result);

  payments.forEach((payment: any, index: number) => {
    const ref = paymentLabel(index);
    const basis = payment?.["@ondc/org/settlement_basis"];
    const window = payment?.["@ondc/org/settlement_window"];
    const withholding = payment?.["@ondc/org/withholding_amount"];
    if (isAbsent(basis) && isAbsent(window) && isAbsent(withholding)) return;

    if (isAbsent(basis)) {
      result.failed.push(`${label}: ${ref}.@ondc/org/settlement_basis is required once settlement terms are declared`);
    } else if (!SETTLEMENT_BASES.includes(basis)) {
      result.failed.push(
        `${label}: ${ref}.@ondc/org/settlement_basis '${basis}' is not one of ${SETTLEMENT_BASES.join(", ")}`
      );
    }

    if (isAbsent(window)) {
      result.failed.push(`${label}: ${ref}.@ondc/org/settlement_window is required once settlement terms are declared`);
    } else if (!ISO8601_DURATION.test(String(window))) {
      result.failed.push(
        `${label}: ${ref}.@ondc/org/settlement_window '${window}' is not a valid ISO-8601 duration`
      );
    }

    if (isAbsent(withholding)) {
      result.failed.push(`${label}: ${ref}.@ondc/org/withholding_amount is required once settlement terms are declared`);
    } else if (!isNonNegativeDecimal(withholding)) {
      result.failed.push(
        `${label}: ${ref}.@ondc/org/withholding_amount '${withholding}' is not a valid non-negative decimal`
      );
    }
  });

  if (cleanRun()) {
    result.passed.push(
      `${label}: settlement basis/window/withholding_amount valid across ${relevant.length} payment(s)`
    );
  }
}

/**
 * The amount the buyer is asked to pay must be the amount the order was quoted at.
 *
 * Caller gates this to confirm/on_confirm — `params` is absent at init and on_init in all
 * nine flows. Skips silently for a payment with no params.amount.
 *
 * Compared with the repo's existing 0.01 tolerance; the B2C prior art's Math.round()
 * +/- Rs.1 tolerance is far too coarse to catch a real pricing defect.
 */
export function validatePaymentAmountMatchesQuote(order: any, label: string, result: TestResult): void {
  const quotePrice = order?.quote?.price;
  const payments = paymentsOf(order);
  const withParams = payments.filter((payment: any) => !isAbsent(payment?.params?.amount));
  if (!quotePrice || withParams.length === 0) return;

  const quoteValue = parseFloat(String(quotePrice.value ?? ""));
  if (Number.isNaN(quoteValue)) return;

  const cleanRun = failureGate(result);

  payments.forEach((payment: any, index: number) => {
    const amount = payment?.params?.amount;
    if (isAbsent(amount)) return;
    const ref = paymentLabel(index);

    const parsed = parseFloat(String(amount));
    if (Number.isNaN(parsed)) {
      result.failed.push(`${label}: ${ref}.params.amount '${amount}' is not a valid decimal`);
    } else if (Math.abs(parsed - quoteValue) > PRICE_TOLERANCE) {
      result.failed.push(
        `${label}: ${ref}.params.amount (${amount}) does not match quote.price.value (${quotePrice.value})`
      );
    }

    const currency = payment?.params?.currency;
    if (!isAbsent(currency) && !isAbsent(quotePrice.currency) && currency !== quotePrice.currency) {
      result.failed.push(
        `${label}: ${ref}.params.currency '${currency}' does not match quote.price.currency '${quotePrice.currency}'`
      );
    }
  });

  if (cleanRun()) {
    result.passed.push(
      `${label}: all ${withParams.length} payment params amount/currency match quote.price (${quotePrice.value} ${quotePrice.currency})`
    );
  }
}

// ---------------------------------------------------------------------------
// Terms tags
// ---------------------------------------------------------------------------

/**
 * `bpp_terms` — the seller's tax identity, which the buyer app needs in order to accept
 * the seller's terms at confirm.
 *
 * Caller gates this to on_init/confirm/on_confirm: `order.tags` is an empty array at init
 * in all nine flows, so requiring it there would false-fail every one.
 *
 * Only `bpp_terms.tax_number` is regex-checked as a GSTIN here. `bap_terms.tax_number` is
 * the literal placeholder `gst_number_of_buyerNP` in every reference payload and must never
 * be regex-checked (see the module header).
 */
export function validateBppTerms(order: any, label: string, result: TestResult): void {
  const group = tagGroupsByCode(order?.tags, "bpp_terms")[0];
  if (!group) {
    result.failed.push(`${label}: order.tags is missing the required 'bpp_terms' tag group`);
    return;
  }

  const cleanRun = failureGate(result);

  const taxNumber = tagValue(group.list, "tax_number");
  if (isAbsent(taxNumber)) {
    result.failed.push(`${label}: bpp_terms is missing tax_number`);
  } else if (!GSTIN.test(String(taxNumber))) {
    result.failed.push(`${label}: bpp_terms.tax_number '${taxNumber}' is not a valid GSTIN`);
  }

  const providerTaxNumber = tagValue(group.list, "provider_tax_number");
  if (isAbsent(providerTaxNumber)) {
    result.failed.push(`${label}: bpp_terms is missing provider_tax_number`);
  } else if (!PAN.test(String(providerTaxNumber))) {
    result.failed.push(
      `${label}: bpp_terms.provider_tax_number '${providerTaxNumber}' is not a valid PAN`
    );
  }

  if (cleanRun()) {
    result.passed.push(
      `${label}: bpp_terms declares a valid GSTIN tax_number ('${taxNumber}') and PAN provider_tax_number ('${providerTaxNumber}')`
    );
  }
}

/**
 * `credit` — the credit line the seller extends to this business buyer. This is the one
 * genuinely B2B term in the leg, and it is REQUIRED at on_init: all nine flows declare it
 * there (credit_limit 25000.00 plus an RFC3339 valid_till) and none of them repeat it at
 * confirm/on_confirm, so elsewhere it is validated only if present.
 */
export function validateCreditTerms(
  order: any,
  label: string,
  result: TestResult,
  opts: { required?: boolean } = {}
): void {
  const group = tagGroupsByCode(order?.tags, "credit")[0];
  if (!group) {
    if (opts.required) {
      result.failed.push(
        `${label}: order.tags is missing the required 'credit' tag group (the business buyer's credit terms)`
      );
    }
    return;
  }

  const cleanRun = failureGate(result);

  const creditLimit = tagValue(group.list, "credit_limit");
  if (isAbsent(creditLimit)) {
    result.failed.push(`${label}: credit tag is missing credit_limit`);
  } else if (!isNonNegativeDecimal(creditLimit)) {
    result.failed.push(
      `${label}: credit.credit_limit '${creditLimit}' is not a valid non-negative decimal`
    );
  }

  const validTill = tagValue(group.list, "valid_till");
  if (isAbsent(validTill)) {
    result.failed.push(`${label}: credit tag is missing valid_till`);
  } else if (Number.isNaN(Date.parse(String(validTill)))) {
    result.failed.push(`${label}: credit.valid_till '${validTill}' is not a valid RFC3339 timestamp`);
  }

  if (cleanRun()) {
    result.passed.push(
      `${label}: credit terms declared (credit_limit '${creditLimit}', valid_till '${validTill}')`
    );
  }
}

/**
 * `bap_terms` — the buyer app's own terms, including its explicit acceptance of the seller
 * terms it was shown at on_init. Caller gates this to confirm/on_confirm, where all nine
 * flows declare the group.
 *
 * `accept_bpp_terms` is REQUIRED only on the buyer's own request (`confirm`, where all nine
 * flows send 'Y'), and merely validated-if-present on the seller's echo. Four of the nine
 * flows (Buyer_Initiated_Return, Buyer_Side_Order_Cancellation, Merchant_Side_RTO,
 * Out_of_Stock) legitimately echo a TRIMMED bap_terms at on_confirm with no
 * accept_bpp_terms — those same four instead add `accept_bap_terms: Y` to `bpp_terms`
 * there, i.e. the acceptance being expressed at on_confirm is the seller's, not a repeat
 * of the buyer's. Requiring it at on_confirm would false-fail all four.
 *
 * NOT checked, deliberately: the presence of `static_terms` (every reference confirm sends
 * a static-terms URL, so the B2C "must not contain static_terms" rule is simply false for
 * eB2B) and `bap_terms.tax_number` (the literal placeholder `gst_number_of_buyerNP` in
 * every reference payload, so never regex-checked as a GSTIN).
 */
export function validateBapTerms(
  order: any,
  label: string,
  result: TestResult,
  opts: { requireAcceptance?: boolean } = {}
): void {
  const group = tagGroupsByCode(order?.tags, "bap_terms")[0];
  if (!group) {
    result.failed.push(`${label}: order.tags is missing the required 'bap_terms' tag group`);
    return;
  }

  const cleanRun = failureGate(result);

  const accept = tagValue(group.list, "accept_bpp_terms");
  if (isAbsent(accept)) {
    if (opts.requireAcceptance) {
      result.failed.push(`${label}: bap_terms is missing accept_bpp_terms`);
    }
  } else if (accept !== "Y") {
    result.failed.push(
      `${label}: bap_terms.accept_bpp_terms is '${accept}' — the buyer app must accept the seller's terms ('Y') to place the order`
    );
  }

  if (cleanRun()) {
    result.passed.push(
      isAbsent(accept)
        ? `${label}: bap_terms declared (no accept_bpp_terms on this leg — the buyer's acceptance is given at confirm)`
        : `${label}: bap_terms accepts the seller's terms (accept_bpp_terms 'Y')`
    );
  }
}

// ---------------------------------------------------------------------------
// Order lifecycle
// ---------------------------------------------------------------------------

/**
 * `order.billing` — required at init, where the buyer first declares who is being invoiced.
 * `billing.tax_number`, when present, is a real GSTIN (29AABCU9603R1ZM in all nine flows),
 * so it is regex-checked; unlike bap_terms.tax_number, which is a placeholder.
 */
export function validateBillingDetails(order: any, label: string, result: TestResult): void {
  const billing = order?.billing;
  if (!billing || typeof billing !== "object") {
    result.failed.push(`${label}: order.billing is required`);
    return;
  }

  const cleanRun = failureGate(result);

  if (isAbsent(billing.name) || !String(billing.name).trim()) {
    result.failed.push(`${label}: order.billing.name is required`);
  }
  if (!isAbsent(billing.tax_number) && !GSTIN.test(String(billing.tax_number))) {
    result.failed.push(`${label}: order.billing.tax_number '${billing.tax_number}' is not a valid GSTIN`);
  }

  if (cleanRun()) {
    const gstinNote = isAbsent(billing.tax_number) ? "no tax_number declared" : `GSTIN '${billing.tax_number}'`;
    result.passed.push(`${label}: order.billing is present (name '${billing.name}', ${gstinNote})`);
  }
}

/**
 * `order.created_at` / `order.updated_at`.
 *
 * Deliberately NOT exact equality against context.timestamp. Exact equality does hold in
 * all nine reference payloads, but it is needlessly brittle for a live NP that stamps the
 * order a few milliseconds before serialising the context. The rules kept here are the ones
 * that catch a real defect: an order dated into the future relative to the call that carries
 * it, or an updated_at that precedes its own created_at.
 *
 * `created_at` is required at confirm (the BAP creates the order) and optional at
 * on_confirm. It is explicitly NOT compared across confirm -> on_confirm: the reference
 * values legitimately differ (COD ...595Z vs ...612Z).
 */
export function validateOrderTimestamps(
  order: any,
  context: any,
  label: string,
  result: TestResult,
  opts: { requireCreatedAt?: boolean } = {}
): void {
  // toMillis, not Date.parse(String(x)): these run against fixture payloads where js-yaml
  // has turned the timestamps into Date objects whose String() form drops milliseconds. The
  // comparisons here are intra-payload so both sides truncate alike and the naive form
  // happens to work, but a sub-second violation would be invisible under test.
  const contextTs = toMillis(context?.timestamp) ?? NaN;
  const createdAtRaw = order?.created_at;
  const updatedAtRaw = order?.updated_at;

  const cleanRun = failureGate(result);

  if (opts.requireCreatedAt && isAbsent(createdAtRaw)) {
    result.failed.push(`${label}: order.created_at is required`);
  }
  if (isAbsent(updatedAtRaw)) {
    result.failed.push(`${label}: order.updated_at is required`);
  }
  if (isAbsent(createdAtRaw) && isAbsent(updatedAtRaw)) {
    return;
  }

  const createdAt = isAbsent(createdAtRaw) ? NaN : (toMillis(createdAtRaw) ?? NaN);
  const updatedAt = isAbsent(updatedAtRaw) ? NaN : (toMillis(updatedAtRaw) ?? NaN);

  if (!isAbsent(createdAtRaw) && Number.isNaN(createdAt)) {
    result.failed.push(`${label}: order.created_at '${createdAtRaw}' is not a valid RFC3339 timestamp`);
  }
  if (!isAbsent(updatedAtRaw) && Number.isNaN(updatedAt)) {
    result.failed.push(`${label}: order.updated_at '${updatedAtRaw}' is not a valid RFC3339 timestamp`);
  }

  if (!Number.isNaN(contextTs)) {
    if (!Number.isNaN(createdAt) && createdAt > contextTs) {
      result.failed.push(
        `${label}: order.created_at '${createdAtRaw}' is after context.timestamp '${context.timestamp}' — the order cannot be created after the call that carries it`
      );
    }
    if (!Number.isNaN(updatedAt) && updatedAt > contextTs) {
      result.failed.push(
        `${label}: order.updated_at '${updatedAtRaw}' is after context.timestamp '${context.timestamp}' — the order cannot be updated after the call that carries it`
      );
    }
  }

  if (!Number.isNaN(createdAt) && !Number.isNaN(updatedAt) && updatedAt < createdAt) {
    result.failed.push(
      `${label}: order.updated_at '${updatedAtRaw}' precedes order.created_at '${createdAtRaw}'`
    );
  }

  if (cleanRun()) {
    result.passed.push(
      `${label}: order timestamps are coherent (created_at '${createdAtRaw}', updated_at '${updatedAtRaw}', context.timestamp '${context?.timestamp}')`
    );
  }
}

// ---------------------------------------------------------------------------
// Cross-call — the echoes COD's generated scripts are missing
// ---------------------------------------------------------------------------
// Every function below returns immediately when its stored prior state is absent,
// adding NEITHER a pass NOR a failure.

/**
 * `bpp_terms` echo on_init -> confirm/on_confirm.
 *
 * FIELD-SCOPED to tax_number and provider_tax_number, and tolerant of added entries.
 * A whole-group deep-equal would false-fail four of the nine flows (Cancellation, RTO,
 * Buyer_Initiated_Return, Out_of_Stock), whose on_confirm legitimately ADDS `np_type: MSN`
 * and `accept_bap_terms: Y` to the group. The seller's tax identity, however, must not
 * change between quoting the terms and the order being placed against them.
 */
export function validateBppTermsEcho(
  order: any,
  storedBppTerms: any,
  label: string,
  result: TestResult
): void {
  const stored = normalizeSaved(storedBppTerms)[0];
  if (!stored?.list) return;

  const current = tagGroupsByCode(order?.tags, "bpp_terms")[0];
  if (!current) return; // absence is validateBppTerms' job, not the echo's

  const cleanRun = failureGate(result);

  for (const field of ["tax_number", "provider_tax_number"]) {
    const expected = tagValue(stored.list, field);
    if (isAbsent(expected)) continue;
    const actual = tagValue(current.list, field);
    if (String(actual) !== String(expected)) {
      result.failed.push(
        `${label}: bpp_terms.${field} '${actual}' does not echo the value declared in on_init ('${expected}')`
      );
    }
  }

  if (cleanRun()) {
    result.passed.push(`${label}: bpp_terms tax_number/provider_tax_number echo on_init unchanged`);
  }
}

/**
 * `@ondc/org/settlement_details` echo on_init -> confirm/on_confirm. The bank account the
 * seller will be paid into is agreed at on_init and must not change once the buyer has
 * committed — this is the specific gap the generated COD scripts omit at BOTH confirm and
 * on_confirm, so it is applied at both here.
 *
 * Full deep equality is safe: verified byte-identical across on_init/confirm/on_confirm in
 * all nine flows.
 */
export function validateSettlementDetailsEcho(
  order: any,
  storedSettlementDetails: any,
  label: string,
  result: TestResult
): void {
  const stored = normalizeSaved(storedSettlementDetails);
  if (stored.length === 0) return;

  const current: any[] = [];
  for (const payment of paymentsOf(order)) {
    current.push(...normalizeSaved(payment?.["@ondc/org/settlement_details"]));
  }
  if (current.length === 0) return; // absence is validateSettlementDetails' job

  const cleanRun = failureGate(result);
  const expected = stored[0];
  const actual = current[0];

  const diffs = diffPaths(expected, actual, [], "settlement_details[0]");
  for (const diff of diffs) {
    result.failed.push(`${label}: ${diff} does not echo on_init`);
  }

  if (cleanRun()) {
    result.passed.push(
      `${label}: settlement_details[0] echoes on_init unchanged (${expected?.settlement_type} to ${expected?.settlement_counterparty})`
    );
  }
}

/**
 * `quote.price.value` must not drift once quoted. Chained on_select -> on_init ->
 * confirm -> on_confirm by calling this with each available prior step's stored value;
 * verified drift-free across the whole chain in all nine flows.
 *
 * Uses the repo's 0.01 tolerance, not the prior art's +/- Rs.1.
 */
export function validateQuotePriceNoDrift(
  order: any,
  storedQuotePrice: any,
  priorLabel: string,
  label: string,
  result: TestResult
): void {
  if (isAbsent(storedQuotePrice)) return;
  const expected = parseFloat(String(storedQuotePrice));
  const currentRaw = order?.quote?.price?.value;
  if (Number.isNaN(expected) || isAbsent(currentRaw)) return;

  const current = parseFloat(String(currentRaw));
  if (Number.isNaN(current)) return; // malformed value is validateQuoteBreakup's job

  if (Math.abs(current - expected) > PRICE_TOLERANCE) {
    result.failed.push(
      `${label}: quote.price.value (${currentRaw}) has drifted from the value quoted in ${priorLabel} (${storedQuotePrice})`
    );
    return;
  }
  result.passed.push(`${label}: quote.price.value (${currentRaw}) is unchanged from ${priorLabel}`);
}

/**
 * `order.billing` echo init -> on_init/confirm/on_confirm.
 *
 * EXCLUDES the top-level `created_at`/`updated_at`, which legitimately change at every
 * step in every reference payload (they are the billing record's own audit stamps, not
 * part of the invoicing identity). Every other field is compared recursively and reported
 * by dotted path, so a mismatch names the field that drifted. Verified: with those two
 * excluded, billing is identical across all four actions in all nine flows.
 */
export function validateBillingEcho(
  order: any,
  storedBilling: any,
  label: string,
  result: TestResult
): void {
  if (!storedBilling || typeof storedBilling !== "object") return;
  const current = order?.billing;
  if (!current || typeof current !== "object") return; // absence is validateBillingDetails' job

  const cleanRun = failureGate(result);

  const diffs = diffPaths(storedBilling, current, ["created_at", "updated_at"], "billing");
  for (const diff of diffs) {
    result.failed.push(`${label}: ${diff} does not echo the billing declared in init`);
  }

  if (cleanRun()) {
    result.passed.push(`${label}: order.billing echoes init unchanged (ignoring its own created_at/updated_at stamps)`);
  }
}

/**
 * `order.provider` continuity — the provider id and the set of provider location ids the
 * order is placed against must not change once init has named them. Compares against the
 * stored prior step rather than re-deriving from the catalog.
 */
export function validateProviderContinuity(
  order: any,
  storedProvider: any,
  priorLabel: string,
  label: string,
  result: TestResult
): void {
  const expectedId = storedProvider?.id;
  if (isAbsent(expectedId)) return;
  const currentId = order?.provider?.id;
  if (isAbsent(currentId)) return;

  const cleanRun = failureGate(result);

  if (String(currentId) !== String(expectedId)) {
    result.failed.push(
      `${label}: provider.id '${currentId}' does not match the provider '${expectedId}' the order was placed with in ${priorLabel}`
    );
  }

  const expectedLocations = new Set(
    (storedProvider?.locations || []).map((location: any) => location?.id).filter(Boolean)
  );
  if (expectedLocations.size > 0) {
    for (const location of order?.provider?.locations || []) {
      if (location?.id && !expectedLocations.has(location.id)) {
        result.failed.push(
          `${label}: provider.locations declares location '${location.id}', which was not among the locations declared in ${priorLabel} (${[...expectedLocations].join(", ")})`
        );
      }
    }
  }

  if (cleanRun()) {
    result.passed.push(`${label}: provider.id '${currentId}' and its location ids are unchanged from ${priorLabel}`);
  }
}

/**
 * A callback must arrive after its request and inside the window the request itself
 * declared — `context.ttl`, not an invented constant. The reference payloads declare
 * `PT30S` and the real gap is ~17 ms.
 *
 * Skips silently when the stored request timestamp or ttl is missing or unparseable;
 * monotonicity across consecutive calls is already checked universally by
 * shared/flowContinuityValidators, so this adds only the request/callback pairing.
 */
export function validateCallbackTtlWindow(
  context: any,
  storedTimestamp: any,
  storedTtl: any,
  priorLabel: string,
  label: string,
  result: TestResult
): void {
  if (isAbsent(storedTimestamp) || isAbsent(storedTtl)) return;

  const requestMs = Date.parse(String(storedTimestamp));
  const callbackMs = Date.parse(String(context?.timestamp ?? ""));
  const ttlMs = durationToMs(storedTtl);
  if (Number.isNaN(requestMs) || Number.isNaN(callbackMs) || ttlMs === null) return;

  const cleanRun = failureGate(result);

  if (callbackMs < requestMs) {
    result.failed.push(
      `${label}: context.timestamp '${context.timestamp}' precedes the ${priorLabel} it answers ('${storedTimestamp}')`
    );
  } else if (callbackMs - requestMs > ttlMs) {
    result.failed.push(
      `${label}: responded ${callbackMs - requestMs}ms after ${priorLabel}, past the ttl '${storedTtl}' (${ttlMs}ms) that ${priorLabel} declared`
    );
  }

  if (cleanRun()) {
    result.passed.push(
      `${label}: responded ${callbackMs - requestMs}ms after ${priorLabel}, within its declared ttl '${storedTtl}'`
    );
  }
}

/**
 * Every id the order is formed around must trace back to what the seller actually offered
 * in on_select: the provider, the item ids, and the fulfillment ids.
 *
 * `fulfillments[].start.location.id` is checked only when on_select declared at least one
 * start location. In practice on_select declares none in all nine flows while on_confirm
 * introduces `L1`, so that branch is a silent no-op today — but it is written so that a
 * seller who does declare start locations is held to them.
 *
 * Skips each dimension independently when on_select stored nothing for it, so an
 * out-of-stock on_select with no `order` at all is a complete no-op.
 */
export function validateIdsAgainstOnSelect(
  order: any,
  onSelectData: Record<string, any> | null,
  label: string,
  result: TestResult
): void {
  if (!onSelectData) return;

  const storedProvider = onSelectData.provider;
  const storedItems = normalizeSaved(onSelectData.items);
  const storedFulfillments = normalizeSaved(onSelectData.fulfillments);

  const cleanRun = failureGate(result);
  const checked: string[] = [];

  const expectedProviderId = storedProvider?.id;
  const currentProviderId = order?.provider?.id;
  if (!isAbsent(expectedProviderId) && !isAbsent(currentProviderId)) {
    checked.push("provider.id");
    if (String(currentProviderId) !== String(expectedProviderId)) {
      result.failed.push(
        `${label}: provider.id '${currentProviderId}' was not the provider quoted in on_select ('${expectedProviderId}')`
      );
    }
  }

  const expectedItemIds = new Set(storedItems.map((item: any) => item?.id).filter(Boolean));
  if (expectedItemIds.size > 0) {
    checked.push("items[].id");
    for (const item of order?.items || []) {
      if (item?.id && !expectedItemIds.has(item.id)) {
        result.failed.push(`${label}: item '${item.id}' was not quoted in on_select`);
      }
    }
  }

  const expectedFulfillmentIds = new Set(storedFulfillments.map((f: any) => f?.id).filter(Boolean));
  if (expectedFulfillmentIds.size > 0) {
    checked.push("fulfillments[].id");
    for (const fulfillment of order?.fulfillments || []) {
      if (fulfillment?.id && !expectedFulfillmentIds.has(fulfillment.id)) {
        result.failed.push(`${label}: fulfillment '${fulfillment.id}' was not quoted in on_select`);
      }
    }
  }

  // DORMANT, deliberately. No on_select in any of the nine flows declares a fulfillment
  // start location, so `expectedStartLocationIds` is always empty and this branch never
  // runs. Start locations first appear at on_confirm, so do NOT read this as "ship-from is
  // covered" — that is `validateShipFromLocation`, which anchors on the payload's own
  // provider.locations and therefore always has data. Kept so a seller that does declare
  // start locations in its quote is still held to them.
  const expectedStartLocationIds = new Set(
    storedFulfillments.map((f: any) => f?.start?.location?.id).filter(Boolean)
  );
  if (expectedStartLocationIds.size > 0) {
    checked.push("fulfillments[].start.location.id");
    for (const fulfillment of order?.fulfillments || []) {
      const locationId = fulfillment?.start?.location?.id;
      if (locationId && !expectedStartLocationIds.has(locationId)) {
        result.failed.push(
          `${label}: fulfillment '${fulfillment?.id ?? "?"}' ships from location '${locationId}', which on_select did not declare`
        );
      }
    }
  }

  if (checked.length > 0 && cleanRun()) {
    result.passed.push(`${label}: ${checked.join(", ")} all trace back to on_select`);
  }
}

/**
 * The order must be formed on the terms the seller actually quoted: each item's
 * `quantity.count` and its `fulfillment_id` must be what `on_select` came back with.
 *
 * CALIBRATION — the quantity comparison must be against `on_select`, NOT `select`.
 * The B2C prior art (log-validation-utility Init/init.ts:221-225) compares against the
 * quantities recorded at `select`, which would FALSE-FAIL three of the nine eB2B flows:
 * `(cod)`, `(Prepaid)` and `Merchant_Side_RTO...` all send `select` count 8 and `init`
 * count 1, because the seller re-quotes and the buyer app re-forms the order on the quote.
 * Against `on_select` the rule holds in all nine (and the prior art's own message calls
 * itself a "Warning", which suggests its authors knew).
 *
 * The item -> fulfillment pairing is the prior art's init.ts:206-219 rule, minus its
 * FLOW01D gate: `I1 -> F1` is paired identically in `on_select` and `init` in all nine
 * flows. `validateIdsAgainstOnSelect` above already proves both sets of ids trace back;
 * this adds that they are paired as quoted, which is the part that actually catches a
 * buyer app shipping an item on the wrong fulfillment.
 */
export function validateItemsAgainstOnSelect(
  order: any,
  onSelectData: Record<string, any> | null,
  label: string,
  result: TestResult
): void {
  if (!onSelectData) return;

  const storedItems = normalizeSaved(onSelectData.items);
  if (storedItems.length === 0) return;

  const quotedCountById = new Map<string, number>();
  const quotedFulfillmentById = new Map<string, string>();
  for (const item of storedItems) {
    if (isAbsent(item?.id)) continue;
    const count = item?.quantity?.count;
    if (Number.isInteger(count)) quotedCountById.set(String(item.id), count);
    if (!isAbsent(item?.fulfillment_id)) {
      quotedFulfillmentById.set(String(item.id), String(item.fulfillment_id));
    }
  }
  if (quotedCountById.size === 0 && quotedFulfillmentById.size === 0) return;

  const cleanRun = failureGate(result);
  let countsChecked = 0;
  let pairingsChecked = 0;

  for (const item of order?.items || []) {
    if (isAbsent(item?.id)) continue;
    const itemId = String(item.id);

    const quotedCount = quotedCountById.get(itemId);
    const currentCount = item?.quantity?.count;
    if (quotedCount !== undefined && Number.isInteger(currentCount)) {
      countsChecked++;
      if (currentCount !== quotedCount) {
        result.failed.push(
          `${label}: item ${itemId} orders quantity.count ${currentCount}, but on_select quoted ${quotedCount}`
        );
      }
    }

    const quotedFulfillment = quotedFulfillmentById.get(itemId);
    const currentFulfillment = item?.fulfillment_id;
    if (quotedFulfillment !== undefined && !isAbsent(currentFulfillment)) {
      pairingsChecked++;
      if (String(currentFulfillment) !== quotedFulfillment) {
        result.failed.push(
          `${label}: item ${itemId} is assigned fulfillment_id '${currentFulfillment}', but on_select paired it with '${quotedFulfillment}'`
        );
      }
    }
  }

  if ((countsChecked > 0 || pairingsChecked > 0) && cleanRun()) {
    const parts: string[] = [];
    if (countsChecked > 0) parts.push(`${countsChecked} quantity`);
    if (pairingsChecked > 0) parts.push(`${pairingsChecked} item->fulfillment pairing`);
    result.passed.push(`${label}: ${parts.join(" and ")} value(s) match what on_select quoted`);
  }
}

/**
 * Where the order ships FROM must be a location the order's own provider declares.
 *
 * Self-contained on purpose. `validateIdsAgainstOnSelect` above also has a
 * `fulfillments[].start.location.id` branch, but it compares against the start locations
 * declared in **on_select** — and no on_select in any of the nine flows declares one, so
 * that branch is permanently dormant (kept there only so a seller who does declare them is
 * still held to them). `on_confirm` is where start locations actually appear
 * (`start.location.id: L1`), and the provider declares `locations: [{id: L1}]` in all nine,
 * so the payload's own provider is the anchor that always has data.
 *
 * ---------------------------------------------------------------------------
 * DO NOT re-anchor this on the catalog's locations. Investigated 2026-10-13.
 * ---------------------------------------------------------------------------
 * A live Out_of_Stock session failed here, and it looked at first like a false positive —
 * the order shipped from `L1` while `order.provider.locations` was `[L2]`, and both L1 and
 * L2 are declared in the catalog, so "ship from a different declared warehouse" seemed
 * legitimate. Re-anchoring on the catalog made the failure disappear. That was WRONG, and
 * the per-leg payloads are why:
 *
 *   leg                provider.locations   items[].location_id   start.location.id
 *   select..confirm    [L2]                 L2                    -
 *   on_confirm         [L2]                 L1                    L1
 *   on_status x6       [L2]                 L2                    L1
 *
 * `provider.locations` is `[L2]` at every leg, and `items[].location_id` is `L2` at every
 * leg EXCEPT `on_confirm`, where the seller flips it to `L1` and then reverts to `L2`
 * afterwards. So the on_confirm payload is internally inconsistent — its own item claims a
 * location its own provider does not declare — and this rule was right to fail it. The
 * catalog-anchored version silently accepted a real defect, which is strictly worse than a
 * check that occasionally needs explaining.
 *
 * The prior art agrees that the ship-from is pinned, though it pins the gps and the
 * descriptor name rather than the id (`log-validation-utility`
 * `Retail_.1.2.5/Confirm/onConfirm.ts:542-553`: "store gps location … can't change", "store
 * name … can't change"). We cannot port those two: in eB2B the warehouse gps and name are
 * deliberately different from the catalog provider's (`ABC Distributors Warehouse` vs `ABC
 * Manufacturer`), so the equality rules would false-fail both flows that have a catalog.
 * The id membership check is the portable half of the same intent.
 *
 * Also range-checks `start.location.gps` when present, for the same reason.
 */
export function validateShipFromLocation(order: any, label: string, result: TestResult): void {
  const declared = new Set(
    (order?.provider?.locations || []).map((l: any) => l?.id).filter(Boolean).map(String)
  );

  const cleanRun = failureGate(result);
  let checked = 0;

  for (const fulfillment of order?.fulfillments || []) {
    const start = fulfillment?.start?.location;
    if (!start) continue;
    const ref = fulfillment?.id ? `fulfillment ${fulfillment.id}` : "fulfillment";

    if (!isAbsent(start.id)) {
      checked++;
      if (declared.size > 0 && !declared.has(String(start.id))) {
        result.failed.push(
          `${label}: ${ref} ships from location '${start.id}', which is not one of the provider's declared locations (${[...declared].join(", ")})`
        );
      }
    }

    if (!isAbsent(start.gps)) {
      checked++;
      validateGpsFormat(start.gps, `${label}.fulfillment.start.location`, result);
    }
  }

  if (checked > 0 && cleanRun()) {
    result.passed.push(`${label}: ship-from location id/gps valid on all declared fulfillment starts`);
  }
}

/**
 * Fulfillment-level contract fields that L1 requires the PRESENCE of but never the shape of.
 *
 * Added 2026-10-12 from the init-leg contract audit
 * (docs/RETeB2B-init-contract-audit.md §3.1), then widened the same day by the confirm-leg
 * audit (docs/RETeB2B-confirm-contract-audit.md §3.1) to cover `start.contact` and to run at
 * `confirm` / `on_confirm` as well.
 *
 * The contract names `fulfillments[].end.contact.phone` at `/init`, `/on_init`, `/confirm`
 * and `/on_confirm`, `fulfillments[].tracking` at all four, and
 * `fulfillments[].start.contact.phone` at `/on_confirm`; all nine reference payloads carry
 * every one of them at every leg that defines it. L1 already asserts they EXIST
 * (`FULFILLMENTS_END_CONTACT_PHONE`, `FULFILLMENTS_START_CONTACT_PHONE`,
 * `FULFILLMENTS_TRACKING`), so presence is not re-checked here — what L1 cannot see is
 * whether the values are usable:
 *
 *  - a `phone` that is not a dialable number is worse than no phone, because the buyer app
 *    will surface it. All nine payloads send a clean 10-digit `9876543210`. The 10-11 digit
 *    range matches the precedent already set by onSearchRetailChecks.validateFulfillmentContacts.
 *    Formatting is stripped before counting, and a leading `91` country code is dropped when
 *    that is what makes the number 12 digits, so `+91 98765-43210` passes: the B2C prior art
 *    is split between a bare /^(\d{10}|\d{11})$/ (FIS14) and an explicit `+91-` tolerance
 *    (metro), and a country-code-prefixed number is genuinely dialable. The `91` is dropped
 *    only at length 12, so a real 10-digit number beginning 91 is never truncated.
 *    L1 checks `customer.contact.phone` with a regex but `end`/`start.contact.phone` only for
 *    presence, so the shape rule is applying the spec's own standard where it stops short.
 *  - `tracking` must be a real BOOLEAN, not the string "true" — the same trap already closed
 *    at `on_select` and `on_status`. All nine send a genuine `false` at init/on_init/confirm
 *    and `true` at on_confirm. That flip is legitimate and consistent, so this checks the
 *    TYPE only; a "tracking must not regress" rule would be wrong.
 *
 * All validated-if-present, so a leg that legitimately omits one is left to L1.
 */
export function validateFulfillmentContactAndTracking(
  order: any,
  label: string,
  result: TestResult
): void {
  const fulfillments = order?.fulfillments;
  if (!Array.isArray(fulfillments) || fulfillments.length === 0) return;

  const cleanRun = failureGate(result);
  let checked = 0;

  for (const fulfillment of fulfillments) {
    const ref = `fulfillment ${fulfillment?.id ?? "?"}`;

    // `end` is the buyer's delivery contact, `start` the seller's warehouse. Both are held
    // to the same shape. Only `end` exists before the seller accepts the order, so the
    // `start` branch is a silent no-op at init/on_init/confirm and only does work at
    // on_confirm onward — which is exactly where the contract names it.
    for (const endpoint of ["start", "end"] as const) {
      const contact = fulfillment?.[endpoint]?.contact;
      if (!contact) continue;

      const phone = contact.phone;
      if (!isAbsent(phone)) {
        checked++;
        let digits = String(phone).replace(/\D/g, "");
        if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
        if (!/^\d{10,11}$/.test(digits)) {
          result.failed.push(
            `${label}: ${ref} ${endpoint}.contact.phone '${phone}' must be a 10- or 11-digit number`
          );
        }
      }

      const email = contact.email;
      if (!isAbsent(email) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email))) {
        result.failed.push(
          `${label}: ${ref} ${endpoint}.contact.email '${email}' is not a valid email`
        );
      }
    }

    const tracking = fulfillment?.tracking;
    if (!isAbsent(tracking)) {
      checked++;
      if (typeof tracking !== "boolean") {
        result.failed.push(
          `${label}: ${ref} tracking is '${tracking}' (${typeof tracking}) — it must be a boolean, not a string`
        );
      }
    }
  }

  if (checked > 0 && cleanRun()) {
    result.passed.push(
      `${label}: fulfillment contact/tracking values are well-formed across ${fulfillments.length} fulfillment(s)`
    );
  }
}

/**
 * The buyer's delivery locality (`end.location.address.locality`) must be a non-empty string.
 * The contract's /init and /confirm both carry it ("MG Road"), as do all 18 init/confirm
 * reference payloads across the nine flows. L1 only asserts it EXISTS, and its `are present`
 * treats `""` as present; L0's empty-field sweep is disabled for v1.x — so an empty locality
 * (raised by the manual tester, docs/RETeB2B-tester-bugs-coverage.md B4) passed every layer.
 * A fulfillment without an `end` is left to L1.
 */
export function validateDeliveryLocality(order: any, label: string, result: TestResult): void {
  const fulfillments = order?.fulfillments;
  if (!Array.isArray(fulfillments) || fulfillments.length === 0) return;

  const cleanRun = failureGate(result);
  let checked = 0;

  for (const fulfillment of fulfillments) {
    if (!fulfillment?.end) continue;
    checked++;
    const ref = `fulfillment ${fulfillment?.id ?? "?"}`;
    const locality = fulfillment.end.location?.address?.locality;

    if (isAbsent(locality)) {
      result.failed.push(`${label}: ${ref} end.location.address.locality is missing`);
    } else if (typeof locality !== "string") {
      result.failed.push(
        `${label}: ${ref} end.location.address.locality must be a string, got ${Array.isArray(locality) ? "array" : typeof locality}`
      );
    } else if (!locality.trim()) {
      result.failed.push(`${label}: ${ref} end.location.address.locality must not be empty`);
    }
  }

  if (checked > 0 && cleanRun()) {
    result.passed.push(
      `${label}: delivery locality is a non-empty string on all ${checked} fulfillment(s)`
    );
  }
}

/**
 * The two ISO-8601 durations this leg carries: each fulfillment's `@ondc/org/TAT` and the
 * quote's own `ttl`. Present in all nine flows at both legs (`P2D`/`PT4H` and `P1D`), and
 * L1 only checks that they exist, never that they parse.
 *
 * ALSO USED AT `on_init` as of 2026-10-12, where the contract names `quote.ttl` (all nine
 * payloads send `P1D`) and no `@ondc/org/TAT` — so the TAT loop simply finds nothing and the
 * function reduces to the ttl check. `quote.ttl` is now validated at every leg that carries
 * one: `on_select`, `on_init`, `confirm`, `on_confirm`.
 *
 * TAT is validated per leg and deliberately NOT echoed from on_select: on_select sends
 * `PT4H` in eight of nine flows while on_confirm sends `P2D` in all nine, so the prior
 * art's cross-call TAT equality (onConfirm.ts:151-157) would false-fail 8/9. The seller
 * legitimately firms up the turnaround once the order is accepted.
 */
export function validateOrderDurations(order: any, label: string, result: TestResult): void {
  const cleanRun = failureGate(result);
  let checked = 0;

  for (const fulfillment of order?.fulfillments || []) {
    const tat = fulfillment?.["@ondc/org/TAT"];
    if (isAbsent(tat)) continue;
    checked++;
    if (!ISO8601_DURATION.test(String(tat))) {
      result.failed.push(
        `${label}: fulfillment ${fulfillment?.id ?? "?"} @ondc/org/TAT '${tat}' is not a valid ISO-8601 duration`
      );
    }
  }

  const ttl = order?.quote?.ttl;
  if (!isAbsent(ttl)) {
    checked++;
    if (!ISO8601_DURATION.test(String(ttl))) {
      result.failed.push(`${label}: quote.ttl '${ttl}' is not a valid ISO-8601 duration`);
    }
  }

  if (checked > 0 && cleanRun()) {
    result.passed.push(`${label}: all ${checked} duration value(s) (@ondc/org/TAT, quote.ttl) are valid ISO-8601`);
  }
}

/**
 * A seller may re-stamp the order, but never backwards: `on_confirm`'s `order.updated_at`
 * must be strictly later than the one the buyer committed at `confirm`. Without this a
 * seller can echo a stale `updated_at` and nothing notices — the per-payload checks in
 * validateOrderTimestamps only compare a payload against itself.
 *
 * Deliberately scoped to `updated_at`. `created_at` is NOT compared across the leg: every
 * flow legitimately re-stamps it by the same amount as updated_at (measured deltas 15, 17,
 * 17, 18, 25, 29, 31, 47 and 74 ms), so an equality rule there would false-fail 9/9.
 */
export function validateUpdatedAtAdvances(
  order: any,
  storedUpdatedAt: any,
  priorLabel: string,
  label: string,
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
      `${label}: order.updated_at '${current}' is not later than the '${storedUpdatedAt}' committed at ${priorLabel} — the order may not be re-stamped backwards`
    );
    return;
  }

  result.passed.push(`${label}: order.updated_at advanced by ${now - before} ms since ${priorLabel}`);
}

/**
 * The PAN embedded in a GSTIN is characters 3-12. So `bpp_terms.tax_number` and
 * `bpp_terms.provider_tax_number` encode the same PAN when the seller NP and the provider
 * are the same legal entity, and different PANs when they are not — which is exactly what
 * `np_type` declares: `MSN` (multi-seller network) means distinct entities, `ISN`
 * (inventory-seller network) means the same one.
 *
 * Ported from log-validation-utility onConfirm.ts:431-446, with one deliberate change:
 * `np_type` is read from the payload's **own** bpp_terms, not from on_search. The prior art
 * reads it from on_search, which for eB2B can never work — on_search declares `np_type: MSN`
 * only in the two `with_offers` flows, and neither of those sends `np_type` at on_confirm,
 * while the four flows that do send it have no on_search step at all. The intersection is
 * empty, so the cross-call form of this rule could never fire.
 *
 * Skips silently when `np_type` is absent (five of nine flows) — requiring it would
 * false-fail those five, which is why "np_type is mandatory at on_confirm"
 * (onConfirm.ts:369-374) is NOT ported.
 */
export function validateTaxNumberPanConsistency(order: any, label: string, result: TestResult): void {
  const group = tagGroupsByCode(order?.tags, "bpp_terms")[0];
  if (!group) return;

  const npType = tagValue(group.list, "np_type");
  if (isAbsent(npType)) return;

  const taxNumber = String(tagValue(group.list, "tax_number") ?? "");
  const providerTaxNumber = String(tagValue(group.list, "provider_tax_number") ?? "");
  // Only meaningful once both are well formed; their formats are already reported by
  // validateBppTerms, so say nothing more about them here.
  if (!GSTIN.test(taxNumber) || !PAN.test(providerTaxNumber)) return;

  const embeddedPan = taxNumber.slice(2, 12);
  const same = embeddedPan === providerTaxNumber;

  if (String(npType) === "ISN" && !same) {
    result.failed.push(
      `${label}: np_type is ISN (the seller NP is the provider), so the PAN inside bpp_terms.tax_number ('${embeddedPan}') must equal provider_tax_number ('${providerTaxNumber}')`
    );
    return;
  }
  if (String(npType) === "MSN" && same) {
    result.failed.push(
      `${label}: np_type is MSN (the seller NP is not the provider), so the PAN inside bpp_terms.tax_number ('${embeddedPan}') must differ from provider_tax_number ('${providerTaxNumber}')`
    );
    return;
  }
  if (String(npType) !== "ISN" && String(npType) !== "MSN") return;

  result.passed.push(
    `${label}: bpp_terms PAN identity is consistent with np_type '${npType}' (tax_number PAN '${embeddedPan}' vs provider_tax_number '${providerTaxNumber}')`
  );
}

/**
 * The buyer app advertises its own finder fee in its `search` intent. It must still be
 * charging that when it commits the order — otherwise a BAP can advertise one rate and
 * settle on another, which `validateFinderFeeEcho` cannot see because that only compares
 * consecutive order-formation legs to each other.
 *
 * Ported from log-validation-utility confirm.ts:372-380 / onConfirm.ts:710-717.
 *
 * Only the two `_with_offers(...)` flows begin with a search, so this has data there
 * (`3.54` declared and `3.54` committed) and skips silently in the other seven. Note the
 * `search` save-spec key is flow-scoped rather than transaction-scoped
 * (src/utils/redisUtils.ts:34), which is what makes it readable from here at all.
 */
export function validateFinderFeeAgainstSearch(
  order: any,
  searchData: Record<string, any> | null,
  label: string,
  result: TestResult
): void {
  const declaredAmount = searchData?.finder_fee_amount;
  if (isAbsent(declaredAmount)) return;

  const declared = parseFloat(String(declaredAmount));
  if (Number.isNaN(declared)) return;

  const payments = paymentsOf(order);
  if (payments.length === 0) return;

  const cleanRun = failureGate(result);
  let checked = 0;

  payments.forEach((payment: any, index: number) => {
    const committedAmount = payment?.["@ondc/org/buyer_app_finder_fee_amount"];
    if (isAbsent(committedAmount)) return;
    const committed = parseFloat(String(committedAmount));
    if (Number.isNaN(committed)) return;
    checked++;

    if (Math.abs(committed - declared) > PRICE_TOLERANCE) {
      result.failed.push(
        `${label}: ${paymentLabel(index)}.@ondc/org/buyer_app_finder_fee_amount '${committedAmount}' does not match the '${declaredAmount}' the buyer app advertised in its search intent`
      );
    }

    const declaredType = searchData?.finder_fee_type;
    const committedType = payment?.["@ondc/org/buyer_app_finder_fee_type"];
    if (!isAbsent(declaredType) && !isAbsent(committedType) && String(declaredType) !== String(committedType)) {
      result.failed.push(
        `${label}: ${paymentLabel(index)}.@ondc/org/buyer_app_finder_fee_type '${committedType}' does not match the '${declaredType}' declared in search`
      );
    }
  });

  if (checked > 0 && cleanRun()) {
    result.passed.push(
      `${label}: buyer app finder fee (${declaredAmount}) is unchanged from the search intent`
    );
  }
}

/**
 * The buyer's and seller's tax identities must not be the same number — they are two
 * different legal entities on every order.
 *
 * Holds in all nine flows, but only trivially: `bap_terms.tax_number` is the literal
 * placeholder `gst_number_of_buyerNP` in every reference payload, so today this is a latent
 * check that starts earning its keep when buyer apps send real GSTINs. Kept because the
 * cost is nil and the failure it describes is unambiguous.
 * Ported from log-validation-utility confirm.ts:426-429.
 */
export function validateDistinctTaxIdentities(order: any, label: string, result: TestResult): void {
  const bpp = tagGroupsByCode(order?.tags, "bpp_terms")[0];
  const bap = tagGroupsByCode(order?.tags, "bap_terms")[0];
  if (!bpp || !bap) return;

  const bppTax = tagValue(bpp.list, "tax_number");
  const bapTax = tagValue(bap.list, "tax_number");
  if (isAbsent(bppTax) || isAbsent(bapTax)) return;

  if (String(bppTax) === String(bapTax)) {
    result.failed.push(
      `${label}: bap_terms.tax_number and bpp_terms.tax_number are both '${bppTax}' — the buyer and seller NPs must have different tax numbers`
    );
    return;
  }

  result.passed.push(`${label}: bap_terms and bpp_terms declare different tax numbers`);
}

/**
 * Cancellation terms, once quoted, must survive to the accepted order.
 *
 * `cancellation_terms` is absent in all nine reference flows at every leg, so this is a
 * forward-looking guard rather than a live check: it only ever speaks when BOTH the stored
 * prior leg and the current payload carry the field. Ported from
 * log-validation-utility onConfirm.ts:124-135, which likewise compares only when the prior
 * leg provided them.
 */
export function validateCancellationTermsEcho(
  order: any,
  storedTerms: any,
  priorLabel: string,
  label: string,
  result: TestResult
): void {
  const expected = normalizeSaved(storedTerms);
  if (expected.length === 0) return;
  const current = normalizeSaved(order?.cancellation_terms);
  if (current.length === 0) {
    result.failed.push(
      `${label}: order.cancellation_terms is missing, but ${priorLabel} quoted ${expected.length} term(s)`
    );
    return;
  }

  if (!deepEqual(expected, current)) {
    const diffs = diffPaths(expected, current, [], "cancellation_terms");
    result.failed.push(
      `${label}: order.cancellation_terms differ from the terms quoted in ${priorLabel}${diffs.length ? ` (${diffs.join("; ")})` : ""}`
    );
    return;
  }

  result.passed.push(`${label}: order.cancellation_terms are unchanged from ${priorLabel}`);
}

/**
 * An offer the order claims must be one the seller actually advertised, and must be
 * applicable to this order: present in the catalog provider's `offers`, valid for one of
 * the order's locations and one of its items, inside its own `time.range`, and — when it
 * declares a `qualifier.min_value` — actually qualified for by the order's value.
 *
 * Ported from log-validation-utility Init/init.ts:240-281 + the qualifier arithmetic
 * implicit in its :298-334 additivity block.
 *
 * CALIBRATION. Only two of the nine flows have an `on_search` step, so this has real data
 * only there and skips silently in the other seven — which is also why the init-leg doc
 * originally recorded "offers" as unportable on the grounds that `discp10` was "absent from
 * the catalog". That was measured against the seven flows that have no catalog at all.
 * `discp10` IS in both `with_offers` catalogs (alongside flat150, slab1, slab2, freebie1,
 * buy2get3), and every clause below holds there:
 *   with_offers(Prepaid) init sends offers [{id: discp10}]; catalog discp10 has
 *   location_ids ["L1"] (order has L1), item_ids ["I1".."I4"] (order has I1),
 *   time.label "valid", range 2026-06-29T00:00 -> 2026-07-04T23:59 with an init timestamp
 *   of 2026-06-29T07:29:39.107Z, and qualifier.min_value 500.00 against 17 x 52.00 = 884.00.
 *   with_offers(cod)'s SPEC example sends no order.offers at select or init (its seller
 *   auto-applies buy2get3 as a breakup line only), so it skips there. The live COD mock
 *   does opt into [{id: discp10}] at select and carries it into init, where it is checked.
 *
 * Two prior-art clauses are deliberately NOT included:
 *  - "offer must carry a `selection`/`apply: yes` tag" (:283-291) — eB2B order offers are a
 *    bare `{id}` with no tags at all. L1 only enum-checks `{yes, no}` IF the tag is present.
 *  - additivity, i.e. multiple non-additive offers cannot combine (:298-334) — not at this
 *    leg. The rule is real: both `with_offers` catalogs carry non-additive offers (slab1,
 *    slab2, freebie1 and buy2get3 are `meta.additive: no`), and a live on_select has applied
 *    two offers at once. But init's order.offers lists only the buyer's opt-ins; the seller's
 *    auto-applied offers exist only as quote breakup lines. Stacking is therefore enforced on
 *    the SELLER's applied lines at on_select, by offerChecks.validateOfferStacking.
 */
export function validateOffersAgainstCatalog(
  order: any,
  context: any,
  onSearchData: Record<string, any> | null,
  label: string,
  result: TestResult
): void {
  const claimedOffers = normalizeSaved(order?.offers);
  if (claimedOffers.length === 0) return;

  const providers = normalizeSaved(onSearchData?.providers);
  const provider = providers.find((p: any) => String(p?.id) === String(order?.provider?.id));
  if (!provider) return;

  const catalogOffers = normalizeSaved(provider.offers);
  if (catalogOffers.length === 0) return;

  const cleanRun = failureGate(result);

  const orderLocationIds = new Set(
    (order?.provider?.locations || []).map((l: any) => l?.id).filter(Boolean).map(String)
  );
  const orderItemIds = new Set(
    (order?.items || []).map((i: any) => i?.id).filter(Boolean).map(String)
  );

  const catalogPriceById = new Map<string, number>();
  for (const item of provider.items || []) {
    const price = parseFloat(item?.price?.value ?? "");
    if (!isAbsent(item?.id) && !Number.isNaN(price)) catalogPriceById.set(String(item.id), price);
  }

  const callTime = Date.parse(String(context?.timestamp));

  for (const claimed of claimedOffers) {
    if (isAbsent(claimed?.id)) continue;
    const offerId = String(claimed.id);
    const catalogOffer = catalogOffers.find(
      (o: any) => String(o?.id).toLowerCase() === offerId.toLowerCase()
    );

    if (!catalogOffer) {
      result.failed.push(
        `${label}: offer '${offerId}' was not advertised by provider '${order?.provider?.id}' in on_search`
      );
      continue;
    }

    const offerLocationIds = (catalogOffer.location_ids || []).map(String);
    if (
      offerLocationIds.length > 0 &&
      orderLocationIds.size > 0 &&
      !offerLocationIds.some((id: string) => orderLocationIds.has(id))
    ) {
      result.failed.push(
        `${label}: offer '${offerId}' is valid only at location(s) ${offerLocationIds.join(", ")}, none of which this order uses (${[...orderLocationIds].join(", ")})`
      );
    }

    const offerItemIds = (catalogOffer.item_ids || []).map(String);
    if (
      offerItemIds.length > 0 &&
      orderItemIds.size > 0 &&
      !offerItemIds.some((id: string) => orderItemIds.has(id))
    ) {
      result.failed.push(
        `${label}: offer '${offerId}' applies only to item(s) ${offerItemIds.join(", ")}, none of which this order contains (${[...orderItemIds].join(", ")})`
      );
    }

    const time = catalogOffer.time;
    if (time) {
      if (time.label !== "valid") {
        result.failed.push(
          `${label}: offer '${offerId}' is claimed but its catalog time.label is '${time.label}', not 'valid'`
        );
      }
      const start = Date.parse(String(time?.range?.start));
      const end = Date.parse(String(time?.range?.end));
      if (!Number.isNaN(callTime) && !Number.isNaN(start) && !Number.isNaN(end)) {
        if (callTime < start || callTime > end) {
          result.failed.push(
            `${label}: offer '${offerId}' is claimed at ${context?.timestamp}, outside its validity range ${time.range.start} -> ${time.range.end}`
          );
        }
      }
    }

    // `qualifier.min_value` is measured over the items the offer applies to, priced from
    // the catalog — the same arithmetic selectChecks.validateMinimumOrderValue uses.
    const qualifier = tagGroupsByCode(catalogOffer.tags, "qualifier")[0];
    const minValue = qualifier ? parseFloat(tagValue(qualifier.list, "min_value") ?? "") : NaN;
    if (!Number.isNaN(minValue)) {
      let qualifyingTotal = 0;
      let priced = 0;
      for (const item of order?.items || []) {
        const itemId = String(item?.id);
        if (offerItemIds.length > 0 && !offerItemIds.includes(itemId)) continue;
        const price = catalogPriceById.get(itemId);
        const count = item?.quantity?.count;
        if (price === undefined || !Number.isInteger(count)) continue;
        qualifyingTotal += price * count;
        priced++;
      }
      if (priced > 0 && qualifyingTotal < minValue) {
        result.failed.push(
          `${label}: offer '${offerId}' requires a qualifying value of ${minValue.toFixed(2)}, but the order only qualifies for ${qualifyingTotal.toFixed(2)}`
        );
      }
    }
  }

  if (cleanRun()) {
    result.passed.push(
      `${label}: all ${claimedOffers.length} claimed offer(s) are advertised in on_search and applicable to this order (location, item, validity window, qualifier)`
    );
  }
}

/**
 * An offer the buyer chose at `select` must still be claimed at `init` — dropping it
 * silently would mean the order is priced on terms the buyer never agreed to.
 * Ported from log-validation-utility Init/init.ts:342-356.
 *
 * ONE DIRECTION ONLY. The converse — every `init` offer must have appeared at `select` —
 * is NOT enforced and must not be added: five of the nine flows send
 * `init.offers: [{id: discp10}]` with no `select` offers at all, as a contract-sample
 * default. Both the `with_offers(Prepaid)` spec example and the live `with_offers(cod)` mock
 * send an offer at `select` (`discp10`), and both carry it into `init`, so the rule holds
 * wherever it has data. (The `with_offers(cod)` spec example sends none at either leg.)
 */
export function validateSelectOffersCarriedForward(
  order: any,
  selectData: Record<string, any> | null,
  label: string,
  result: TestResult
): void {
  const selectedOffers = normalizeSaved(selectData?.offers);
  const selectedIds = selectedOffers.map((o: any) => o?.id).filter(Boolean).map(String);
  if (selectedIds.length === 0) return;

  const cleanRun = failureGate(result);
  const claimedIds = new Set(
    normalizeSaved(order?.offers).map((o: any) => o?.id).filter(Boolean).map((id: any) => String(id).toLowerCase())
  );

  for (const offerId of selectedIds) {
    if (!claimedIds.has(offerId.toLowerCase())) {
      result.failed.push(
        `${label}: offer '${offerId}' was chosen in select but is not carried into ${label}`
      );
    }
  }

  if (cleanRun()) {
    result.passed.push(
      `${label}: all ${selectedIds.length} offer(s) chosen in select are carried forward (${selectedIds.join(", ")})`
    );
  }
}

/**
 * A payment that was already PAID at confirm must not revert. The seller may advance
 * NOT-PAID -> PAID (it collects the money), but it may never un-settle a payment the buyer
 * app reported as settled.
 */
export function validatePaymentStatusNoRegression(
  order: any,
  storedPayments: any,
  priorLabel: string,
  label: string,
  result: TestResult
): void {
  const stored = normalizeSaved(storedPayments);
  if (stored.length === 0) return;

  const wasPaid = stored.some((payment: any) => payment?.status === "PAID");
  if (!wasPaid) return;

  const current = paymentsOf(order);
  if (current.length === 0) return;

  const regressed = current.filter((payment: any) => payment?.status !== "PAID");
  if (regressed.length > 0) {
    result.failed.push(
      `${label}: payment status is '${regressed[0]?.status}' but ${priorLabel} already reported it PAID — a settled payment must not revert`
    );
    return;
  }
  result.passed.push(`${label}: payment status is still PAID, as ${priorLabel} reported`);
}

/**
 * `@ondc/org/buyer_app_finder_fee_type` / `_amount` — the buyer app's commission, fixed by
 * the seller at on_init (percent / 3.54 in all nine flows) and unchanged thereafter.
 *
 * The amount is compared NUMERICALLY, so a seller that re-serialises "3.54" as "3.540"
 * passes. The type is compared exactly — `percent` and `amount` mean different things.
 */
export function validateFinderFeeEcho(
  order: any,
  storedPayments: any,
  priorLabel: string,
  label: string,
  result: TestResult
): void {
  const stored = normalizeSaved(storedPayments)[0];
  const expectedType = stored?.["@ondc/org/buyer_app_finder_fee_type"];
  const expectedAmount = stored?.["@ondc/org/buyer_app_finder_fee_amount"];
  if (isAbsent(expectedType) && isAbsent(expectedAmount)) return;

  const payments = paymentsOf(order);
  if (payments.length === 0) return;

  const cleanRun = failureGate(result);

  payments.forEach((payment: any, index: number) => {
    const ref = paymentLabel(index);

    const actualType = payment?.["@ondc/org/buyer_app_finder_fee_type"];
    if (!isAbsent(expectedType) && !isAbsent(actualType) && actualType !== expectedType) {
      result.failed.push(
        `${label}: ${ref}.@ondc/org/buyer_app_finder_fee_type '${actualType}' does not echo ${priorLabel} ('${expectedType}')`
      );
    }

    const actualAmount = payment?.["@ondc/org/buyer_app_finder_fee_amount"];
    if (!isAbsent(expectedAmount) && !isAbsent(actualAmount)) {
      const expectedNum = parseFloat(String(expectedAmount));
      const actualNum = parseFloat(String(actualAmount));
      if (
        Number.isNaN(expectedNum) ||
        Number.isNaN(actualNum) ||
        Math.abs(expectedNum - actualNum) > PRICE_TOLERANCE
      ) {
        result.failed.push(
          `${label}: ${ref}.@ondc/org/buyer_app_finder_fee_amount '${actualAmount}' does not echo ${priorLabel} ('${expectedAmount}')`
        );
      }
    }
  });

  if (cleanRun()) {
    result.passed.push(
      `${label}: buyer app finder fee echoes ${priorLabel} unchanged (${expectedType} ${expectedAmount})`
    );
  }
}

// ---------------------------------------------------------------------------
// POST-CONFIRM ECHO — on_update / update / on_status / on_cancel
// ---------------------------------------------------------------------------
// The order is fixed at confirm. These three rules hold every later leg to it, and each was
// calibrated (2026-10-14) over every post-confirm leg of the nine eB2B order flows plus three
// live sessions — see docs/RETeB2B-merchant-rto-part-cancel-verification.md.

/**
 * The payment the buyer committed at confirm does not change afterwards: `params.amount`,
 * `currency` and (when both sides carry one) `transaction_id` are echoed on every later leg.
 *
 * Compared against CONFIRM, not on_confirm — on_confirm is itself a seller leg that can be
 * wrong (the Buyer_Initiated_Return reference sends 1150.00 there against a 1040.00 order)
 * and Out_of_Stock's on_confirm drops `transaction_id`, while every later leg in all nine
 * flows echoes confirm exactly. A partial refund does NOT reduce `params.amount`: it records
 * what was paid, and the refund travels as quote_trail + a `refund` settlement entry.
 *
 * Unanimous except the Merchant_Side_RTO part-cancel `on_update` / `update_settlement_trail`,
 * which carry the contract's own literal `1150` / `3937` (its original order total) instead
 * of this order's — a spec/mock defect this rule exists to catch.
 */
export function validatePaymentParamsEcho(
  order: any,
  storedPayments: any,
  label: string,
  result: TestResult
): void {
  const stored = normalizeSaved(storedPayments).filter((p: any) => p?.params);
  const current = paymentsOf(order).filter((p: any) => p?.params);
  if (stored.length === 0 || current.length === 0) return;

  const expected = stored[0].params;
  const ok = failureGate(result);
  current.forEach((payment: any, index: number) => {
    const params = payment.params;
    const ref = `payments[${index}].params`;
    const amount = Number(params?.amount);
    const expectedAmount = Number(expected?.amount);
    if (params?.amount !== undefined && expected?.amount !== undefined &&
        !(Number.isFinite(amount) && Number.isFinite(expectedAmount) && Math.abs(amount - expectedAmount) < 0.01)) {
      result.failed.push(
        `${label}: ${ref}.amount '${params.amount}' differs from the ${expected.amount} committed at confirm — the paid amount does not change after confirm (refunds travel as quote_trail + settlement)`
      );
    }
    if (params?.currency && expected?.currency && params.currency !== expected.currency) {
      result.failed.push(`${label}: ${ref}.currency '${params.currency}' differs from confirm's '${expected.currency}'`);
    }
    if (params?.transaction_id && expected?.transaction_id && String(params.transaction_id) !== String(expected.transaction_id)) {
      result.failed.push(
        `${label}: ${ref}.transaction_id '${params.transaction_id}' differs from confirm's '${expected.transaction_id}'`
      );
    }
  });
  if (ok()) {
    const detail = [expected.amount, expected.currency].filter(Boolean).join(" ");
    const txn = expected.transaction_id ? `, txn ${expected.transaction_id}` : "";
    result.passed.push(`${label}: payment params echo confirm (${detail}${txn})`);
  }
}

/**
 * `order.created_at` may be re-stamped on later legs (every reference flow does — see the
 * confirm save-spec), but a re-stamp only ever moves it FORWARD. A value earlier than the
 * order's own creation is a stale or placeholder timestamp. Measured: the only such value
 * across all post-confirm reference legs is the RTO part-cancel's literal `2023-06-03`.
 */
export function validateCreatedAtNotBeforeOrder(
  order: any,
  confirmData: any,
  label: string,
  result: TestResult
): void {
  if (order?.created_at === undefined || order?.created_at === null) return;
  const bounds = [toMillis(confirmData?.created_at), toMillis(confirmData?.timestamp)].filter(
    (v): v is number => v !== null
  );
  if (bounds.length === 0) return;
  const floor = Math.min(...bounds);
  const createdAt = toMillis(order.created_at);
  if (createdAt === null) {
    result.failed.push(`${label}: order.created_at '${order.created_at}' is not a valid timestamp`);
    return;
  }
  if (createdAt < floor) {
    result.failed.push(
      `${label}: order.created_at '${order.created_at}' is earlier than the order itself (confirmed ${new Date(floor).toISOString()}) — a stale or placeholder timestamp`
    );
    return;
  }
  result.passed.push(`${label}: order.created_at is not earlier than the order's confirmation`);
}

/** Forward order of the non-terminal order states; `Cancelled` is terminal and not ranked. */
const ORDER_STATE_RANK: Record<string, number> = { Created: 0, Accepted: 1, "In-progress": 2, Completed: 3 };

/**
 * An order never moves back to an earlier state. Contract Scenario 1 (part cancel by
 * merchant) keeps `order.state: "Accepted"` on its on_update; the RTO reference flow sends
 * `Created` there, after on_confirm's `Accepted` — a regression this rule reports.
 * `priorState` is the latest state the seller reported (previous on_status, else on_confirm).
 */
export function validateOrderStateNoRegression(
  order: any,
  priorState: any,
  priorLabel: string,
  label: string,
  result: TestResult
): void {
  const prior = normalizeSaved(priorState)[0];
  const current = order?.state;
  if (!prior || !current) return;
  const from = ORDER_STATE_RANK[String(prior)];
  const to = ORDER_STATE_RANK[String(current)];
  if (from === undefined || to === undefined) return; // Cancelled or unknown: not ranked
  if (to < from) {
    result.failed.push(
      `${label}: order.state '${current}' moves the order backwards from '${prior}' (${priorLabel}) — an order state never regresses`
    );
    return;
  }
  result.passed.push(`${label}: order.state '${current}' does not regress from '${prior}' (${priorLabel})`);
}
