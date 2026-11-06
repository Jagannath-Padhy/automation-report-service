import { Payload, TestResult } from "../../../../types/payload";
import { Trv14FlowProfile } from "../flowProfiles";
import { getPreviousTrv14Order, getTrv14ActionData, trv14FulfillmentShape } from "../helpers";

// Business rules for cancel / on_cancel (soft, confirm, rejected, unsolicited) and
// update / on_update (partial cancellation) that the workbench L1 does not cover
// (L1 checks presence and the reason / descriptor enums). Values follow what the
// workbench (ONDC-Official draft-TRV14-2.0.0, commit ca523e5f) generates:
// - cancel: order_id = confirmed order; SOFT_CANCEL then CONFIRM_CANCEL; same reason
//   both times; 000 in technical cancellation, a user reason otherwise.
// - on_cancel: the confirmed order (id, created_at, items, payments, ticket QR); the
//   quote keeps BASE_PRICE / ADD_ONS, adds a REFUND per ticket = -(its BASE_PRICE +
//   ADD_ONS) and CANCELLATION_CHARGES = the terms' fee % of the confirmed total (0 for
//   technical cancellation); the new total is the charges.
// - on_cancel_rejected: an error, no order.
// - update: lower quantity for a confirmed ticket; on_update shows it with a REFUND
//   for the cancelled tickets and CANCELLATION_CHARGES; the confirm round repeats it.

const isOnConfirmStep = (id: string) => id.startsWith("on_confirm");
const isCancelStep = (id: string) => id.startsWith("cancel");
const isOnCancelStep = (id: string) => id.startsWith("on_cancel");
const isUpdateStep = (id: string) => id.startsWith("update");
const isOnUpdateStep = (id: string) => id.startsWith("on_update");

const num = (v: any) => Number(v);
const sameAmount = (a: any, b: any) => Math.abs(num(a) - num(b)) < 0.01;

function quoteKey(quote: any): string {
  const lines = (quote?.breakup ?? []).map((b: any) => `${b?.title}|${b?.item?.id ?? ""}|${num(b?.price?.value)}`).sort();
  return `${num(quote?.price?.value)}#${lines.join(",")}`;
}

function line(quote: any, title: string, itemId?: string): any {
  return (quote?.breakup ?? []).find((b: any) => b?.title === title && (itemId === undefined || b?.item?.id === itemId));
}

function qtyOf(order: any, itemId: string): number {
  return num((order?.items ?? []).find((i: any) => i?.id === itemId)?.quantity?.selected?.count);
}

function paymentsKey(order: any): string {
  return (order?.payments ?? []).map((p: any) => `${p?.id}|${p?.status}|${p?.params?.transaction_id}|${num(p?.params?.amount)}`).sort().join(",");
}

function ticketQrs(order: any): string {
  return (order?.fulfillments ?? [])
    .flatMap((f: any) => (f?.stops ?? []).filter((s: any) => s?.authorization).map((s: any) => `${f?.id}|${s.authorization?.token}|${s.authorization?.valid_to}`))
    .sort()
    .join(",");
}

/** The confirmed order's id, created_at, payments and ticket QR stay as they were. */
function checkConfirmedOrderKept(order: any, confirmed: { actionId: string; order: any }, label: string, testResults: TestResult): void {
  const problems: string[] = [];
  if (order?.id !== confirmed.order?.id) problems.push(`order.id '${order?.id}' must be '${confirmed.order?.id}'`);
  if (order?.created_at !== confirmed.order?.created_at) problems.push("order.created_at must be unchanged");
  if (paymentsKey(order) !== paymentsKey(confirmed.order)) problems.push("payments must be unchanged");
  if (ticketQrs(order) !== ticketQrs(confirmed.order)) problems.push("ticket authorization (token, valid_to) must be unchanged");
  if (trv14FulfillmentShape(order) !== trv14FulfillmentShape(confirmed.order)) problems.push("fulfillments (id, type, stop types) must be unchanged");
  if (problems.length === 0) testResults.passed.push(`${label}: order id, created_at, payments, fulfillments and ticket QR kept from ${confirmed.actionId}`);
  for (const p of problems) testResults.failed.push(`${label}: ${p} (from ${confirmed.actionId})`);
}

/** Fee % from the confirmed order's cancellation terms for the CONFIRMED state. */
function cancellationFeePercent(confirmedOrder: any): number | undefined {
  const term = (confirmedOrder?.cancellation_terms ?? []).find(
    (t: any) => t?.fulfillment_state?.descriptor?.code === "CONFIRMED" && t?.cancellation_fee?.percentage !== undefined
  );
  return term ? num(term.cancellation_fee.percentage) : undefined;
}

/** Saved data of the latest step before `actionId` whose action_id matches. */
async function previousSaved(
  sessionID: string,
  flowId: string,
  transactionId: string,
  sequence: string[],
  actionId: string,
  isMatch: (id: string) => boolean
): Promise<{ actionId: string; data: Record<string, any> } | null> {
  for (let i = sequence.indexOf(actionId) - 1; i >= 0; i--) {
    if (!isMatch(sequence[i])) continue;
    const data = await getTrv14ActionData(sessionID, flowId, transactionId, sequence[i]);
    if (data) return { actionId: sequence[i], data };
  }
  return null;
}

export async function validateTrv14CancelUpdate(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string,
  profile: Trv14FlowProfile,
  testResults: TestResult
): Promise<void> {
  const request = element?.jsonRequest;
  const action: string = request?.context?.action;
  const txnId: string | undefined = request?.context?.transaction_id;
  if (!txnId) return;
  const label = `${action} (${actionId})`;
  const message = request?.message ?? {};
  const previous = (match: (id: string) => boolean) =>
    getPreviousTrv14Order(sessionID, flowId, txnId, profile.sequence, actionId, match);
  const confirmed = await previous(isOnConfirmStep);

  if (action === "cancel") {
    if (confirmed && message?.order_id !== confirmed.order?.id) {
      testResults.failed.push(`${label}: order_id '${message?.order_id}' must be the confirmed order '${confirmed.order?.id}'`);
    }
    const expectedCode = actionId.includes("_confirm_") ? "CONFIRM_CANCEL" : "SOFT_CANCEL";
    if (message?.descriptor?.code === expectedCode) testResults.passed.push(`${label}: descriptor.code is ${expectedCode}`);
    else testResults.failed.push(`${label}: descriptor.code must be ${expectedCode}, found '${message?.descriptor?.code}'`);

    const reason = message?.cancellation_reason_id;
    if (profile.postConfirm === "TECH_CANCEL" && reason !== "000") {
      testResults.failed.push(`${label}: a technical cancellation must use reason 000, found '${reason}'`);
    }
    if (profile.postConfirm === "USER_CANCEL" && reason === "000") {
      testResults.failed.push(`${label}: a user cancellation must not use the technical reason 000`);
    }
    if (expectedCode === "CONFIRM_CANCEL") {
      const soft = await previousSaved(sessionID, flowId, txnId, profile.sequence, actionId, (id) => isCancelStep(id) && !id.includes("_confirm_"));
      if (soft && soft.data?.cancellation_reason_id !== reason) {
        testResults.failed.push(`${label}: cancellation_reason_id '${reason}' must match ${soft.actionId}'s '${soft.data?.cancellation_reason_id}'`);
      } else if (soft) {
        testResults.passed.push(`${label}: same cancellation reason as ${soft.actionId}`);
      }
    }
    return;
  }

  if (action === "on_cancel") {
    if (request?.error) {
      if (profile.postConfirm !== "CANCEL_REJECTED") {
        testResults.failed.push(`${label}: unexpected error ${request.error?.code} in a flow where the cancellation is accepted`);
        return;
      }
      const code = String(request.error?.code ?? "");
      if (/^932\d\d$/.test(code) && request.error?.message) testResults.passed.push(`${label}: cancellation rejected with error ${code}`);
      else testResults.failed.push(`${label}: a rejected cancellation must carry a TRV14 error code (932xx) and a message, found '${code}'`);
      if (message?.order) testResults.failed.push(`${label}: a rejected cancellation must not return an order`);
      return;
    }
    if (profile.postConfirm === "CANCEL_REJECTED") {
      testResults.failed.push(`${label}: this flow expects the cancellation to be rejected with an error`);
      return;
    }
    const order = message?.order;
    if (!order || !confirmed) return;
    checkConfirmedOrderKept(order, confirmed, label, testResults);

    const confirmedTickets = (confirmed.order?.items ?? []).filter((i: any) => i?.descriptor?.code === "ENTRY_PASS");
    const ticketsNow = (order?.items ?? []).filter((i: any) => i?.descriptor?.code === "ENTRY_PASS");
    if (ticketsNow.map((i: any) => `${i.id}:${qtyOf(order, i.id)}`).sort().join(",") !== confirmedTickets.map((i: any) => `${i.id}:${qtyOf(confirmed.order, i.id)}`).sort().join(",")) {
      testResults.failed.push(`${label}: items/quantities must be the confirmed order's`);
    }

    // Who cancelled and why.
    const cancellation = order?.cancellation;
    const cancelRequest = profile.unsolicited.includes(actionId)
      ? null
      : await previousSaved(sessionID, flowId, txnId, profile.sequence, actionId, isCancelStep);
    if (!cancellation?.cancelled_by) testResults.failed.push(`${label}: order.cancellation.cancelled_by is required`);
    const reasonCode = cancellation?.reason?.descriptor?.code;
    const askedReason = cancelRequest?.data?.cancellation_reason_id;
    if (cancelRequest && reasonCode !== askedReason) {
      testResults.failed.push(`${label}: cancellation.reason.descriptor.code '${reasonCode}' must echo ${cancelRequest.actionId}'s '${askedReason}'`);
    } else if (reasonCode) {
      testResults.passed.push(`${label}: cancellation reason ${reasonCode}, cancelled by ${cancellation?.cancelled_by}`);
    }

    // Quote: refund every ticket, charge the cancellation fee.
    const quote = order?.quote;
    const confirmedQuote = confirmed.order?.quote;
    let quoteProblems = 0;
    for (const t of confirmedTickets) {
      const base = num(line(confirmedQuote, "BASE_PRICE", t.id)?.price?.value);
      const addOns = num(line(confirmedQuote, "ADD_ONS", t.id)?.price?.value ?? 0);
      const refund = line(quote, "REFUND", t.id);
      if (!refund || !sameAmount(refund?.price?.value, -(base + addOns))) {
        quoteProblems++;
        testResults.failed.push(`${label}: REFUND for ${t.id} must be ${-(base + addOns)}, found '${refund?.price?.value}'`);
      }
    }
    const charges = line(quote, "CANCELLATION_CHARGES");
    if (!charges) {
      quoteProblems++;
      testResults.failed.push(`${label}: quote must carry a CANCELLATION_CHARGES line`);
    } else {
      const feePercent = profile.postConfirm === "TECH_CANCEL" ? 0 : cancellationFeePercent(confirmed.order);
      if (feePercent !== undefined) {
        const expected = (num(confirmedQuote?.price?.value) * feePercent) / 100;
        if (!sameAmount(charges?.price?.value, expected)) {
          quoteProblems++;
          testResults.failed.push(`${label}: CANCELLATION_CHARGES ${charges?.price?.value} must be ${expected} (${feePercent}% of ${confirmedQuote?.price?.value})`);
        }
      }
      if (!sameAmount(quote?.price?.value, charges?.price?.value)) {
        quoteProblems++;
        testResults.failed.push(`${label}: quote total ${quote?.price?.value} must equal the CANCELLATION_CHARGES ${charges?.price?.value}`);
      }
    }
    if (quoteProblems === 0) testResults.passed.push(`${label}: refunds every ticket and charges the cancellation fee`);

    // The confirmed cancellation repeats the soft one.
    if (actionId.includes("_confirm_")) {
      const soft = await previous((id) => isOnCancelStep(id) && id.includes("_soft_"));
      if (soft) {
        if (quoteKey(quote) === quoteKey(soft.order?.quote)) testResults.passed.push(`${label}: quote matches ${soft.actionId}`);
        else testResults.failed.push(`${label}: quote must match ${soft.actionId}`);
        if (Date.parse(order?.updated_at) < Date.parse(soft.order?.updated_at)) {
          testResults.failed.push(`${label}: order.updated_at must not be before ${soft.actionId}'s`);
        }
      }
    }
    return;
  }

  if (action === "update") {
    const order = message?.order;
    if (!order || !confirmed) return;
    if (!String(message?.update_target ?? "").startsWith("order.items")) {
      testResults.failed.push(`${label}: update_target must point at order.items, found '${message?.update_target}'`);
    }
    const expectedCode = actionId.includes("_confirm_") ? "CONFIRM_CANCEL" : "SOFT_CANCEL";
    const reason = order?.cancellation?.reason;
    if (reason?.descriptor?.code !== expectedCode) {
      testResults.failed.push(`${label}: cancellation.reason.descriptor.code must be ${expectedCode}, found '${reason?.descriptor?.code}'`);
    }
    for (const item of order?.items ?? []) {
      const before = qtyOf(confirmed.order, item?.id);
      const after = num(item?.quantity?.selected?.count);
      if (isNaN(before)) testResults.failed.push(`${label}: item ${item?.id} is not in the confirmed order`);
      else if (!(after >= 0 && after < before)) testResults.failed.push(`${label}: item ${item?.id} quantity ${after} must be lower than the confirmed ${before}`);
      else testResults.passed.push(`${label}: cancels ${before - after} of item ${item.id} (${before} -> ${after})`);
    }
    if (expectedCode === "CONFIRM_CANCEL") {
      const soft = await previous((id) => isUpdateStep(id) && !id.includes("_confirm_"));
      if (soft && JSON.stringify(soft.order?.items) !== JSON.stringify(order?.items)) {
        testResults.failed.push(`${label}: items must match ${soft.actionId}`);
      }
      if (soft && soft.order?.cancellation?.reason?.id !== reason?.id) {
        testResults.failed.push(`${label}: cancellation.reason.id must match ${soft.actionId}`);
      }
    }
    return;
  }

  if (action === "on_update") {
    const order = message?.order;
    if (!order || !confirmed) return;
    checkConfirmedOrderKept(order, confirmed, label, testResults);
    const update = await previous(isUpdateStep);
    const quote = order?.quote;
    for (const item of update?.order?.items ?? []) {
      const requested = num(item?.quantity?.selected?.count);
      const cancelled = qtyOf(confirmed.order, item?.id) - requested;
      if (qtyOf(order, item?.id) !== requested) {
        testResults.failed.push(`${label}: item ${item?.id} quantity ${qtyOf(order, item?.id)} must be the updated ${requested}`);
      }
      const refund = line(quote, "REFUND", item?.id);
      if (!refund || !(num(refund?.price?.value) < 0) || num(refund?.item?.quantity?.selected?.count) !== cancelled) {
        testResults.failed.push(`${label}: quote needs a negative REFUND for ${item?.id} covering the ${cancelled} cancelled ticket(s)`);
      } else {
        testResults.passed.push(`${label}: refunds ${cancelled} ticket(s) of ${item.id}`);
      }
    }
    if (!line(quote, "CANCELLATION_CHARGES")) testResults.failed.push(`${label}: quote must carry a CANCELLATION_CHARGES line`);
    if (actionId.includes("_confirm_")) {
      const soft = await previous((id) => isOnUpdateStep(id) && !id.includes("_confirm_"));
      if (soft) {
        if (quoteKey(quote) === quoteKey(soft.order?.quote)) testResults.passed.push(`${label}: quote matches ${soft.actionId}`);
        else testResults.failed.push(`${label}: quote must match ${soft.actionId}`);
      }
    }
  }
}
