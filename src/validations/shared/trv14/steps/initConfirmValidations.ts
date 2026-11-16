import { Payload, TestResult } from "../../../../types/payload";
import { Trv14FlowProfile } from "../flowProfiles";
import { getPreviousTrv14Order } from "../helpers";

// Business rules for init / on_init / confirm / on_confirm (incl. the
// "_bap_ convenience" variants) that the workbench L1 does not cover (L1 checks
// presence, enums and payment params presence). Values follow what the workbench
// (ONDC-Official draft-TRV14-2.0.0, commit ca523e5f) generates: the order built at
// select is carried unchanged to on_confirm; the quote stays the last on_select
// quote, plus a BAP_CONVENIENCE_FEE line when the BAP adds one at init; confirm pays
// params.amount = quote total; on_confirm adds the order id, timestamps and the
// ticket QR. BPP_TERMS.SETTLEMENT_AMOUNT is checked on every call (settlement.ts).

const isOnSelectStep = (id: string) => id.startsWith("on_select");
const isInitStep = (id: string) => id.startsWith("init");
const isOnInitStep = (id: string) => id.startsWith("on_init");
const isConfirmStep = (id: string) => id.startsWith("confirm");

const num = (v: any) => Number(v);
const sameAmount = (a: any, b: any) => Math.abs(num(a) - num(b)) < 0.01;

function tickets(order: any): string {
  return (order?.items ?? [])
    .filter((i: any) => i?.descriptor?.code !== "ABSTRACT")
    .map((i: any) => `${i?.id}:${num(i?.quantity?.selected?.count)}:${i?.parent_item_id ?? ""}`)
    .sort()
    .join(",");
}

function quoteLines(quote: any): string[] {
  return (quote?.breakup ?? []).map((b: any) => `${b?.title}|${b?.item?.id ?? ""}|${num(b?.price?.value)}`).sort();
}

function sameQuote(a: any, b: any): boolean {
  return sameAmount(a?.price?.value, b?.price?.value) && quoteLines(a).join(",") === quoteLines(b).join(",");
}

function paymentKeys(order: any): string {
  return (order?.payments ?? []).map((p: any) => `${p?.id}|${p?.collected_by}|${p?.type}`).sort().join(",");
}

function tagMap(tags: any[] | undefined): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const t of tags ?? []) {
    const list: Record<string, string> = {};
    for (const e of t?.list ?? []) list[e?.descriptor?.code] = e?.value;
    out[t?.descriptor?.code] = list;
  }
  return out;
}

function sameTag(a: any[] | undefined, b: any[] | undefined, code: string): boolean {
  return JSON.stringify(tagMap(a)[code] ?? null) === JSON.stringify(tagMap(b)[code] ?? null);
}

/** Order, items and provider must carry over from the previous step. */
function checkCarryOver(order: any, previous: { actionId: string; order: any } | null, label: string, testResults: TestResult): void {
  if (!previous) return;
  const problems: string[] = [];
  if (previous.order?.provider?.id && previous.order.provider.id !== order?.provider?.id) problems.push(`provider.id '${order?.provider?.id}' differs from '${previous.order.provider.id}'`);
  if (tickets(previous.order) !== tickets(order)) problems.push(`items/quantities [${tickets(order)}] differ from [${tickets(previous.order)}]`);
  if (problems.length === 0) testResults.passed.push(`${label}: provider and items carried over from ${previous.actionId}`);
  else for (const p of problems) testResults.failed.push(`${label}: ${p} in ${previous.actionId}`);
}

export async function validateTrv14InitConfirm(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string,
  profile: Trv14FlowProfile,
  testResults: TestResult
): Promise<void> {
  const request = element?.jsonRequest;
  const action: string = request?.context?.action;
  const order = request?.message?.order;
  const txnId: string | undefined = request?.context?.transaction_id;
  if (!order || !txnId) return;
  const label = `${action} (${actionId})`;
  const previous = (match: (id: string) => boolean) =>
    getPreviousTrv14Order(sessionID, flowId, txnId, profile.sequence, actionId, match);

  if (action === "init") {
    checkCarryOver(order, await previous(isOnSelectStep), label, testResults);
    const payments = order?.payments ?? [];
    if (payments.length === 0 || payments.some((p: any) => !p?.id || !p?.collected_by)) {
      testResults.failed.push(`${label}: every payment must carry an id and collected_by`);
    }
    return;
  }

  if (action === "on_init") {
    const init = await previous(isInitStep);
    checkCarryOver(order, init, label, testResults);
    if (init && paymentKeys(init.order) !== paymentKeys(order)) {
      testResults.failed.push(`${label}: payments (id, collected_by, type) differ from ${init.actionId}`);
    }
    if (init && !sameTag(order?.tags, init.order?.tags, "BAP_TERMS")) {
      testResults.failed.push(`${label}: BAP_TERMS differ from the ones sent in ${init.actionId}`);
    }

    // Quote = last on_select quote, plus the BAP convenience fee if the BAP added one at init.
    const onSelect = await previous(isOnSelectStep);
    if (onSelect) {
      const bapFee = (init?.order?.quote?.breakup ?? []).find((b: any) => b?.title === "BAP_CONVENIENCE_FEE");
      const expectedLines = [...quoteLines(onSelect.order?.quote), ...(bapFee ? quoteLines({ breakup: [bapFee] }) : [])].sort();
      const expectedTotal = num(onSelect.order?.quote?.price?.value) + (bapFee ? num(bapFee?.price?.value) : 0);
      if (sameAmount(order?.quote?.price?.value, expectedTotal) && quoteLines(order?.quote).join(",") === expectedLines.join(",")) {
        testResults.passed.push(`${label}: quote matches ${onSelect.actionId}${bapFee ? " plus the BAP convenience fee" : ""}`);
      } else {
        testResults.failed.push(`${label}: quote (${order?.quote?.price?.value}) differs from ${onSelect.actionId} (${onSelect.order?.quote?.price?.value})${bapFee ? " plus the BAP convenience fee" : ""}`);
      }
    }

    return;
  }

  if (action === "confirm") {
    const onInit = await previous(isOnInitStep);
    checkCarryOver(order, onInit, label, testResults);
    if (!onInit) return;
    if (paymentKeys(onInit.order) !== paymentKeys(order)) {
      testResults.failed.push(`${label}: payments (id, collected_by, type) differ from ${onInit.actionId}`);
    }
    for (const code of ["BAP_TERMS", "BPP_TERMS"]) {
      if (!sameTag(order?.tags, onInit.order?.tags, code)) testResults.failed.push(`${label}: ${code} differ from ${onInit.actionId}`);
    }
    const total = onInit.order?.quote?.price?.value;
    for (const p of order?.payments ?? []) {
      if (!sameAmount(p?.params?.amount, total)) {
        testResults.failed.push(`${label}: payment ${p?.id} params.amount ${p?.params?.amount} must equal the quote total ${total}`);
      } else if (p?.params?.currency !== "INR") {
        testResults.failed.push(`${label}: payment ${p?.id} params.currency must be INR, found '${p?.params?.currency}'`);
      } else {
        testResults.passed.push(`${label}: payment ${p?.id} pays the quote total ${total} INR`);
      }
    }
    if (order?.quote && !sameQuote(order.quote, onInit.order?.quote)) {
      testResults.failed.push(`${label}: quote differs from ${onInit.actionId}`);
    }
    return;
  }

  if (action === "on_confirm") {
    const confirm = await previous(isConfirmStep);
    checkCarryOver(order, confirm, label, testResults);
    if (confirm) {
      const paid = (confirm.order?.payments ?? []).map((p: any) => `${p?.id}|${p?.params?.transaction_id}|${num(p?.params?.amount)}`).sort().join(",");
      const echoed = (order?.payments ?? []).map((p: any) => `${p?.id}|${p?.params?.transaction_id}|${num(p?.params?.amount)}`).sort().join(",");
      if (paid === echoed) testResults.passed.push(`${label}: payments echo ${confirm.actionId} (transaction_id, amount)`);
      else testResults.failed.push(`${label}: payments (id, params.transaction_id, params.amount) differ from ${confirm.actionId}`);
      for (const code of ["BAP_TERMS", "BPP_TERMS"]) {
        if (!sameTag(order?.tags, confirm.order?.tags, code)) testResults.failed.push(`${label}: ${code} differ from ${confirm.actionId}`);
      }
    }
    const onInit = await previous(isOnInitStep);
    if (onInit) {
      if (sameQuote(order?.quote, onInit.order?.quote)) testResults.passed.push(`${label}: quote unchanged from ${onInit.actionId}`);
      else testResults.failed.push(`${label}: quote differs from ${onInit.actionId}`);
    }

    const created = Date.parse(order?.created_at);
    const updated = Date.parse(order?.updated_at);
    // The workbench stamps context.timestamp before building the order, so updated_at
    // may trail it by milliseconds — only the created/updated order is checked.
    if (!isNaN(created) && !isNaN(updated)) {
      if (created > updated) testResults.failed.push(`${label}: order.created_at must not be after order.updated_at`);
      else testResults.passed.push(`${label}: order.created_at <= order.updated_at`);
    }

    // The workbench issues the ticket QR on the START stop, valid from the visit time
    // (that stop's time.timestamp, or the confirmation when none is given) for 5 days.
    const stops = (order?.fulfillments ?? []).flatMap((f: any) => f?.stops ?? []).filter((s: any) => s?.authorization);
    if (stops.length === 0) {
      testResults.failed.push(`${label}: the confirmed ticket must carry a fulfillment stop authorization`);
    }
    for (const stop of stops) {
      const validTo = Date.parse(stop.authorization?.valid_to);
      const from = Date.parse(stop?.time?.timestamp ?? order?.created_at ?? request?.context?.timestamp);
      if (isNaN(validTo) || (!isNaN(from) && validTo <= from)) {
        testResults.failed.push(`${label}: authorization valid_to '${stop.authorization?.valid_to}' must be after the visit time / confirmation`);
      } else {
        testResults.passed.push(`${label}: ticket authorization is valid until ${stop.authorization.valid_to}`);
      }
    }
  }
}
