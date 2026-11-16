import { TestResult } from "../../../types/payload";
import { failureGate, itemLabel, providerLabel, tagGroupsByCode, tagValue } from "./onSearchB2BChecks";
import { validateGpsFormat, ISO8601_DURATION } from "./commonChecks";

// Business checks for select / on_select, calibrated against real payloads from
// automation-specifications (Order_to_confirm_to_fulfillment__Prepaid_ and
// Out_of_Stock_Error_code_ flow configs) and cross-referenced against
// tools/workflow-orchestrator's select_validate.js / on_select_validate.js.
//
// IMPORTANT, confirmed against the real example payloads — do not "fix" these
// back without re-checking the payloads first:
//  - order.provider has NO descriptor in the select REQUEST (id + locations only).
//    select_validate.js demands provider.descriptor.{name,code,short_desc}, but
//    enforcing that literally fails the spec's own reference payload, so
//    descriptor is NOT required here. on_select's response DOES echo a
//    descriptor — that's a response-side convention, not a request one.
//  - item.quantity.count in select/on_select is a plain NUMBER (order
//    quantities), unlike on_search's catalog quantities, which are STRINGS.
//  - The out-of-stock signal lives at the callback's own `error` field
//    (jsonRequest.error), not the ACK/NACK envelope — confirmed by both
//    on_select_out_of_stock_validate.js and the real OOS example payload
//    (error.code "40002"), matching the doc's own error-code table.

const OUT_OF_STOCK_ERROR_CODE = "40002";

/**
 * The error codes the API contract documents for this leg. Both appear as full `on_select`
 * examples: `40002` in "/on_select (Out of stock)" and `50009` in "Invalid Customer ID
 * (Error)" — the latter as a bare `{context, error}` response with no `message.order`.
 *
 * Used to NAME a code in the report, never to reject an unlisted one: the contract does not
 * declare the list exhaustive.
 */
const DOCUMENTED_ERROR_CODES: Record<string, string> = {
  [OUT_OF_STOCK_ERROR_CODE]: "item quantity unavailable",
  "50009": "invalid customer id — retailer not found in distributor system",
};

function reportDuplicates(ids: any[], label: string, result: TestResult): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) {
    if (id === undefined || id === null) continue;
    const key = String(id);
    if (seen.has(key)) dupes.add(key);
    seen.add(key);
  }
  for (const dupe of dupes) {
    result.failed.push(`select: duplicate ${label} '${dupe}'`);
  }
  return [...dupes];
}

// ---------------------------------------------------------------------------
// select (request)
// ---------------------------------------------------------------------------

/**
 * `order.provider` — id **and** descriptor. Shared by `select` and `on_select`; `label`
 * says which.
 *
 * THE DESCRIPTOR REQUIREMENT CORRECTS AN EARLIER MISCALIBRATION. This module's header used
 * to say "order.provider has NO descriptor in the select REQUEST (id + locations only) …
 * enforcing that literally fails the spec's own reference payload". That was measured
 * against the flows' static `examples[].payload`, which omit the descriptor in five of ten
 * flows — but a static example is NOT what a live session sends. Every one of the ten
 * `select` mock `generate` scripts builds the descriptor from the live catalog:
 *
 *     const descriptor = {
 *       name:       catalogProvider.descriptor?.name       || inputs.provider_name,
 *       code:       catalogProvider.descriptor?.code       || inputs.provider_code,
 *       short_desc: catalogProvider.descriptor?.short_desc || inputs.provider_short_desc };
 *     if (Object.keys(descriptor).length > 0) provider.descriptor = descriptor;
 *
 * and every `on_select` mock merges the saved provider, which by then carries it. So in a
 * live run the descriptor is present on all ten `select` and all ten `on_select` legs —
 * confirmed by the user running the COD flow — and the contract mandates it in both
 * sections. See docs/RETeB2B-select-contract-audit.md §5.2 and §11.
 *
 * `name` is required. `short_desc` is only checked for emptiness when sent: the mock drops
 * any key the seller's catalog does not supply, so a catalog without a `short_desc` would
 * legitimately omit it even though the contract names it.
 */
export function validateSelectProvider(
  order: any,
  result: TestResult,
  label: string = "select"
): void {
  // Skips entirely when there is no `order` — the same carve-out
  // `validateCustomerIdentification` makes, and for the same reason: an `on_select` that
  // refuses with a bare `{context, error}` (the contract's 50009 Invalid Customer ID shape)
  // has nowhere for a provider to live. Without this, requiring the descriptor introduced a
  // false failure on the contract's own error example.
  if (!order || typeof order !== "object") return;

  if (!order?.provider?.id || !String(order.provider.id).trim()) {
    result.failed.push(`${label}: order.provider.id is required`);
    return;
  }

  const cleanRun = failureGate(result);
  const descriptor = order.provider.descriptor;

  if (!descriptor || typeof descriptor !== "object") {
    result.failed.push(
      `${label}: order.provider.descriptor is required — it must carry the provider's name as listed in the on_search catalog`
    );
  } else {
    if (!descriptor.name || !String(descriptor.name).trim()) {
      result.failed.push(`${label}: order.provider.descriptor.name is required`);
    }
    if (descriptor.short_desc !== undefined && !String(descriptor.short_desc).trim()) {
      result.failed.push(`${label}: order.provider.descriptor.short_desc must not be empty when sent`);
    }
  }

  if (cleanRun()) {
    result.passed.push(
      `${label}: order.provider.id '${order.provider.id}' is present with a named descriptor ('${descriptor?.name}')`
    );
  }
}

export function validateSelectItems(order: any, result: TestResult): void {
  const items = order?.items;
  if (!Array.isArray(items) || items.length === 0) {
    result.failed.push("select: order.items must be a non-empty array");
    return;
  }

  const cleanRun = failureGate(result);
  reportDuplicates(items.map((i: any) => i?.id), "item id", result);

  for (const item of items) {
    if (!item?.id || !String(item.id).trim()) {
      result.failed.push("select: an item is missing its id");
      continue;
    }
    const count = item?.quantity?.count;
    if (count === undefined || !Number.isInteger(count) || count <= 0) {
      result.failed.push(
        `${itemLabel(item)}: select: quantity.count '${count}' must be a positive integer (select quantities are numbers, not the catalog's quantity strings)`
      );
    }
  }

  if (cleanRun()) {
    result.passed.push(`select: all ${items.length} item(s) have a valid id and quantity.count`);
  }
}

/** Self-contained — item.location_id must resolve within THIS payload's own provider.locations, when both are given. */
export function validateSelectLocationRefs(order: any, result: TestResult): void {
  const locationIds = new Set((order?.provider?.locations || []).map((l: any) => l?.id).filter(Boolean));
  if (locationIds.size === 0) return;

  const cleanRun = failureGate(result);
  let referencing = 0;

  for (const item of order?.items || []) {
    if (item?.location_id === undefined || item?.location_id === null) continue;
    referencing++;
    if (!locationIds.has(item.location_id)) {
      result.failed.push(
        `select: ${itemLabel(item)} references location_id '${item.location_id}' which is not declared in order.provider.locations`
      );
    }
  }

  if (referencing > 0 && cleanRun()) {
    result.passed.push(`select: all ${referencing} item location_id reference(s) resolve to a declared location`);
  }
}

// REMOVED 2026-10-12: `validateSelectFulfillmentRefs`, which required each
// `items[].fulfillment_id` to resolve within this payload's own `order.fulfillments`.
//
// Two independent reasons, either sufficient:
//  - the API contract's /select section never names `items[].fulfillment_id` at all, and the
//    spec team confirmed it is NOT mandatory (may be sent, need not be validated);
//  - it was a permanent no-op regardless. A `select` request's fulfillments carry no `id` —
//    the seller assigns those at `on_select` — so `fulfillmentIds.size` was always 0 and the
//    function returned before checking anything, in all ten reference payloads.
//
// The `on_select` side is deliberately KEPT: `validateOnSelectFulfillmentRefs` has real
// fulfillment ids to resolve against, and `validateOnSelectItemsAgainstSelect`'s
// `location_id` clause catches an on_select echoing a different location than select sent.
// Neither *requires* the field, so neither conflicts with "not mandatory".
// See docs/RETeB2B-select-contract-audit.md §5.1 and §11.

/**
 * `order.offers`, when the buyer chose any.
 *
 * NOT required, deliberately — see §11 of the contract audit. The spec team's answer was
 * "mandatory only for with-offers flows", but that cannot be enforced: both `with_offers`
 * mocks drive offers from retailer input and delete the key when nothing is selected
 * (`if (validOffers.length > 0) order.offers = …; else delete order.offers`), and
 * `with_offers(cod)`'s own reference select sends none (the live COD mock does send
 * `[discp10]`). A retailer who picks no offer in a with-offers flow legitimately sends no
 * offers, so a hard requirement would false-fail both the fixture and that real case.
 *
 * The with-offers obligation lives one leg later, on the seller: at least one applied
 * offer in the on_select quote, enforced by offerChecks.validateOfferLinesPresent.
 *
 * Shape only, therefore: each declared offer must carry a non-empty `id`. Whether those ids
 * exist in the catalog is already checked one leg later by
 * orderFormationChecks.validateOffersAgainstCatalog.
 */
export function validateSelectOffers(order: any, result: TestResult): void {
  const offers = order?.offers;
  if (offers === undefined || offers === null) return;

  if (!Array.isArray(offers)) {
    result.failed.push("select: order.offers must be an array when present");
    return;
  }
  if (offers.length === 0) {
    result.failed.push("select: order.offers must not be an empty array — omit the key instead");
    return;
  }

  const cleanRun = failureGate(result);

  offers.forEach((offer: any, index: number) => {
    if (!offer?.id || !String(offer.id).trim()) {
      result.failed.push(`select: order.offers[${index}] is missing its id`);
    }
  });

  if (cleanRun()) {
    result.passed.push(
      `select: all ${offers.length} chosen offer(s) declare an id (${offers.map((o: any) => o.id).join(", ")})`
    );
  }
}

/** The delivery-end GPS/address the buyer is selecting against. */
export function validateSelectFulfillmentLocation(order: any, result: TestResult): void {
  const fulfillments = order?.fulfillments;
  if (!Array.isArray(fulfillments) || fulfillments.length === 0) return;

  const cleanRun = failureGate(result);
  let checked = 0;

  for (const fulfillment of fulfillments) {
    const location = fulfillment?.end?.location;
    if (!location) continue;
    checked++;

    if (location.gps) {
      validateGpsFormat(location.gps, "select.fulfillment.end.location", result);
    }
    if (!location.address?.area_code || !String(location.address.area_code).trim()) {
      result.failed.push("select: fulfillment.end.location.address.area_code is required when a delivery location is given");
    }
  }

  if (checked > 0 && cleanRun()) {
    result.passed.push(`select: all ${checked} fulfillment delivery location(s) have valid gps/area_code`);
  }
}

/**
 * The B2B business-buyer identification attached to the fulfillment.
 * `fulfillment.customer` (with an `id`) is **required on both select and
 * on_select** — every fulfillment must name the retailer the order is for. All
 * four reference payloads carry it on every fulfillment.
 *
 * `organization.descriptor.name` is only required on the **request** side:
 * - select (both the plain and OOS examples) sends the full organization
 *   (`descriptor.name`, `address`, `city`, `state`).
 * - the success-case on_select echoes a *trimmed* organization — only
 *   `city.code`, no descriptor — while the OOS on_select echoes the full one.
 *   The two response examples disagree, so the seller echo is not held to it.
 *
 * Skips entirely when there is no `order` to inspect (e.g. a bare
 * `{context, error}` response), since there is then nowhere for a customer to live.
 */
export function validateCustomerIdentification(
  order: any,
  label: string,
  result: TestResult,
  opts: { requireOrganizationName?: boolean } = {}
): void {
  if (!order || typeof order !== "object") return;

  const cleanRun = failureGate(result);
  const fulfillments = order?.fulfillments;

  if (!Array.isArray(fulfillments) || fulfillments.length === 0) {
    result.failed.push(
      `${label}: order.fulfillments must be a non-empty array — fulfillment.customer is required to identify the business buyer`
    );
    return;
  }

  for (const fulfillment of fulfillments) {
    const fulfillmentRef = fulfillment?.id ? `fulfillment ${fulfillment.id}` : "fulfillment";
    const customer = fulfillment?.customer;

    if (!customer || typeof customer !== "object") {
      result.failed.push(`${label}: ${fulfillmentRef} is missing its required customer object`);
      continue;
    }
    if (!customer.id || !String(customer.id).trim()) {
      result.failed.push(`${label}: ${fulfillmentRef} customer.id is required`);
    }
    if (opts.requireOrganizationName && !customer.organization?.descriptor?.name) {
      result.failed.push(
        `${label}: ${fulfillmentRef} customer.organization.descriptor.name is required`
      );
    }
  }

  if (cleanRun()) {
    const detail = opts.requireOrganizationName ? "customer.id + organization name" : "customer.id";
    result.passed.push(
      `${label}: all ${fulfillments.length} fulfillment(s) identify the business buyer (${detail})`
    );
  }
}

/**
 * Cross-call: context.city must be the same in on_search and the action being checked — a
 * buyer cannot discover a catalog in one city and then order against it in another.
 * Skips silently when no on_search city was captured for this flow, which is the
 * normal case for the order flows that have no on_search step at all (only the
 * `_with_offers(...)` variants actually begin with search/on_search).
 *
 * `label` defaults to "select" for the original caller. `init` reuses this verbatim —
 * log-validation-utility's Init/init.ts:59-61 has the same rule, and `std:060` holds at
 * both `select` and `init` in all nine reference flows.
 *
 * `*` IS NOT A CITY. Both `_with_offers(...)` flows — the only two with an on_search step —
 * send `context.city: "*"` on the on_search leg, the ONDC wildcard for a broadcast catalog
 * that is not scoped to one city. Comparing it literally reported
 * "city code mismatch between on_search ('*') and select ('std:060')" on every run of
 * those two flows, which was a false failure: a wildcard constrains nothing, so there is
 * nothing to disagree with. (The prior art compares against `search` instead, which in
 * these flows carries `std:080` against a `std:060` order — so porting that literally
 * would have failed both flows too.)
 */
export function validateCityConsistency(
  context: any,
  onSearchData: Record<string, any> | null,
  result: TestResult,
  label: string = "select"
): void {
  const onSearchCity = onSearchData?.city;
  const currentCity = context?.city;
  if (!onSearchCity || !currentCity) return;
  if (String(onSearchCity).trim() === "*" || String(currentCity).trim() === "*") return;

  if (String(onSearchCity) !== String(currentCity)) {
    result.failed.push(
      `${label}: city code mismatch between on_search ('${onSearchCity}') and ${label} ('${currentCity}')`
    );
    return;
  }

  result.passed.push(`${label}: context.city '${currentCity}' matches on_search`);
}

/**
 * Cross-call: the buyer's selected items, priced from the on_search catalog, must
 * meet the provider's order_value.min_value (advertised as a provider tag in
 * on_search — see onSearchB2BChecks.validateOrderValueTag). Skips silently when
 * either side of the comparison isn't available — this check only adds value
 * when it has real data to compare, never by penalizing missing cross-call state.
 */
export function validateMinimumOrderValue(order: any, onSearchData: Record<string, any> | null, result: TestResult): void {
  const stored = onSearchData?.providers;
  const providers: any[] = Array.isArray(stored) ? stored : stored ? [stored] : [];
  const provider = providers.find((p: any) => p?.id === order?.provider?.id);
  if (!provider) return;

  const minValueTag = tagGroupsByCode(provider.tags, "order_value")[0];
  const minValue = minValueTag ? parseFloat(tagValue(minValueTag.list, "min_value") ?? "") : NaN;
  if (Number.isNaN(minValue)) return;

  const catalogPriceById = new Map<string, number>();
  for (const item of provider.items || []) {
    const price = parseFloat(item?.price?.value ?? "");
    if (item?.id && !Number.isNaN(price)) catalogPriceById.set(item.id, price);
  }

  let total = 0;
  let priced = 0;
  for (const item of order?.items || []) {
    const price = catalogPriceById.get(item?.id);
    const count = item?.quantity?.count;
    if (price === undefined || !Number.isInteger(count)) continue;
    total += price * count;
    priced++;
  }
  if (priced === 0) return;

  if (total < minValue) {
    result.failed.push(
      `select: selected order value (${total.toFixed(2)}) is below ${providerLabel(provider)}'s order_value.min_value (${minValue})`
    );
  } else {
    result.passed.push(
      `select: selected order value (${total.toFixed(2)}) meets ${providerLabel(provider)}'s order_value.min_value (${minValue})`
    );
  }
}

/**
 * Cross-call: the RETRY select after an out-of-stock rejection must respect what
 * the seller said it could actually supply. For every item the previous on_select
 * flagged with error 40002, this select must either drop the item or re-request
 * `quantity.count <= available`; an item reported with 0 available must not be
 * re-selected at all.
 *
 * This is the whole point of the Out_of_Stock(Error_code) flow — proving the buyer
 * app reacts to the rejection rather than re-sending the same basket. Nothing
 * checked it before: both of that flow's select legs (`select0` and `select`) run
 * through the same select.ts, so a blind retry passed clean. There is no B2C prior
 * art to port — log-validation-utility's Select/select.ts has no OOS-aware rule.
 *
 * SELF-GATING, deliberately — no flow-id or action-id match. `saveFromElement`
 * keys stored data on `context.action`, not `action_id` (src/utils/specLoader.ts:27),
 * and each action saves at the END of its own validation. So:
 *  - during the single select of a normal flow, nothing is stored under `on_select`
 *    yet and this is a silent no-op;
 *  - during the retry select, `on_select` holds `on_select_out_of_stock`'s data,
 *    because that leg's context.action is plain `on_select` (the second on_select
 *    overwrites it only afterwards).
 * That survives the spec renaming `select0`/`on_select_out_of_stock`, which a
 * hardcoded action-id match would not.
 *
 * Calibration note: the spec's own second-select example re-selects I1 at count 1
 * after the rejection reported 0 available, so it legitimately fails this check.
 * The static examples were written without running the flow's mock (select0's
 * example says count 1 where its own template says 45); the live mock sets
 * available = requested - 1 and builds the retry from user-entered quantities, so a
 * real 12 -> 11 session has a compliant retry at <= 11.
 */
export function validateRetrySelectAgainstOutOfStock(
  order: any,
  onSelectData: Record<string, any> | null,
  result: TestResult
): void {
  if (!onSelectData) return;

  // Only the documented out-of-stock code constrains the retry. Any other error
  // code is a different conversation and not this rule's business.
  const error = onSelectData.error;
  if (error?.code !== OUT_OF_STOCK_ERROR_CODE) return;

  // error.message is a JSON *string* holding [{item_id, error, available_count?}].
  // Its shape is the on_select leg's responsibility (see validateMandatoryOutOfStockError);
  // skipping silently here keeps one defect from being reported on two legs.
  let reported: any;
  try {
    reported = JSON.parse(String(error.message));
  } catch (_) {
    return;
  }
  if (!Array.isArray(reported)) return;

  // `available_count` is an eB2B mock extra — the canonical ONDC shape is just
  // {item_id, error} — so it is optional and the breakup is the fallback below.
  const constrained = new Map<string, number | null>();
  for (const entry of reported) {
    const itemId = entry?.item_id;
    if (!itemId) continue;
    const count = Number(entry?.available_count);
    constrained.set(
      String(itemId),
      Number.isInteger(count) && count >= 0 ? count : null
    );
  }
  if (constrained.size === 0) return;

  // Fill the unknowns from the quote the rejection carried. Breakup availability is
  // a STRING ("0", "99"), unlike select's numeric item quantities.
  const breakup: any[] = Array.isArray(onSelectData.quote_breakup)
    ? onSelectData.quote_breakup
    : onSelectData.quote_breakup
    ? [onSelectData.quote_breakup]
    : [];
  for (const line of breakup) {
    const itemId = line?.["@ondc/org/item_id"];
    if (!itemId || constrained.get(String(itemId)) !== null) continue;
    const available = parseInt(String(line?.item?.quantity?.available?.count), 10);
    const quoted = parseInt(String(line?.["@ondc/org/item_quantity"]?.count), 10);
    const resolved = Number.isInteger(available)
      ? available
      : Number.isInteger(quoted)
      ? quoted
      : null;
    if (resolved !== null && resolved >= 0) constrained.set(String(itemId), resolved);
  }

  const cleanRun = failureGate(result);
  const respected: string[] = [];
  let dropped = 0;

  for (const [itemId, available] of constrained) {
    const item = (order?.items || []).find((i: any) => String(i?.id) === itemId);
    if (!item) {
      dropped++;
      continue;
    }

    const requested = item?.quantity?.count;

    if (available === null) {
      result.failed.push(
        `select: item ${itemId} was reported out of stock in the previous on_select, which gave no available quantity — it must not be re-selected`
      );
      continue;
    }
    if (available === 0) {
      result.failed.push(
        `select: item ${itemId} was reported out of stock in the previous on_select (0 available) and must not be re-selected`
      );
      continue;
    }
    if (Number.isInteger(requested) && requested > available) {
      result.failed.push(
        `select: item ${itemId} is re-selected with quantity.count ${requested}, but the previous on_select reported only ${available} available`
      );
      continue;
    }
    respected.push(`${itemId}: ${requested} of ${available}`);
  }

  if (cleanRun()) {
    const detail = respected.length ? ` (${respected.join(", ")})` : "";
    result.passed.push(
      `select: all ${constrained.size} previously out-of-stock item(s) respected — ${dropped} dropped, ${respected.length} re-selected within the available quantity${detail}`
    );
  }
}

// ---------------------------------------------------------------------------
// on_select (response)
// ---------------------------------------------------------------------------

/**
 * The out-of-stock / item-unavailable signal lives at the callback's own `error`
 * field (sibling of context/message), not the ACK/NACK envelope — confirmed
 * against on_select_out_of_stock_validate.js and the real OOS example payload.
 */
export function hasErrorResponse(jsonRequestError: any): boolean {
  return Boolean(jsonRequestError && Object.keys(jsonRequestError).length > 0);
}

/**
 * The generic error-response check for this leg: whatever the seller refuses with, the
 * refusal itself must be well-formed.
 *
 * RENAMED from `validateOutOfStockError`, and it was **dead code** until 2026-10-12 —
 * exported but never called, so an error on any leg other than the Out_of_Stock flow's
 * rejection was ignored entirely. Running `OnSelect` against the contract's own
 * `Invalid Customer ID` payload produced one pass ("Validated on_select", the shared
 * factory's default) and no engagement with the error at all. See
 * docs/RETeB2B-select-contract-audit.md §3.2.
 *
 * The old name also asserted that out-of-stock is the only error case for this leg, which
 * the contract contradicts: it documents **two** codes, `40002` (item quantity unavailable)
 * and `50009` (invalid customer id), the second as a `{context, error}` response with no
 * `message.order` at all.
 *
 * `type`, `code` and `message` are all required — both documented error examples carry all
 * three, as does the one reference payload that returns an error. An unrecognised CODE is
 * reported rather than rejected: the contract's list is not declared exhaustive, so a new
 * code is news, not a defect.
 */
export function validateErrorResponse(error: any, result: TestResult): void {
  if (!hasErrorResponse(error)) return;

  const cleanRun = failureGate(result);

  for (const field of ["type", "code", "message"] as const) {
    if (!error[field] || !String(error[field]).trim()) {
      result.failed.push(`on_select: error response must include a non-empty error.${field}`);
    }
  }

  if (cleanRun()) {
    const known = DOCUMENTED_ERROR_CODES[String(error.code)];
    result.passed.push(
      known
        ? `on_select: well-formed error response (type '${error.type}', code '${error.code}' — ${known})`
        : `on_select: well-formed error response (type '${error.type}', code '${error.code}' is not a standard code for this call (known: ${Object.entries(DOCUMENTED_ERROR_CODES).map(([c, d]) => `${c} ${d}`).join("; ")}); accepted)`
    );
  }
}

/**
 * The Out_of_Stock(Error_code) flow's FIRST on_select exists purely to prove the
 * seller rejects an unavailable quantity — so here the error is MANDATORY, and
 * the code must be the documented out-of-stock one. This is stricter than the
 * generic `validateErrorResponse` above on purpose: elsewhere an error is an
 * optional terminal state, but in this certification flow its absence is the
 * defect. Mirrors on_select_out_of_stock_validate.js, which hard-fails with
 * "request must send the out of stock error" when `error` is missing.
 *
 * This leg runs INSTEAD OF `validateErrorResponse`, not alongside it, so the two never
 * double-report the same malformed error.
 */
export function validateMandatoryOutOfStockError(error: any, result: TestResult): void {
  if (!hasErrorResponse(error)) {
    result.failed.push(
      `on_select: the first on_select of the Out_of_Stock(Error_code) flow must carry an out-of-stock error (expected error.code '${OUT_OF_STOCK_ERROR_CODE}') — none was sent`
    );
    return;
  }

  const cleanRun = failureGate(result);

  if (!error.code) {
    result.failed.push("on_select: out-of-stock error must include error.code");
  } else if (error.code !== OUT_OF_STOCK_ERROR_CODE) {
    result.failed.push(
      `on_select: out-of-stock error.code '${error.code}' must be '${OUT_OF_STOCK_ERROR_CODE}' (item quantity unavailable) for the Out_of_Stock(Error_code) flow`
    );
  }
  if (!error.type) {
    result.failed.push("on_select: out-of-stock error must include error.type");
  }

  if (cleanRun()) {
    result.passed.push(
      `on_select: mandatory out-of-stock error present (type '${error.type}', code '${error.code}')`
    );
  }
}

/**
 * The rejection itself must say less is available than was asked for. Contract
 * "/on_select (Out of stock)" fn 217, on the breakup line's `@ondc/org/item_quantity.count`:
 * "can be 0 (completely out of stock) or the reduced quantity in stock". So for every item
 * the 40002 error names, the quoted count must be below the count `select0` requested.
 * A rejection that still quotes the full basket used to pass: only the buyer's retry was held
 * to the reported availability (validateRetrySelectAgainstOutOfStock), never the seller.
 *
 * Reads `@ondc/org/item_quantity.count`, the field fn 217 annotates, and NOT
 * `item.quantity.available.count`: the contract's own example leaves that at "500" while
 * quoting 0. Skips silently when the error is not 40002 or its message does not parse into
 * item ids (both are validateMandatoryOutOfStockError's business), and when select0's data is
 * not stored.
 */
export function validateOutOfStockQuantityReduced(
  order: any,
  error: any,
  selectData: Record<string, any> | null,
  result: TestResult
): void {
  if (error?.code !== OUT_OF_STOCK_ERROR_CODE) return;

  let reported: any;
  try {
    reported = JSON.parse(String(error.message));
  } catch (_) {
    return;
  }
  const flagged = (Array.isArray(reported) ? reported : [])
    .map((entry: any) => entry?.item_id)
    .filter(Boolean)
    .map(String);
  if (flagged.length === 0) return;

  const selectedItems: any[] = Array.isArray(selectData?.items) ? selectData!.items : selectData?.items ? [selectData.items] : [];
  if (selectedItems.length === 0) return;
  const requestedById = new Map<string, number>();
  for (const item of selectedItems) {
    const count = Number(item?.quantity?.count);
    if (item?.id && Number.isInteger(count)) requestedById.set(String(item.id), count);
  }

  const breakup: any[] = Array.isArray(order?.quote?.breakup) ? order.quote.breakup : [];
  const cleanRun = failureGate(result);
  const reduced: string[] = [];

  for (const itemId of new Set(flagged)) {
    const requested = requestedById.get(itemId);
    if (requested === undefined) continue; // not in select0 — another check's business

    const line = breakup.find(
      (b: any) => String(b?.["@ondc/org/item_id"]) === itemId && b?.["@ondc/org/title_type"] === "item"
    );
    if (!line) {
      result.failed.push(
        `on_select: out-of-stock item ${itemId} has no 'item' line in quote.breakup — the rejection must quote it at 0 or the reduced quantity in stock`
      );
      continue;
    }

    const raw = line?.["@ondc/org/item_quantity"]?.count;
    const quoted = Number(raw);
    if (!Number.isInteger(quoted) || quoted < 0) {
      result.failed.push(
        `on_select: out-of-stock item ${itemId} breakup @ondc/org/item_quantity.count '${raw}' must be a non-negative integer`
      );
      continue;
    }
    if (quoted >= requested) {
      result.failed.push(
        `on_select: item ${itemId} is reported out of stock (40002) but quoted at ${quoted} of the ${requested} requested — the quoted count must be 0 (completely out of stock) or the reduced quantity in stock`
      );
      continue;
    }
    reduced.push(`${itemId}: ${quoted} of ${requested}`);
  }

  if (cleanRun() && reduced.length > 0) {
    result.passed.push(
      `on_select: every out-of-stock item is quoted below the requested quantity (${reduced.join(", ")})`
    );
  }
}

/** Ported from on_select_validate.js rule 1 — cross-call provider.id consistency. */
export function validateOnSelectProviderConsistency(order: any, selectData: Record<string, any> | null, result: TestResult): void {
  const selectedProviderId = selectData?.provider?.id;
  if (!selectedProviderId || !order?.provider?.id) return;

  if (order.provider.id !== selectedProviderId) {
    result.failed.push(
      `on_select: provider.id '${order.provider.id}' does not match provider.id '${selectedProviderId}' sent in select`
    );
  } else {
    result.passed.push(`on_select: provider.id '${order.provider.id}' matches select`);
  }
}

/**
 * Ported from on_select_validate.js rules 2-3 — every on_select item must have
 * been requested in select, and its location_id must match what select sent for
 * that item (or, if select didn't specify one, must be one of the provider
 * locations select declared).
 */
export function validateOnSelectItemsAgainstSelect(order: any, selectData: Record<string, any> | null, result: TestResult): void {
  const selectedItems: any[] = Array.isArray(selectData?.items) ? selectData.items : selectData?.items ? [selectData.items] : [];
  if (selectedItems.length === 0) return;

  const cleanRun = failureGate(result);
  const sentItemIds = new Set(selectedItems.map((i: any) => i?.id).filter(Boolean));
  const sentLocationByItemId = new Map<string, string>();
  for (const item of selectedItems) {
    if (item?.id && item?.location_id) sentLocationByItemId.set(item.id, item.location_id);
  }
  const sentLocationIds = new Set(
    (selectData?.provider?.locations || []).map((l: any) => l?.id).filter(Boolean)
  );

  let checked = 0;
  for (const item of order?.items || []) {
    if (!item?.id) continue;

    if (!sentItemIds.has(item.id)) {
      result.failed.push(`on_select: ${itemLabel(item)} was not requested in select`);
      continue;
    }
    checked++;

    if (item.location_id === undefined || item.location_id === null) continue;

    const expected = sentLocationByItemId.get(item.id);
    if (expected) {
      if (item.location_id !== expected) {
        result.failed.push(
          `on_select: ${itemLabel(item)} location_id '${item.location_id}' does not match location_id '${expected}' sent in select`
        );
      }
    } else if (sentLocationIds.size > 0 && !sentLocationIds.has(item.location_id)) {
      result.failed.push(
        `on_select: ${itemLabel(item)} location_id '${item.location_id}' is not one of the provider locations sent in select`
      );
    }
  }

  if (checked > 0 && cleanRun()) {
    result.passed.push(`on_select: all ${checked} item(s) were requested in select with consistent location_id`);
  }
}

/**
 * Self-contained — an order's own item.fulfillment_id must resolve within its own
 * order.fulfillments. Written for on_select; also run on every post-confirm seller leg
 * (`label`), where it catches a fulfillment dropped while items still point at it — the RTO
 * reference's `on_status_rto_delivered` keeps 11 units on `rto_mock_id_121` but omits that
 * fulfillment.
 */
export function validateOnSelectFulfillmentRefs(order: any, result: TestResult, label: string = "on_select"): void {
  const fulfillmentIds = new Set((order?.fulfillments || []).map((f: any) => f?.id).filter(Boolean));
  if (fulfillmentIds.size === 0) return;

  const cleanRun = failureGate(result);
  let referencing = 0;

  for (const item of order?.items || []) {
    if (item?.fulfillment_id === undefined || item?.fulfillment_id === null) continue;
    referencing++;
    if (!fulfillmentIds.has(item.fulfillment_id)) {
      result.failed.push(
        `${label}: ${itemLabel(item)} references fulfillment_id '${item.fulfillment_id}' which is not declared in order.fulfillments`
      );
    }
  }

  if (referencing > 0 && cleanRun()) {
    result.passed.push(`${label}: all ${referencing} item fulfillment_id reference(s) resolve to a declared fulfillment`);
  }
}

/** fulfillment.state.descriptor.code and @ondc/org/TAT, when present. */
export function validateOnSelectFulfillmentDetails(order: any, result: TestResult): void {
  const fulfillments = order?.fulfillments;
  if (!Array.isArray(fulfillments) || fulfillments.length === 0) return;

  const cleanRun = failureGate(result);
  let checked = 0;

  for (const fulfillment of fulfillments) {
    const ref = `fulfillment ${fulfillment?.id ?? "?"}`;

    const stateCode = fulfillment?.state?.descriptor?.code;
    if (stateCode !== undefined) {
      checked++;
      if (!String(stateCode).trim()) {
        result.failed.push(`on_select: ${ref} state.descriptor.code must not be empty`);
      }
    }

    const tat = fulfillment?.["@ondc/org/TAT"];
    if (tat !== undefined) {
      checked++;
      if (!ISO8601_DURATION.test(String(tat))) {
        result.failed.push(`on_select: ${ref} @ondc/org/TAT '${tat}' is not a valid ISO-8601 duration`);
      }
    }

    // The three fields below are mandated by the API contract's /on_select section and
    // carried by 10/10 reference payloads, but were unchecked until the contract audit
    // (docs/RETeB2B-select-contract-audit.md §3.1). Validated-if-present rather than
    // required, so a seller that legitimately omits one is not failed on presence alone —
    // the contract's default-mandatory rule is L1's to enforce, this layer checks shape.

    // Who is actually shipping. Two distinct values across the fixtures ("LSP or Provider
    // Name", "ABC Distributors"), so no enum — only non-emptiness is checkable.
    const providerName = fulfillment?.["@ondc/org/provider_name"];
    if (providerName !== undefined) {
      checked++;
      if (!String(providerName).trim()) {
        result.failed.push(`on_select: ${ref} @ondc/org/provider_name must not be empty`);
      }
    }

    // A real boolean, not the string "true". Same reasoning as the on_status leg: L1 checks
    // presence but not type, and a buyer app reading a truthy string would offer tracking
    // that does not work. All 10 reference payloads send a boolean (both true and false).
    const tracking = fulfillment?.tracking;
    if (tracking !== undefined && tracking !== null) {
      checked++;
      if (typeof tracking !== "boolean") {
        result.failed.push(
          `on_select: ${ref} tracking is '${tracking}' (${typeof tracking}) — it must be a boolean, not a string`
        );
      }
    }

    // DELIBERATELY NOT AN ENUM. Every reference payload says "Standard Delivery", which
    // makes an enum tempting — but the contract itself uses a second value,
    // "Immediate Delivery", in its own /on_select (Out of stock) example, and the concept
    // section advertises express delivery as a feature. An enum of the observed value would
    // false-fail the contract's own example.
    const category = fulfillment?.["@ondc/org/category"];
    if (category !== undefined) {
      checked++;
      if (!String(category).trim()) {
        result.failed.push(`on_select: ${ref} @ondc/org/category must not be empty`);
      }
    }
  }

  if (checked > 0 && cleanRun()) {
    result.passed.push(
      `on_select: fulfillment state / @ondc/org/TAT / provider_name / tracking / category valid across ${fulfillments.length} fulfillment(s)`
    );
  }
}

/**
 * `quote.ttl` — how long the seller's quote stands. Mandated by the API contract's
 * /on_select section and carried by 10/10 reference payloads (all `P1D`), but unchecked
 * until the contract audit (docs/RETeB2B-select-contract-audit.md §3.1).
 *
 * This is the leg where the quote is ISSUED, so it is the natural place to check it. The
 * equivalent check already existed one leg later, at confirm/on_confirm
 * (orderFormationChecks.validateOrderDurations) — the issuing leg was the gap.
 *
 * Validated-if-present: shape, not presence. Absence is L1's to enforce.
 */
export function validateOnSelectQuoteTtl(order: any, result: TestResult): void {
  const ttl = order?.quote?.ttl;
  if (ttl === undefined || ttl === null) return;

  if (!ISO8601_DURATION.test(String(ttl))) {
    result.failed.push(`on_select: quote.ttl '${ttl}' is not a valid ISO-8601 duration`);
    return;
  }

  result.passed.push(`on_select: quote.ttl '${ttl}' is a valid ISO-8601 duration`);
}
