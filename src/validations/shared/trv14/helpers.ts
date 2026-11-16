import { Payload, TestResult } from "../../../types/payload";
import { saveActionData, getActionData } from "../../../services/actionDataService";
import { loadSaveSpec } from "../../../utils/specLoader";
import { fetchData, saveData } from "../../../utils/redisUtils";
import { TRV14_VERSION } from "./constants";

/**
 * Saves the payload's save-spec fields under its workbench action_id, on top of
 * the per-action copy saveFromElement already keeps. TRV14 repeats actions within
 * one flow (three on_search pages, two select rounds, soft and confirm
 * cancel/update), so the per-action copy alone would be overwritten by the second
 * call of the same action.
 */
export async function saveTrv14ActionData(
  element: Payload,
  sessionID: string,
  flowId: string
): Promise<void> {
  try {
    const payload = element?.jsonRequest;
    const context = payload?.context;
    const transactionId: string | undefined = context?.transaction_id;
    const action: string | undefined = context?.action;
    const actionId = element?.action_id;
    if (!transactionId || !action || !actionId) return;
    const spec = loadSaveSpec("TRV14", context?.version || TRV14_VERSION, action);
    await saveActionData(sessionID, flowId, transactionId, actionId, payload, spec);
  } catch (_) {}
}

/**
 * Saves the form URLs an on_select carries (order.xinput for the order-level form,
 * items[].xinput for item-level forms) so the HTML_FORM step that follows can find
 * them — same Redis key FIS12/FIS14 use, read by shared/formValidations.ts.
 */
export async function saveTrv14FormUrls(element: Payload, sessionID: string): Promise<void> {
  try {
    const txnId = element?.jsonRequest?.context?.transaction_id as string | undefined;
    const order = element?.jsonRequest?.message?.order;
    const urls: string[] = [
      order?.xinput?.form?.url,
      ...(Array.isArray(order?.items) ? order.items.map((i: any) => i?.xinput?.form?.url) : []),
    ].filter((u): u is string => typeof u === "string" && u.length > 0);
    if (txnId && urls.length > 0) {
      const existing = await fetchData(sessionID, txnId, "formUrls");
      const merged = Array.from(new Set([...(existing?.urls ?? []), ...urls]));
      await saveData(sessionID, txnId, "formUrls", { urls: merged });
    }
  } catch (_) {}
}

/**
 * The order saved for the latest step before `actionId` in the flow whose action_id
 * matches `isMatch` (e.g. the select a given on_select answers). Steps are saved in
 * flow order, so only earlier steps can be found.
 */
export async function getPreviousTrv14Order(
  sessionID: string,
  flowId: string,
  transactionId: string,
  sequence: string[],
  actionId: string,
  isMatch: (stepActionId: string) => boolean
): Promise<{ actionId: string; order: any } | null> {
  const position = sequence.indexOf(actionId);
  for (let i = position - 1; i >= 0; i--) {
    if (!isMatch(sequence[i])) continue;
    const saved = await getTrv14ActionData(sessionID, flowId, transactionId, sequence[i]);
    if (saved?.order) return { actionId: sequence[i], order: saved.order };
  }
  return null;
}

export async function getTrv14ActionData(
  sessionID: string,
  flowId: string,
  transactionId: string,
  actionId: string
): Promise<Record<string, any> | null> {
  return getActionData(sessionID, flowId, transactionId, actionId);
}

/** Fulfillment shape that must not change after on_confirm: id, type and stop types. */
export function trv14FulfillmentShape(order: any): string {
  return (order?.fulfillments ?? [])
    .map((f: any) => `${f?.id}|${f?.type}|${(f?.stops ?? []).map((s: any) => s?.type).join(">")}`)
    .sort()
    .join(",");
}

/** Every quote amount must be in the quote's own currency. */
export function checkTrv14QuoteCurrency(jsonRequest: any, testResults: TestResult): void {
  const quote = jsonRequest?.message?.order?.quote;
  if (!quote) return;
  const action = jsonRequest?.context?.action;
  const currency = quote?.price?.currency;
  const others = (quote?.breakup ?? [])
    .flatMap((b: any) => [b?.price?.currency, b?.item?.price?.currency])
    .filter((c: any) => c !== undefined && c !== currency);
  if (others.length === 0) testResults.passed.push(`${action}: every quote amount is in ${currency}`);
  else testResults.failed.push(`${action}: quote breakup mixes currencies (${[...new Set(others)].join(", ")}) with quote.price.currency ${currency}`);
}
