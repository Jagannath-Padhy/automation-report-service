import { TestResult } from "../../types/payload";

/**
 * L2 (cross-call) checks for RSF 2.1.0 (ONDC:NTS10) `recon` / `on_recon`.
 *
 * Schema, enum and required-field checks are NOT repeated here: they run in the external
 * L0+L1 validation (config/validations in automation-specifications). These checks only
 * compare a payload with the earlier call of the same transaction, which L1 cannot see.
 *
 * The checks are role-agnostic: they hold whether the collector/buyer or the receiver/seller
 * sent the `recon`, because only the order of the calls matters.
 */

const MONEY_FIELDS = ["amount", "commission", "withholding_amount", "tcs", "tds", "delay_amount"] as const;
const round2 = (n: number) => Math.round(n * 100) / 100;

const firstOrder = (orders: any) => (Array.isArray(orders) ? orders[0] : orders);
const findSettlement = (order: any, id: any) =>
  Array.isArray(order?.settlements) ? order.settlements.find((s: any) => s?.id === id) : undefined;

function checkTimestampAfter(ctx: any, source: any, label: string, result: TestResult) {
  const current = Date.parse(ctx?.timestamp);
  const previous = Date.parse(source?.timestamp);
  if (Number.isNaN(current) || Number.isNaN(previous)) return;
  if (current > previous) result.passed.push(`context.timestamp is later than the ${label}`);
  else result.failed.push(`context.timestamp must be later than the ${label}`);
}

/** Order id, settlement ids, counterparty_id and payment_id must match the earlier call. */
function checkOrderAndSettlementIdentity(order: any, source: any, label: string, result: TestResult) {
  if (order?.id === source?.id) result.passed.push(`Order ID matches the order in ${label}`);
  else result.failed.push(`Order ID does not match the order in ${label}`);

  for (const [i, s] of (order?.settlements ?? []).entries()) {
    const src = findSettlement(source, s?.id);
    if (!src) {
      result.failed.push(`settlements[${i}].id ${s?.id} was not present in ${label}`);
      continue;
    }
    if (s?.counterparty_id !== src.counterparty_id) {
      result.failed.push(`settlements[${i}].counterparty_id does not match ${label}`);
    }
    if (s?.payment_id !== src.payment_id) {
      result.failed.push(`settlements[${i}].payment_id does not match ${label}`);
    }
  }
}

function hasDiffValue(s: any): boolean {
  return MONEY_FIELDS.some((k) => s?.[k]?.diff_value !== undefined);
}

function checkValuesEqualSource(s: any, src: any, i: number, label: string, result: TestResult) {
  for (const key of MONEY_FIELDS) {
    if (s?.[key]?.value !== src?.[key]?.value) {
      result.failed.push(`settlements[${i}].${key}.value does not match the value in ${label}`);
    }
  }
}

/**
 * on_recon vs the recon it answers.
 * - recon_accord false: diff_value (when sent) is the difference from the recon value, and a SETTLED
 *   settlement is unchanged and carries no diff_value.
 * - recon_accord true: the values equal the recon values and no diff_value is sent.
 */
export function validateOnReconAgainstRecon(ctx: any, message: any, error: any, reconData: any, result: TestResult) {
  const source = firstOrder(reconData?.orders);
  if (!source) {
    result.failed.push("recon of this transaction was not found; on_recon cannot be cross-checked");
    return;
  }

  if (ctx?.message_id === reconData?.message_id) result.passed.push("context.message_id matches the recon it responds to");
  else result.failed.push("context.message_id does not match the recon it responds to");
  checkTimestampAfter(ctx, reconData, "recon it responds to", result);

  // An error response carries no order to compare
  if (error) return;

  const order = firstOrder(message?.orders);
  checkOrderAndSettlementIdentity(order, source, "recon", result);

  const accord = order?.recon_accord;
  for (const [i, s] of (order?.settlements ?? []).entries()) {
    const src = findSettlement(source, s?.id);
    if (!src) continue;

    if (s?.status === "SETTLED" || accord === true) {
      if (hasDiffValue(s)) {
        result.failed.push(
          `settlements[${i}] must not carry diff_value ${s?.status === "SETTLED" ? "for a SETTLED settlement" : "when recon_accord is true"}`
        );
      }
      checkValuesEqualSource(s, src, i, "recon", result);
      continue;
    }

    if (accord === false) {
      for (const key of MONEY_FIELDS) {
        const diff = s?.[key]?.diff_value;
        if (diff === undefined) continue;
        const expected = round2(Math.abs(Number(s[key].value) - Number(src?.[key]?.value ?? 0)));
        if (round2(Number(diff)) !== expected) {
          result.failed.push(`settlements[${i}].${key}.diff_value (${diff}) does not match the difference from the recon value (${expected.toFixed(2)})`);
        }
      }
    }
  }
}

/**
 * A second recon agrees to the counterparty values, so it must repeat the on_recon values
 * (without diff_value) for the same order and settlements.
 */
export function validateReconAgainstOnRecon(ctx: any, message: any, onReconData: any, result: TestResult) {
  const source = firstOrder(onReconData?.orders);
  if (!source) return;

  checkTimestampAfter(ctx, onReconData, "on_recon it follows", result);

  const order = firstOrder(message?.orders);
  checkOrderAndSettlementIdentity(order, source, "on_recon", result);

  for (const [i, s] of (order?.settlements ?? []).entries()) {
    const src = findSettlement(source, s?.id);
    if (!src) continue;
    if (hasDiffValue(s)) result.failed.push(`settlements[${i}] must not carry diff_value in a recon that agrees to the on_recon values`);
    checkValuesEqualSource(s, src, i, "on_recon", result);
  }
}
