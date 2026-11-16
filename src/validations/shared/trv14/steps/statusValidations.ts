import { Payload, TestResult } from "../../../../types/payload";
import { Trv14FlowProfile } from "../flowProfiles";
import { getPreviousTrv14Order, trv14FulfillmentShape } from "../helpers";

// Business rules for status / on_status that the workbench L1 does not cover.
// Values follow what the workbench (ONDC-Official draft-TRV14-2.0.0, commit
// ca523e5f) generates: status asks for the confirmed order_id (technical
// cancellation asks by ref_id — mandatoryFields.ts); on_status returns the
// confirmed order with the same id, created_at, items, quote, payments and ticket
// QR (token, valid_to), only its state moves on (stateTable.ts).

const isOnConfirmStep = (id: string) => id.startsWith("on_confirm");

const num = (v: any) => Number(v);

function tickets(order: any): string {
  return (order?.items ?? [])
    .filter((i: any) => i?.descriptor?.code !== "ABSTRACT")
    .map((i: any) => `${i?.id}:${num(i?.quantity?.selected?.count)}`)
    .sort()
    .join(",");
}

function quoteKey(quote: any): string {
  const lines = (quote?.breakup ?? []).map((b: any) => `${b?.title}|${b?.item?.id ?? ""}|${num(b?.price?.value)}`).sort();
  return `${num(quote?.price?.value)}#${lines.join(",")}`;
}

function paymentsKey(order: any): string {
  return (order?.payments ?? [])
    .map((p: any) => `${p?.id}|${p?.status}|${p?.params?.transaction_id}|${num(p?.params?.amount)}`)
    .sort()
    .join(",");
}

function ticketQrs(order: any): string {
  return (order?.fulfillments ?? [])
    .flatMap((f: any) => (f?.stops ?? []).filter((s: any) => s?.authorization).map((s: any) => `${f?.id}|${s?.type}|${s.authorization?.token}|${s.authorization?.valid_to}`))
    .sort()
    .join(",");
}

export async function validateTrv14Status(
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
  if (!txnId || request?.error) return;
  const label = `${action} (${actionId})`;
  const confirmed = await getPreviousTrv14Order(sessionID, flowId, txnId, profile.sequence, actionId, isOnConfirmStep);
  if (!confirmed) return;
  const confirmedId = confirmed.order?.id;

  if (action === "status") {
    // Technical cancellation asks by ref_id; mandatoryFields.ts checks that one.
    if (profile.postConfirm === "TECH_CANCEL") return;
    const orderId = request?.message?.order_id;
    if (orderId === confirmedId) testResults.passed.push(`${label}: order_id matches ${confirmed.actionId}`);
    else testResults.failed.push(`${label}: order_id '${orderId}' must be the confirmed order '${confirmedId}' from ${confirmed.actionId}`);
    return;
  }

  // on_status: the confirmed order, only its state moves on.
  const order = request?.message?.order;
  if (!order) return;
  const problems: string[] = [];
  if (order?.id !== confirmedId) problems.push(`order.id '${order?.id}' must be '${confirmedId}'`);
  if (order?.created_at !== confirmed.order?.created_at) problems.push(`order.created_at '${order?.created_at}' must stay '${confirmed.order?.created_at}'`);
  const updated = Date.parse(order?.updated_at);
  const confirmedUpdated = Date.parse(confirmed.order?.updated_at);
  if (!isNaN(updated) && !isNaN(confirmedUpdated) && updated < confirmedUpdated) {
    problems.push(`order.updated_at '${order?.updated_at}' must not be before ${confirmed.actionId}'s '${confirmed.order?.updated_at}'`);
  }
  if (order?.provider?.id !== confirmed.order?.provider?.id) problems.push(`provider.id '${order?.provider?.id}' must be '${confirmed.order?.provider?.id}'`);
  if (tickets(order) !== tickets(confirmed.order)) problems.push(`items/quantities [${tickets(order)}] must be [${tickets(confirmed.order)}]`);
  if (quoteKey(order?.quote) !== quoteKey(confirmed.order?.quote)) problems.push("quote must be unchanged");
  if (paymentsKey(order) !== paymentsKey(confirmed.order)) problems.push("payments (id, status, params.transaction_id, params.amount) must be unchanged");
  if (ticketQrs(order) !== ticketQrs(confirmed.order)) problems.push("ticket authorization (token, valid_to) must be unchanged");
  if (trv14FulfillmentShape(order) !== trv14FulfillmentShape(confirmed.order)) problems.push("fulfillments (id, type, stop types) must be unchanged");

  if (problems.length === 0) testResults.passed.push(`${label}: order id, created_at, items, quote, payments, fulfillments and ticket QR match ${confirmed.actionId}`);
  for (const p of problems) testResults.failed.push(`${label}: ${p} (from ${confirmed.actionId})`);
}
