import { Payload, TestResult } from "../../../types/payload";
import { Trv14FlowProfile } from "./flowProfiles";
import { getPreviousTrv14Order } from "./helpers";

// BPP_TERMS.SETTLEMENT_AMOUNT, as the workbench (ONDC-Official draft-TRV14-2.0.0,
// commit ca523e5f) computes it on every call that carries BPP_TERMS: from that
// call's own quote total (confirm has no quote and uses on_init's), by who
// collects the payment —
// - collected_by BPP: the BPP keeps the money and settles the buyer finder fee to
//   the BAP, so SETTLEMENT_AMOUNT = the fee (percent: total x % / 100; amount: the fee);
// - collected_by BAP: the BAP keeps the fee and settles the rest, so
//   SETTLEMENT_AMOUNT = total - the fee.
// After a cancellation or partial cancellation the total changes, and so does the
// settlement (e.g. 45 -> 0.45, 350 -> 3.50 at 1%).

const num = (v: any) => Number(v);

function tagList(tags: any[] | undefined, code: string): Record<string, string> | undefined {
  const tag = (tags ?? []).find((t: any) => t?.descriptor?.code === code);
  if (!tag) return undefined;
  const out: Record<string, string> = {};
  for (const entry of tag.list ?? []) out[entry?.descriptor?.code] = entry?.value;
  return out;
}

export async function checkTrv14Settlement(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string,
  profile: Trv14FlowProfile,
  testResults: TestResult
): Promise<void> {
  const request = element?.jsonRequest;
  const order = request?.message?.order;
  const bpp = tagList(order?.tags, "BPP_TERMS");
  if (!order || bpp?.SETTLEMENT_AMOUNT === undefined) return;
  const label = `${request?.context?.action} (${actionId})`;

  let total = order?.quote?.price?.value;
  let totalFrom = "quote";
  if (total === undefined) {
    const txnId = request?.context?.transaction_id;
    const onInit = txnId
      ? await getPreviousTrv14Order(sessionID, flowId, txnId, profile.sequence, actionId, (id) => id.startsWith("on_init"))
      : null;
    total = onInit?.order?.quote?.price?.value;
    totalFrom = onInit ? `${onInit.actionId} quote` : "";
  }
  if (total === undefined) return;

  let fee: number | undefined;
  if (bpp.BUYER_FINDER_FEES_TYPE === "percent") fee = (num(total) * num(bpp.BUYER_FINDER_FEES_PERCENTAGE)) / 100;
  if (bpp.BUYER_FINDER_FEES_TYPE === "amount") fee = num(bpp.BUYER_FINDER_FEES_AMOUNT);
  if (fee === undefined || isNaN(fee)) return;

  const collectedBy = order?.payments?.[0]?.collected_by;
  if (collectedBy !== "BPP" && collectedBy !== "BAP") return;
  const expected = collectedBy === "BPP" ? fee : num(total) - fee;
  const explanation =
    collectedBy === "BPP"
      ? `the buyer finder fee on ${totalFrom} total ${total} (BPP collects)`
      : `${totalFrom} total ${total} less the buyer finder fee (BAP collects)`;

  if (Math.abs(num(bpp.SETTLEMENT_AMOUNT) - expected) < 0.01) {
    testResults.passed.push(`${label}: BPP_TERMS.SETTLEMENT_AMOUNT ${bpp.SETTLEMENT_AMOUNT} is ${explanation}`);
  } else {
    testResults.failed.push(`${label}: BPP_TERMS.SETTLEMENT_AMOUNT ${bpp.SETTLEMENT_AMOUNT} must be ${expected.toFixed(2)}, ${explanation}`);
  }
}
