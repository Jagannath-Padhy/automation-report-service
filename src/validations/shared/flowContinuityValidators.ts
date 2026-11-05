import { Payload, TestResult } from "../../types/payload";
import { validateQuote, validateBLQuoteFormulas } from "./quoteValidations";

// pramaan-validation-parity skill: cross-call continuity checks, ported from Pramaan's
// bussinessTests/commonBussiness.js (contextBussinessTests). This is the layer report-service
// never had — checkPayload() only ever saw one payload at a time, so nothing could compare
// "this call" against "the flow so far". These checks are protocol-level (true for every
// ONDC beckn domain by definition of the beckn context object), so they're written once here
// and wired into checkPayload.ts for every domain, not duplicated per domain.
//
// `priorPayloadsInFlow` is everything already processed for this flow, in chronological order,
// BEFORE the current element. It does not include the current element itself.
//
// 2026-08-25 addition: order-trail-vs-ON_SEARCH, quote.id cross-call consistency, and quote
// arithmetic. Requested explicitly — "trail maintain honi chahiye sabhi calls ke liye from
// on_search to all calls", "quote id sabhi me match hona chahiye calculation sahi honi chahiye",
// "ho sake inko common bnao sabhi domains ke liye". Same rationale as above: written once,
// runs for every domain that has an ON_SEARCH catalog / a quote, no per-domain wiring needed.

function ctx(p: Payload | undefined | null): any {
  return p?.jsonRequest?.context;
}

function ctxMessage(p: Payload | undefined | null): any {
  return p?.jsonRequest?.message;
}

// pramaan-validation-parity skill: a message_id-uniqueness-across-the-flow check (ported from
// commonBussiness.js's messageIdsMap) was here and was removed at the user's explicit request —
// not needed for this domain. If it's ever wanted back, the pattern is the same shape as
// checkBapIdentityStability below: compare `ctx(element)?.message_id` against every prior
// payload's, using `priorPayloadsInFlow`.

/**
 * timestamp must strictly increase from one request to the next.
 * Ported from commonBussiness.js's timestamp-monotonicity check (compares against the
 * immediately preceding logged request, not the whole history).
 */
function checkTimestampMonotonicity(element: Payload, priorPayloadsInFlow: Payload[]): { passed: string[]; failed: string[] } {
  const passed: string[] = [];
  const failed: string[] = [];
  if (priorPayloadsInFlow.length === 0) return { passed, failed }; // first call in the flow, nothing to compare
  const currentTs = ctx(element)?.timestamp;
  const previousTs = ctx(priorPayloadsInFlow[priorPayloadsInFlow.length - 1])?.timestamp;
  if (!currentTs || !previousTs) return { passed, failed }; // presence is contextValidators' job
  const currentMs = Date.parse(currentTs);
  const previousMs = Date.parse(previousTs);
  if (Number.isNaN(currentMs) || Number.isNaN(previousMs)) return { passed, failed }; // format is contextValidators' job
  if (currentMs <= previousMs) {
    failed.push(`context.timestamp '${currentTs}' must be strictly after the previous call's timestamp '${previousTs}'`);
  } else {
    passed.push(`context.timestamp '${currentTs}' is strictly after the previous call's timestamp`);
  }
  return { passed, failed };
}

/**
 * bap_id/bap_uri must stay identical to what the flow's first call declared.
 * Ported from commonBussiness.js (compares against logs[0], the flow's first entry).
 */
function checkBapIdentityStability(element: Payload, priorPayloadsInFlow: Payload[]): { passed: string[]; failed: string[] } {
  const passed: string[] = [];
  const failed: string[] = [];
  if (priorPayloadsInFlow.length === 0) return { passed, failed };
  const first = ctx(priorPayloadsInFlow[0]);
  const current = ctx(element);
  if (first?.bap_id && current?.bap_id && current.bap_id !== first.bap_id) {
    failed.push(`context.bap_id changed mid-flow: was '${first.bap_id}' at the first call, now '${current.bap_id}'`);
  } else if (first?.bap_id) {
    passed.push(`context.bap_id is stable since the first call ('${first.bap_id}')`);
  }
  if (first?.bap_uri && current?.bap_uri && current.bap_uri !== first.bap_uri) {
    failed.push(`context.bap_uri changed mid-flow: was '${first.bap_uri}' at the first call, now '${current.bap_uri}'`);
  } else if (first?.bap_uri) {
    passed.push(`context.bap_uri is stable since the first call`);
  }
  return { passed, failed };
}

/**
 * bpp_id/bpp_uri must stay identical to what the flow's first on_search response declared,
 * for every call from the second one onward (search doesn't know the bpp yet).
 * Ported from commonBussiness.js (compares against logs[1], the flow's first response).
 */
function checkBppIdentityStability(element: Payload, priorPayloadsInFlow: Payload[]): { passed: string[]; failed: string[] } {
  const passed: string[] = [];
  const failed: string[] = [];
  const current = ctx(element);
  if (current?.action === 'search') return { passed, failed }; // bpp not known yet
  const firstOnSearch = priorPayloadsInFlow
    .map((p) => ctx(p))
    .find((c) => c?.action === 'on_search');
  if (!firstOnSearch) return { passed, failed }; // no on_search seen yet in this flow, nothing to compare
  if (firstOnSearch?.bpp_id && current?.bpp_id && current.bpp_id !== firstOnSearch.bpp_id) {
    failed.push(`context.bpp_id changed mid-flow: was '${firstOnSearch.bpp_id}' at the first on_search, now '${current.bpp_id}'`);
  } else if (firstOnSearch?.bpp_id) {
    passed.push(`context.bpp_id is stable since the first on_search ('${firstOnSearch.bpp_id}')`);
  }
  if (firstOnSearch?.bpp_uri && current?.bpp_uri && current.bpp_uri !== firstOnSearch.bpp_uri) {
    failed.push(`context.bpp_uri changed mid-flow: was '${firstOnSearch.bpp_uri}' at the first on_search, now '${current.bpp_uri}'`);
  } else if (firstOnSearch?.bpp_uri) {
    passed.push(`context.bpp_uri is stable since the first on_search`);
  }
  return { passed, failed };
}

/**
 * Everything a `message.order` references (provider.id, items[].id, fulfillments[].id) must
 * trace back to what ON_SEARCH actually offered for this flow. This generalizes the check that
 * previously existed only for FIS12's `select` action (`compareSelectVsOnSearch` in
 * actionDataService.ts, called from validations/ONDC:FIS12/2.2.1/select.ts) — which also had a
 * bug: it treated `onSearch.providers` as a single object when building the item/fulfillment
 * universe (`onSearch?.providers?.items`), even though it correctly handled `providers` as an
 * array for the provider-id check two lines above. On a real multi-provider catalog (`providers`
 * is always an array per the beckn schema), that made `onSearchItemIds`/`onSearchFulfillmentIds`
 * come back empty, so every real select would report ALL its items/fulfillments as "missing in
 * ON_SEARCH" — a false failure, not a missed check. Fixed here by building a proper
 * per-provider Map. `select.ts`'s call to the old buggy helper was removed in favor of this.
 *
 * Runs for every action that carries a `message.order` (select, init, confirm, update, and
 * their on_* echoes) and every domain — ON_SEARCH itself and `search` (which has
 * `message.intent`, not `message.order`) are naturally exempt since neither has an order to
 * check yet.
 */
function extractOnSearchOfferings(onSearchPayload: Payload | undefined): {
  providerIds: Set<string>;
  itemIdsByProvider: Map<string, Set<string>>;
  fulfillmentIdsByProvider: Map<string, Set<string>>;
  allItemIds: Set<string>;
  allFulfillmentIds: Set<string>;
} {
  const result = {
    providerIds: new Set<string>(),
    itemIdsByProvider: new Map<string, Set<string>>(),
    fulfillmentIdsByProvider: new Map<string, Set<string>>(),
    allItemIds: new Set<string>(),
    allFulfillmentIds: new Set<string>(),
  };
  const providers = ctxMessage(onSearchPayload)?.catalog?.providers;
  if (!Array.isArray(providers)) return result;
  for (const p of providers) {
    if (!p?.id) continue;
    result.providerIds.add(p.id);
    const itemIds = new Set<string>((p.items || []).map((it: any) => it?.id).filter(Boolean));
    const fulfillmentIds = new Set<string>((p.fulfillments || []).map((f: any) => f?.id).filter(Boolean));
    result.itemIdsByProvider.set(p.id, itemIds);
    result.fulfillmentIdsByProvider.set(p.id, fulfillmentIds);
    itemIds.forEach((id) => result.allItemIds.add(id));
    fulfillmentIds.forEach((id) => result.allFulfillmentIds.add(id));
  }
  return result;
}

function checkOrderTrailAgainstOnSearch(element: Payload, priorPayloadsInFlow: Payload[]): { passed: string[]; failed: string[] } {
  const passed: string[] = [];
  const failed: string[] = [];
  const order = ctxMessage(element)?.order;
  if (!order) return { passed, failed }; // search/on_search/status calls have no order to trail-check

  // pramaan-validation-parity skill: use the LATEST on_search before this call, not the first.
  // Fixed 2026-08-25 after a real false failure: a multi-round search flow (e.g. a second
  // search/on_search that reveals child items only after a parent item is picked) means an
  // earlier on_search's catalog can be missing items a later one actually offered — `.find()`
  // was grabbing the first on_search in the flow, so a genuinely-offered child item id (present
  // in the last on_search) was reported as "not offered in ON_SEARCH". priorPayloadsInFlow is
  // chronological, so the last match in a filter is the most recent on_search.
  const onSearchPayloadsSoFar = priorPayloadsInFlow.filter((p) => ctx(p)?.action === 'on_search');
  const onSearchPayload = onSearchPayloadsSoFar[onSearchPayloadsSoFar.length - 1];
  if (!onSearchPayload) return { passed, failed }; // no on_search seen yet in this flow

  const offerings = extractOnSearchOfferings(onSearchPayload);
  if (offerings.providerIds.size === 0) return { passed, failed }; // on_search had nothing to compare against

  const providerId = order?.provider?.id;
  if (providerId && offerings.providerIds.has(providerId)) {
    passed.push(`order.provider.id '${providerId}' was offered in ON_SEARCH`);
  }

  // Scope items/fulfillments to the specific provider when we know it; otherwise fall back to
  // the union across every provider ON_SEARCH offered (still catches an id that isn't in the
  // catalog anywhere, even before we're sure which provider this call is about).
  const itemUniverse = (providerId && offerings.itemIdsByProvider.get(providerId)) || offerings.allItemIds;
  const itemIds: string[] = (order.items || []).map((it: any) => it?.id).filter(Boolean);
  if (itemIds.length) {
    const missing = itemIds.filter((id: string) => !itemUniverse.has(id));
    if (missing.length === 0) {
      passed.push(`All order.items (${itemIds.length}) trace back to ON_SEARCH`);
    }
  }

  const fulfillmentUniverse = (providerId && offerings.fulfillmentIdsByProvider.get(providerId)) || offerings.allFulfillmentIds;
  const fulfillmentIds: string[] = (order.fulfillments || []).map((f: any) => f?.id).filter(Boolean);
  if (fulfillmentIds.length) {
    const missing = fulfillmentIds.filter((id: string) => !fulfillmentUniverse.has(id));
    if (missing.length === 0) {
      passed.push(`All order.fulfillments (${fulfillmentIds.length}) trace back to ON_SEARCH`);
    }
  }

  return { passed, failed };
}

/**
 * quote.id must stay the same across every call in the flow that carries one, once whichever
 * BPP response first mints it (typically on_select). Assumption flagged rather than silently
 * assumed: if some domain legitimately re-quotes (a new quote.id) between steps, gate this the
 * same way flowId-based checks are gated elsewhere in this codebase, rather than deleting it.
 *
 * pramaan-validation-parity skill: disabled 2026-08-25 at the user's explicit request — "quote
 * ke liye bas 'Quote price matches breakup total' rakhte hai, baaki sabhi comment out karo."
 * Kept defined (not deleted) and simply not called from checkFlowContinuity's `checks` array
 * below — re-enable by adding `checkQuoteIdConsistency` back to that array.
 */
function checkQuoteIdConsistency(element: Payload, priorPayloadsInFlow: Payload[]): { passed: string[]; failed: string[] } {
  const passed: string[] = [];
  const failed: string[] = [];
  const currentQuoteId = ctxMessage(element)?.order?.quote?.id;
  if (!currentQuoteId) return { passed, failed };

  const priorWithQuote = priorPayloadsInFlow.find((p) => ctxMessage(p)?.order?.quote?.id);
  if (!priorWithQuote) return { passed, failed }; // first call in this flow that carries a quote

  const priorQuoteId = ctxMessage(priorWithQuote)?.order?.quote?.id;
  const priorAction = ctx(priorWithQuote)?.action;
  if (currentQuoteId === priorQuoteId) {
    passed.push(`quote.id is stable since ${priorAction} ('${currentQuoteId}')`);
  } else {
    failed.push(`quote.id changed since ${priorAction}: was '${priorQuoteId}', now '${currentQuoteId}'`);
  }
  return { passed, failed };
}

/**
 * Quote arithmetic — reuses the existing validateQuote() from quoteValidations.ts rather than
 * re-implementing it, and runs universally whenever ANY payload in ANY domain carries a
 * message.order.quote (this is what makes it "common for all domains, not just FIS12").
 *
 * pramaan-validation-parity skill: 2026-08-25, at the user's explicit request, scoped down to
 * ONLY `validateTotalMatch` ("Quote price matches breakup total" — breakup sums to price.value).
 * `validateDecimalPlaces` (≤2 decimal places, on the quote total and every breakup line) is
 * turned off, not deleted — flip it back to `true` here to re-enable it; nothing else needs to
 * change, `validateQuote()` itself is untouched.
 */
function checkQuoteArithmetic(element: Payload): { passed: string[]; failed: string[] } {
  const quote = ctxMessage(element)?.order?.quote;
  if (!quote) return { passed: [], failed: [] };
  const local: TestResult = { response: {}, passed: [], failed: [] };
  validateQuote(quote, local, { validateDecimalPlaces: false, validateTotalMatch: true });
  // FIS12 Business Loan additionally follows the loan-quote formulas (total and net disbursed).
  if (ctx(element)?.domain === "ONDC:FIS12:BL") validateBLQuoteFormulas(quote, local);
  return { passed: local.passed, failed: local.failed };
}

/**
 * Runs all universal cross-call continuity checks for one payload against everything already
 * processed for its flow. Called from checkPayload.ts right after the existing
 * runValidations(contextValidators(), ...) call — every domain gets this for free.
 */
export function checkFlowContinuity(element: Payload, priorPayloadsInFlow: Payload[]): TestResult {
  const checks = [
    checkTimestampMonotonicity,
    checkBapIdentityStability,
    checkBppIdentityStability,
    checkOrderTrailAgainstOnSearch,
    // pramaan-validation-parity skill: checkQuoteIdConsistency disabled 2026-08-25 at the
    // user's explicit request (see its doc comment above) — quote checks trimmed down to just
    // the breakup-total-match, common across all domains. Add it back here to re-enable.
    (el: Payload, _prior: Payload[]) => checkQuoteArithmetic(el),
  ];
  const passed: string[] = [];
  const failed: string[] = [];
  for (const check of checks) {
    const result = check(element, priorPayloadsInFlow);
    passed.push(...result.passed);
    failed.push(...result.failed);
  }
  return { response: {}, passed, failed };
}
