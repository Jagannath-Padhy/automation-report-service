import { TestResult } from "../../../types/payload";
import { failureGate, tagGroupsByCode, tagValue } from "./onSearchB2BChecks";
import { toMillis } from "./commonChecks";
import { asArray } from "./returnChecks";

// Business checks for APPLIED offers (schemes) in ONDC:RETeB2B 1.2.5 — the two
// `Order_to_confirm_to_fulfillment_with_offers(cod|Prepaid)` flows. The seller applies an offer
// as a quote.breakup line at on_select; these checks prove that line is one the seller actually
// advertised in on_search, that this order qualifies for it, that its price is what the catalog
// benefit computes to, and that it survives unchanged into every later order-level callback.
//
// Catalog-side shape (on_search provider.offers[]) is NOT validated here — see
// onSearchB2BChecks. The init-leg `order.offers` claim against the catalog is
// orderFormationChecks.validateOffersAgainstCatalog / validateSelectOffersCarriedForward, which
// this module deliberately leaves untouched and stays consistent with (same case-insensitive
// offer-id match, same location/item/window/min_value semantics).
//
// ---------------------------------------------------------------------------
// SOURCES — the API contract (/tmp/ebb2b_doc.txt), "Schemes" L5061-6352
// ---------------------------------------------------------------------------
//   - L5068 evaluation order: Applicability -> Qualifiers -> Scheme Progress -> Benefit -> Meta.
//   - L5085-5093 component table: Applicability = location_ids, category_ids, item_ids, time;
//     Qualifier = min_value, item_count, item_count_upper (THE ONLY THREE DEFINED);
//     Benefit = value, value_type, value_cap, item_id, item_count, item_value;
//     Meta = "additive (combinable with other offers), auto (auto-applied or opt-in)".
//   - Apply examples — an applied offer is a breakup line with `@ondc/org/title_type: "offer"`,
//     `@ondc/org/item_id` = the offer id, a non-positive price, and item.tags
//     `quote{type: order}` + `offer{type: <catalog descriptor.code>, additive, auto, ...}`:
//       discount  Apply L5225 (line L5247)  discp10 -104.00; catalog percent -10, cap -200
//       buyXgetY  Apply L5410 (line L5432)  buy2get3 0.00, item_quantity 1, offer tag also
//                                           carries item_id / item_count / item_value
//       freebie   Apply L5594 (line L5616)  freebie1 0.00, item_quantity 5, offer tag also
//                                           carries item_id / item_count
//       slab      Apply L5894 (line L5916)  slab2 -960.00; catalog item_count 20, upper "",
//                                           percent -10, cap -1000
//       combo     Apply L6214 (line L6256)  combo1 -200.00; catalog percent -50, cap -200 over a
//                                           qualifier `item_id: "I4,I5"` (L6118) that is never
//                                           defined
//   - L6216: "Any offer that results in change in the order value and / or quantity of items
//     will be applied to the order quote, and will be a part of all order level callbacks,
//     i.e. /on_init, /on_confirm, /on_status, /on_cancel, /on_update" — the basis of
//     validateOfferLinesUnchanged.
//
// ---------------------------------------------------------------------------
// USER DECISIONS (2026-10-15) — binding; the contract is silent or loose on each
// ---------------------------------------------------------------------------
//   D1 Stacking is STRICT: with more than one offer line applied, every applied offer whose
//      `additive` is "no" fails. additive is read from the catalog meta when the offer
//      resolves, else from the line's own offer tag.
//   D2 Applicability per applied line: advertised by the provider; item_ids intersects the
//      order's items (empty/absent item_ids = unrestricted); location_ids intersects
//      order.provider.locations (clause skipped if either side is absent); when time is present,
//      time.label is "valid" and start <= context.timestamp <= end, BOTH ends inclusive.
//      category_ids is NOT checked.
//   D3 Qualifiers: min_value <= applicable subtotal (only when every applicable item is priced
//      from the catalog); item_count <= applicable units <= item_count_upper (inclusive;
//      empty/absent upper = unbounded). Any other qualifier code is a PASS note
//      "not evaluated (undefined in contract)", never a failure.
//      Base: applicable items = order.items whose id is in item_ids (all items when item_ids is
//      empty/absent); units = sum of quantity.count; subtotal = sum of catalog unit price
//      (provider.items[].price.value) x count.
//   D4 The free-unit count (`@ondc/org/item_quantity.count` on a buyXgetY/freebie line) is NOT
//      checked against the benefit.
//   D5 Opt-in vs auto (`meta.auto`) is NOT enforced against what the buyer selected.
//   D6 Only `title_type === "offer"` lines are offer lines; legacy "discount" lines are ignored.
//   D7 order.offers (ids, case-insensitive) must equal EXACTLY the set of offer-line ids on the
//      same leg — one failure per leg.
//   D9 on_select must carry at least one offer line.
//   Benefit arithmetic (offer resolved, applicable): discount/slab percent ->
//      -min(|value|% x subtotal, |value_cap|) (needs a fully priced subtotal); amount -> -|value|;
//      buyXgetY/freebie -> the line is priced 0.00 and its offer-tag item_id / item_value echo the
//      catalog benefit; combo, unknown codes, unsupported value_types -> PASS note. Tolerance
//      OFFER_EPSILON = 0.01.
//
// ---------------------------------------------------------------------------
// CALIBRATION — every rule below holds on all three sources
// ---------------------------------------------------------------------------
//   live  COD-with-offers session (2026-10-14), provider P10, on_select I1 x 12 @ 52.00:
//         order.offers [discp10, buy2get3]; lines discp10 -62.40 (10% of 624.00, cap 2000) and
//         buy2get3 qty 1 @ 0.00 (item_count 2 <= 12; free I1 @ 0.00). The ONE expected failure
//         is stacking: buy2get3 is meta.additive "no" and is applied together with discp10.
//         With buy2get3 removed (order.offers [discp10]) the leg is clean.
//         Later legs carry both lines unchanged, but list only [discp10] in order.offers (and
//         none at all on one on_status) — a D7 failure there, which is the point of D7.
//   spec  ..._with_offers__cod_.yaml, provider P10, on_select I1 x 17: order.offers [buy2get3],
//         buy2get3 qty 1 @ 0.00 — clean. Every later order leg still applies the buy2get3 line
//         unchanged but omits order.offers (on_status_agent_assigned instead lists [discp10]) —
//         D7 failures on those legs.
//   spec  ..._with_offers__Prepaid_.yaml, provider P1, on_select I1 x 17: order.offers [discp10],
//         discp10 -88.40 (10% of 884.00) — clean. Spec timestamps arrive as Date objects from
//         js-yaml, so every time comparison goes through toMillis.
//
// ---------------------------------------------------------------------------
// DELIBERATE NON-CHECKS
// ---------------------------------------------------------------------------
//   - category_ids (D2): category names are free text and the order carries none to match.
//   - item_weight / item_weight_upper, item_value / item_value_upper, combo `item_id` and any
//     other qualifier code: outside the L5085 qualifier definition (item_weight appears only in
//     an on_search example, L1940, with no unit) — PASS note only.
//   - combo benefit arithmetic: the percent applies to a combination defined by the qualifier
//     `item_id: "I4,I5"` (L6118), whose semantics the contract never states, so the subtotal it
//     applies to cannot be derived — PASS note only.
//   - the time window inside validateOfferBenefit: its frozen signature carries no context, so
//     "applicable" there means items, locations and qualifiers; a window failure is reported by
//     validateOfferApplicability alone.
//   - free-unit count (D4), opt-in vs auto (D5), "discount" title_type lines (D6).
//   - scheme_progress: informational, nothing in the order to reconcile it with.
//   - The catalog contradiction in both offers catalogs — discp10 is valid only at L1 yet lists
//     I2 and I4, which the same catalog stocks at L2 — is a catalog defect, not an order defect,
//     and is not re-derived here (location and item intersections are checked independently).

/** The two flows whose orders carry applied offers. Exact flow ids. */
export const OFFERS_FLOW_IDS: readonly string[] = [
  "Order_to_confirm_to_fulfillment_with_offers(cod)",
  "Order_to_confirm_to_fulfillment_with_offers(Prepaid)",
];

export function isOffersFlow(flowId: string | undefined): boolean {
  return flowId !== undefined && OFFERS_FLOW_IDS.indexOf(flowId) !== -1;
}

const OFFER_EPSILON = 0.01;

/** The only qualifier codes the contract defines (L5085-5093). */
const DEFINED_QUALIFIERS = new Set(["min_value", "item_count", "item_count_upper"]);

/** One applied offer, read from a quote.breakup line with title_type "offer". */
export interface AppliedOfferLine {
  /** `@ondc/org/item_id` as written (empty string when absent). */
  id: string;
  /** Lower-cased id, for case-insensitive matching. */
  key: string;
  /** Position of the line in quote.breakup. */
  index: number;
  price: number | null;
  rawPrice: unknown;
  /** `@ondc/org/item_quantity.count` (free units on buyXgetY / freebie lines). */
  count: number | undefined;
  /** item.tags `quote` -> `type`. */
  quoteType: string | undefined;
  /** item.tags `offer` list as code -> value, or null when the line carries no offer tag. */
  offerTag: Map<string, string> | null;
  line: any;
}

function toAmount(value: any): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toCount(value: any): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function sameAmount(a: number, b: number): boolean {
  return Math.abs(a - b) < OFFER_EPSILON;
}

function isPresent(value: any): boolean {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

/** Timestamps from js-yaml are Date objects; print them as ISO, not Date#toString. */
function iso(value: any): string {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : String(value);
  return String(value);
}

function idList(ids: string[]): string {
  return ids.join(", ");
}

function offerTagOf(line: any): Map<string, string> | null {
  const list = tagGroupsByCode(asArray(line?.item?.tags), "offer")[0]?.list;
  if (!Array.isArray(list)) return null;
  const map = new Map<string, string>();
  list.forEach((entry: any) => {
    if (entry?.code !== undefined) map.set(String(entry.code), entry?.value === undefined ? "" : String(entry.value));
  });
  return map;
}

/** Applied offer lines of a breakup — saved breakups may come back as a bare object. */
export function offerLinesOf(breakup: unknown): AppliedOfferLine[] {
  const lines: AppliedOfferLine[] = [];
  asArray(breakup).forEach((line: any, index: number) => {
    if (line?.["@ondc/org/title_type"] !== "offer") return;
    const rawId = line?.["@ondc/org/item_id"];
    const id = isPresent(rawId) ? String(rawId) : "";
    lines.push({
      id,
      key: id.toLowerCase(),
      index,
      price: toAmount(line?.price?.value),
      rawPrice: line?.price?.value,
      count: toCount(line?.["@ondc/org/item_quantity"]?.count),
      quoteType: tagValue(tagGroupsByCode(asArray(line?.item?.tags), "quote")[0]?.list, "type"),
      offerTag: offerTagOf(line),
      line,
    });
  });
  return lines;
}

export function resolveCatalogProvider(onSearchData: Record<string, any> | null, providerId: unknown): any | null {
  if (!isPresent(providerId)) return null;
  return asArray(onSearchData?.providers).find((p: any) => String(p?.id) === String(providerId)) ?? null;
}

/** Case-insensitive, like orderFormationChecks.validateOffersAgainstCatalog. */
export function findCatalogOffer(provider: any, offerId: string): any | null {
  if (!isPresent(offerId)) return null;
  const key = String(offerId).toLowerCase();
  return asArray(provider?.offers).find((o: any) => String(o?.id).toLowerCase() === key) ?? null;
}

function catalogList(offer: any, code: string): any[] | undefined {
  const list = tagGroupsByCode(asArray(offer?.tags), code)[0]?.list;
  return Array.isArray(list) ? list : undefined;
}

function catalogTag(offer: any, group: string, code: string): string | undefined {
  const value = tagValue(catalogList(offer, group), code);
  return value === undefined ? undefined : String(value);
}

function offerLinesOfOrder(order: any): AppliedOfferLine[] {
  return offerLinesOf(order?.quote?.breakup);
}

// ---------------------------------------------------------------------------
// Applicability + qualifiers (shared by validateOfferApplicability and validateOfferBenefit)
// ---------------------------------------------------------------------------

interface ApplicabilityBase {
  matchedIds: string[];
  units: number;
  subtotal: number;
  /** Every applicable item has an integer count AND a catalog price. */
  fullyPriced: boolean;
  /** Every applicable item has an integer count. */
  countsKnown: boolean;
}

interface Assessment {
  failures: string[];
  notes: string[];
  undefinedNotes: string[];
  base: ApplicabilityBase;
}

function integerCount(value: any): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) ? n : null;
}

function applicabilityBase(order: any, provider: any, offer: any): ApplicabilityBase {
  const offerItemIds = asArray(offer?.item_ids).filter(isPresent).map(String);
  const restricted = offerItemIds.length > 0;
  const catalogPrice = new Map<string, number>();
  asArray(provider?.items).forEach((item: any) => {
    const price = toAmount(item?.price?.value);
    if (isPresent(item?.id) && price !== null) catalogPrice.set(String(item.id), price);
  });

  const matchedIds: string[] = [];
  let units = 0;
  let subtotal = 0;
  let fullyPriced = true;
  let countsKnown = true;
  asArray(order?.items).forEach((item: any) => {
    const itemId = String(item?.id);
    if (restricted && offerItemIds.indexOf(itemId) === -1) return;
    if (matchedIds.indexOf(itemId) === -1) matchedIds.push(itemId);
    const count = integerCount(item?.quantity?.count);
    const price = catalogPrice.get(itemId);
    if (count === null) {
      countsKnown = false;
      fullyPriced = false;
      return;
    }
    units += count;
    if (price === undefined) {
      fullyPriced = false;
      return;
    }
    subtotal += price * count;
  });
  return { matchedIds, units, subtotal, fullyPriced, countsKnown };
}

function assessApplicability(order: any, context: any, provider: any, offer: any, line: AppliedOfferLine, label: string): Assessment {
  const failures: string[] = [];
  const notes: string[] = [];
  const undefinedNotes: string[] = [];
  const ref = `${label}: offer '${line.id}'`;
  const base = applicabilityBase(order, provider, offer);

  // Items — empty/absent item_ids means the offer is not item-restricted.
  const offerItemIds = asArray(offer?.item_ids).filter(isPresent).map(String);
  const orderItemIds = asArray(order?.items).map((i: any) => i?.id).filter(isPresent).map(String);
  if (offerItemIds.length > 0 && !offerItemIds.some((id: string) => orderItemIds.indexOf(id) !== -1)) {
    failures.push(
      `${ref} lists item_ids [${idList(offerItemIds)}], none of which this order contains (items: ${idList(orderItemIds) || "none"})`
    );
  }

  // Locations — skipped when either side has none.
  const offerLocationIds = asArray(offer?.location_ids).filter(isPresent).map(String);
  const orderLocationIds = asArray(order?.provider?.locations).map((l: any) => l?.id).filter(isPresent).map(String);
  if (
    offerLocationIds.length > 0 &&
    orderLocationIds.length > 0 &&
    !offerLocationIds.some((id: string) => orderLocationIds.indexOf(id) !== -1)
  ) {
    failures.push(
      `${ref} lists location_ids [${idList(offerLocationIds)}], none of which this order uses (provider.locations: ${idList(orderLocationIds)})`
    );
  }

  // Validity window — both ends inclusive.
  const time = offer?.time;
  if (time !== undefined && time !== null) {
    if (time?.label !== "valid") {
      failures.push(`${ref} catalog time.label is '${time?.label}', not 'valid' — the offer cannot be applied`);
    }
    const start = toMillis(time?.range?.start);
    const end = toMillis(time?.range?.end);
    const at = toMillis(context?.timestamp);
    if (start === null || end === null) {
      notes.push(`offer '${line.id}' catalog time.range unparseable — validity window not evaluated`);
    } else if (at === null) {
      notes.push(`context.timestamp unparseable — validity window of offer '${line.id}' not evaluated`);
    } else if (at < start || at > end) {
      failures.push(
        `${ref} is applied at ${iso(context?.timestamp)}, outside its validity range ${iso(time.range.start)} -> ${iso(time.range.end)}`
      );
    }
  }

  // Qualifiers — only meaningful when the order actually contains applicable items; an empty
  // match was already reported above.
  const qualifier = catalogList(offer, "qualifier");
  if (qualifier && base.matchedIds.length > 0) {
    qualifier.forEach((entry: any) => {
      const code = String(entry?.code);
      if (!DEFINED_QUALIFIERS.has(code)) {
        undefinedNotes.push(
          `${ref} qualifier '${code}' = '${entry?.value}' was not checked — only ${[...DEFINED_QUALIFIERS].join(", ")} qualifiers have a defined meaning`
        );
      }
    });

    const minRaw = tagValue(qualifier, "min_value");
    if (isPresent(minRaw)) {
      const min = toAmount(minRaw);
      if (min === null) {
        notes.push(`offer '${line.id}' qualifier min_value '${minRaw}' is not a number — not evaluated`);
      } else if (!base.fullyPriced) {
        notes.push(`offer '${line.id}' min_value not evaluated — applicable items not fully priced from the catalog`);
      } else if (base.subtotal < min - 1e-9) {
        failures.push(
          `${ref} requires a qualifying value of ${min.toFixed(2)}, but the applicable items total ${base.subtotal.toFixed(2)} (${idList(base.matchedIds)})`
        );
      }
    }

    const lowerRaw = tagValue(qualifier, "item_count");
    const upperRaw = tagValue(qualifier, "item_count_upper");
    if (isPresent(lowerRaw) || isPresent(upperRaw)) {
      const lower = isPresent(lowerRaw) ? toAmount(lowerRaw) : 0;
      const upper = isPresent(upperRaw) ? toAmount(upperRaw) : Infinity;
      if (lower === null || upper === null) {
        notes.push(`offer '${line.id}' qualifier item_count '${lowerRaw}'/'${upperRaw}' is not a number — not evaluated`);
      } else if (!base.countsKnown) {
        notes.push(`offer '${line.id}' item_count not evaluated — an applicable item has no integer quantity.count`);
      } else if (base.units < lower || base.units > upper) {
        const band = upper === Infinity ? `at least ${lower}` : `${lower} to ${upper}`;
        failures.push(
          `${ref} qualifies for ${band} applicable unit(s), but the order has ${base.units} applicable unit(s) (${idList(base.matchedIds)})`
        );
      }
    }
  }

  return { failures, notes, undefinedNotes, base };
}

// ---------------------------------------------------------------------------
// Per-leg checks
// ---------------------------------------------------------------------------

/**
 * An offers-flow on_search must advertise at least one offer. These flows exist to exercise
 * catalog offers, and `validateOffers` returns silently on an absent `offers`, so a catalog
 * with none used to surface only one leg later, as on_select's "not advertised" failure.
 *
 * Catalog-wide, not per provider: a multi-provider catalog may legitimately run its schemes
 * through one distributor only. A non-array `offers` counts as none here; its shape is
 * `validateOffers`' job.
 */
export function validateCatalogOffersPresent(providers: any, result: TestResult): void {
  const withOffers = asArray(providers).filter((p: any) => Array.isArray(p?.offers) && p.offers.length > 0);
  if (withOffers.length === 0) {
    result.failed.push(
      "on_search: no provider advertises any offer — an offers flow's catalog must carry the available offers in bpp/providers[].offers"
    );
    return;
  }
  result.passed.push(
    `on_search: catalog advertises offers (${withOffers.map((p: any) => `${p?.id ?? "?"}: ${p.offers.length}`).join(", ")})`
  );
}

/** D9: an offers-flow on_select must apply at least one offer. */
export function validateOfferLinesPresent(order: any, label: string, result: TestResult): void {
  const breakup = order?.quote?.breakup;
  if (!Array.isArray(breakup)) {
    result.failed.push(`${label}: quote.breakup is missing, so the quote applies no offer — an offers flow must apply at least one`);
    return;
  }
  const lines = offerLinesOfOrder(order);
  if (lines.length === 0) {
    result.failed.push(
      `${label}: quote.breakup applies no offer — an offers flow must carry at least one line with title_type 'offer'`
    );
    return;
  }
  result.passed.push(`${label}: quote.breakup applies ${lines.length} offer(s) (${idList(lines.map((l) => l.id || "?"))})`);
}

/**
 * Every offer line must look like the contract's apply examples: an offer id, a price that is
 * a number and never positive (an offer only takes money off — "0.00" for buyXgetY/freebie),
 * `quote.type: order`, and an `offer` tag with a `type` and yes/no `additive` / `auto`.
 */
export function validateOfferLineShape(order: any, label: string, result: TestResult): void {
  const lines = offerLinesOfOrder(order);
  if (lines.length === 0) return;

  const ok = failureGate(result);
  lines.forEach((line) => {
    if (!line.id) {
      result.failed.push(`${label}: quote.breakup[${line.index}] has title_type 'offer' but no @ondc/org/item_id naming the offer`);
      return;
    }
    const ref = `${label}: offer '${line.id}'`;
    if (line.price === null) {
      result.failed.push(`${ref} price.value '${line.rawPrice}' is not a number`);
    } else if (line.price > 0) {
      result.failed.push(`${ref} price.value ${line.rawPrice} is positive — an offer can only reduce the order value`);
    }
    if (line.quoteType !== "order") {
      result.failed.push(`${ref} item.tags quote.type is '${line.quoteType}', expected 'order'`);
    }
    if (!line.offerTag) {
      result.failed.push(`${ref} carries no item.tags 'offer' group`);
      return;
    }
    if (!isPresent(line.offerTag.get("type"))) {
      result.failed.push(`${ref} offer tag has no 'type'`);
    }
    for (const field of ["additive", "auto"]) {
      const value = line.offerTag.get(field);
      if (value !== "yes" && value !== "no") {
        result.failed.push(
          `${ref} offer tag ${field} is ${value === undefined ? "missing" : `'${value}'`}, expected 'yes' or 'no'`
        );
      }
    }
  });
  if (ok()) {
    result.passed.push(
      `${label}: ${lines.length} offer line(s) (${idList(lines.map((l) => l.id))}) are well-formed (offer id, non-positive price, quote type 'order', offer tag with type/additive/auto)`
    );
  }
}

/**
 * D7: order.offers is the order's own statement of which offers it carries, so it must name
 * exactly the offers applied in quote.breakup on the same leg (ids compared case-insensitively).
 * One failure per leg. Skipped when quote.breakup is not an array.
 */
export function validateOrderOffersMatchApplied(order: any, label: string, result: TestResult): void {
  const breakup = order?.quote?.breakup;
  if (!Array.isArray(breakup)) return;

  const applied = offerLinesOf(breakup).filter((l) => l.id);
  const appliedByKey = new Map<string, string>();
  applied.forEach((l) => {
    if (!appliedByKey.has(l.key)) appliedByKey.set(l.key, l.id);
  });

  const rawOffers = order?.offers;
  const listedByKey = new Map<string, string>();
  asArray(rawOffers)
    .map((o: any) => o?.id)
    .filter(isPresent)
    .map(String)
    .forEach((id: string) => {
      if (!listedByKey.has(id.toLowerCase())) listedByKey.set(id.toLowerCase(), id);
    });

  const appliedIds = Array.from(appliedByKey.values());
  if (rawOffers === undefined || rawOffers === null) {
    if (appliedIds.length > 0) {
      result.failed.push(
        `${label}: order.offers is missing, but quote.breakup applies ${appliedIds.map((id) => `offer '${id}'`).join(", ")}`
      );
    } else {
      result.passed.push(`${label}: order.offers matches the offers applied in quote.breakup (none)`);
    }
    return;
  }

  const notListed = Array.from(appliedByKey.entries())
    .filter(([key]) => !listedByKey.has(key))
    .map(([, id]) => `offer '${id}'`);
  const notApplied = Array.from(listedByKey.entries())
    .filter(([key]) => !appliedByKey.has(key))
    .map(([, id]) => `offer '${id}'`);

  if (notListed.length > 0 || notApplied.length > 0) {
    result.failed.push(
      `${label}: order.offers [${idList(Array.from(listedByKey.values()))}] does not match the offers applied in quote.breakup [${idList(appliedIds)}] — not listed: ${notListed.join(", ") || "none"}; listed but not applied: ${notApplied.join(", ") || "none"}`
    );
    return;
  }
  result.passed.push(
    `${label}: order.offers matches the offers applied in quote.breakup (${appliedIds.length > 0 ? idList(appliedIds) : "none"})`
  );
}

/**
 * D1 (strict stacking): when more than one offer line is applied, none of them may be
 * non-additive. additive comes from the catalog meta when the offer resolves (the seller's
 * published rule), else from the line's own offer tag. A single applied offer never trips this.
 */
export function validateOfferStacking(order: any, provider: any | null, label: string, result: TestResult): void {
  const lines = offerLinesOfOrder(order).filter((l) => l.id);
  if (lines.length === 0) return;
  if (lines.length === 1) {
    result.passed.push(`${label}: only offer '${lines[0].id}' is applied — the stacking rule is not engaged`);
    return;
  }

  const ok = failureGate(result);
  lines.forEach((line) => {
    const offer = provider ? findCatalogOffer(provider, line.id) : null;
    const catalogAdditive = offer ? catalogTag(offer, "meta", "additive") : undefined;
    const additive = catalogAdditive ?? line.offerTag?.get("additive");
    const source = catalogAdditive !== undefined ? "catalog meta.additive" : "its offer tag's additive";
    if (additive !== undefined && additive.trim().toLowerCase() === "no") {
      const others = lines.filter((l) => l.index !== line.index).map((l) => `'${l.id}'`);
      result.failed.push(
        `${label}: offer '${line.id}' is non-additive (${source} '${additive}') but is applied together with ${idList(others)} — a non-additive offer cannot be combined with other offers`
      );
    }
  });
  if (ok()) {
    result.passed.push(`${label}: ${lines.length} offers applied together (${idList(lines.map((l) => l.id))}) are all additive`);
  }
}

/**
 * D2 + D3: each applied offer must be one the provider advertised in on_search, and this order
 * must qualify for it — items, locations, validity window, then the min_value / item_count
 * qualifiers over the applicable items. Skipped when the catalog provider is not available.
 * Qualifier codes the contract does not define are reported as PASS notes, never failures.
 */
export function validateOfferApplicability(
  order: any,
  context: any,
  provider: any | null,
  label: string,
  result: TestResult
): void {
  if (!provider) return;
  const lines = offerLinesOfOrder(order).filter((l) => l.id);
  if (lines.length === 0) return;

  const ok = failureGate(result);
  const notes: string[] = [];
  lines.forEach((line) => {
    const offer = findCatalogOffer(provider, line.id);
    if (!offer) {
      result.failed.push(`${label}: offer '${line.id}' is not advertised by provider '${provider?.id}' in on_search`);
      return;
    }
    const verdict = assessApplicability(order, context, provider, offer, line, label);
    verdict.failures.forEach((f) => result.failed.push(f));
    verdict.undefinedNotes.forEach((n) => result.passed.push(n));
    notes.push(...verdict.notes);
  });
  if (ok()) {
    result.passed.push(
      `${label}: ${lines.length} applied offer(s) (${idList(lines.map((l) => l.id))}) are advertised by provider '${provider?.id}' and applicable to this order (items, locations, validity window, qualifiers)${notes.length ? ` (${notes.join("; ")})` : ""}`
    );
  }
}

/**
 * The applied line must be worth exactly what the catalog benefit says, for this order:
 *   discount / slab, value_type percent: -min(|value|% x applicable subtotal, |value_cap|);
 *   discount / slab, value_type amount:  -|value|;
 *   buyXgetY / freebie: priced 0.00 (the benefit is units, not money), with the offer tag's
 *     item_id (and item_value, when both sides carry it) echoing the catalog benefit.
 * Only offers that resolve in the catalog AND are applicable are priced — an inapplicable
 * offer is already a failure in validateOfferApplicability. combo, unknown codes and
 * unsupported value_types are PASS notes.
 */
export function validateOfferBenefit(order: any, provider: any | null, label: string, result: TestResult): void {
  if (!provider) return;
  const lines = offerLinesOfOrder(order).filter((l) => l.id);
  if (lines.length === 0) return;

  const ok = failureGate(result);
  const priced: string[] = [];
  const notes: string[] = [];
  lines.forEach((line) => {
    const offer = findCatalogOffer(provider, line.id);
    if (!offer) return;
    // Applicability needs the leg's context only for the time window, which does not affect
    // the price — pass none, and ignore the window here.
    const verdict = assessApplicability(order, null, provider, { ...offer, time: undefined }, line, label);
    if (verdict.failures.length > 0) return;
    if (line.price === null) return; // validateOfferLineShape reports it

    const ref = `${label}: offer '${line.id}'`;
    const code = offer?.descriptor?.code;
    const benefit = catalogList(offer, "benefit");

    if (code === "discount" || code === "slab") {
      const valueType = tagValue(benefit, "value_type");
      const value = toAmount(tagValue(benefit, "value"));
      if (valueType !== "percent" && valueType !== "amount") {
        result.passed.push(
          `${ref} benefit was not priced — a ${code} offer's value_type must be 'percent' or 'amount', got '${valueType}'`
        );
        return;
      }
      if (value === null) {
        notes.push(`offer '${line.id}' catalog benefit value '${tagValue(benefit, "value")}' is not a number — not priced`);
        return;
      }
      let expected: number;
      let basis: string;
      if (valueType === "percent") {
        if (!verdict.base.fullyPriced) {
          notes.push(`offer '${line.id}' not priced — applicable items not fully priced from the catalog`);
          return;
        }
        const capRaw = tagValue(benefit, "value_cap");
        const cap = isPresent(capRaw) ? toAmount(capRaw) : null;
        const raw = (Math.abs(value) / 100) * verdict.base.subtotal;
        expected = -(cap !== null ? Math.min(raw, Math.abs(cap)) : raw);
        basis = `${Math.abs(value)}% of ${verdict.base.subtotal.toFixed(2)}${cap !== null ? `, cap ${Math.abs(cap).toFixed(2)}` : ""}`;
      } else {
        expected = -Math.abs(value);
        basis = `flat ${Math.abs(value).toFixed(2)}`;
      }
      if (!sameAmount(line.price, expected)) {
        result.failed.push(
          `${ref} is priced ${line.rawPrice}, which does not match the catalog benefit ${expected.toFixed(2)} (${basis})`
        );
      } else {
        priced.push(`${line.id} ${line.price.toFixed(2)}`);
      }
      return;
    }

    if (code === "buyXgetY" || code === "freebie") {
      const before = result.failed.length;
      if (!sameAmount(line.price, 0)) {
        result.failed.push(`${ref} (${code}) is priced ${line.rawPrice} but must be priced 0.00 — its benefit is free units, not money`);
      }
      const catalogItem = tagValue(benefit, "item_id");
      const lineItem = line.offerTag?.get("item_id");
      if (isPresent(catalogItem) && String(lineItem) !== String(catalogItem)) {
        result.failed.push(
          `${ref} offer tag item_id '${lineItem}' does not match the catalog benefit item_id '${catalogItem}'`
        );
      }
      const catalogValue = tagValue(benefit, "item_value");
      const lineValue = line.offerTag?.get("item_value");
      if (isPresent(catalogValue) && isPresent(lineValue)) {
        const c = toAmount(catalogValue);
        const l = toAmount(lineValue);
        if (c === null || l === null || !sameAmount(c, l)) {
          result.failed.push(
            `${ref} offer tag item_value '${lineValue}' does not match the catalog benefit item_value '${catalogValue}'`
          );
        }
      }
      if (result.failed.length === before) {
        priced.push(`${line.id} 0.00${isPresent(catalogItem) ? ` (free ${catalogItem})` : ""}`);
      }
      return;
    }

    result.passed.push(
      `${ref} benefit was not priced — price checks are defined only for discount, slab, buyXgetY and freebie offers (got descriptor.code '${code}')`
    );
  });

  if (ok()) {
    if (priced.length > 0) {
      result.passed.push(
        `${label}: ${priced.length} applied offer(s) match the catalog benefit (${priced.join("; ")})${notes.length ? ` (${notes.join("; ")})` : ""}`
      );
    } else if (notes.length > 0) {
      // Nothing could be priced, but say why — otherwise the check would leave no trace.
      result.passed.push(`${label}: benefit not priced (${notes.join("; ")})`);
    }
  }
}

/**
 * The line's offer tag restates the catalog offer, so it must say the same thing: tag `type`
 * = catalog descriptor.code, `additive` = meta.additive, `auto` = meta.auto (exact strings).
 * A field the catalog does not carry is skipped. One failure per offer, listing every field
 * that differs.
 */
export function validateOfferMetaEcho(order: any, provider: any | null, label: string, result: TestResult): void {
  if (!provider) return;
  const lines = offerLinesOfOrder(order).filter((l) => l.id && l.offerTag);
  if (lines.length === 0) return;

  const ok = failureGate(result);
  let compared = 0;
  lines.forEach((line) => {
    const offer = findCatalogOffer(provider, line.id);
    if (!offer) return;
    const tag = line.offerTag as Map<string, string>;
    const pairs: Array<[string, string, string | undefined]> = [
      ["type", "descriptor.code", offer?.descriptor?.code === undefined ? undefined : String(offer.descriptor.code)],
      ["additive", "meta.additive", catalogTag(offer, "meta", "additive")],
      ["auto", "meta.auto", catalogTag(offer, "meta", "auto")],
    ];
    const diffs: string[] = [];
    pairs.forEach(([field, catalogField, catalogValue]) => {
      if (catalogValue === undefined) return;
      const lineValue = tag.get(field);
      if (lineValue !== catalogValue) {
        diffs.push(`${field} '${lineValue ?? "missing"}' vs ${catalogField} '${catalogValue}'`);
      }
    });
    compared++;
    if (diffs.length > 0) {
      result.failed.push(`${label}: offer '${line.id}' offer tag does not echo the catalog (${diffs.join("; ")})`);
    }
  });
  if (ok() && compared > 0) {
    result.passed.push(`${label}: offer tags of ${compared} applied offer(s) echo the catalog (type, additive, auto)`);
  }
}

/**
 * The on_select leg of an offers flow: resolves the catalog provider once from saved on_search
 * data and runs every per-leg offer check in evaluation order.
 */
export function validateOnSelectOffers(
  order: any,
  context: any,
  onSearchData: Record<string, any> | null,
  result: TestResult
): void {
  const label = "on_select";
  const provider = resolveCatalogProvider(onSearchData, order?.provider?.id);
  validateOfferLinesPresent(order, label, result);
  validateOfferLineShape(order, label, result);
  validateOrderOffersMatchApplied(order, label, result);
  validateOfferStacking(order, provider, label, result);
  validateOfferApplicability(order, context, provider, label, result);
  validateOfferBenefit(order, provider, label, result);
  validateOfferMetaEcho(order, provider, label, result);
}

// ---------------------------------------------------------------------------
// Later legs — L6216: applied offers are part of every order-level callback
// ---------------------------------------------------------------------------

function sortedTagEntries(tag: Map<string, string> | null): string {
  if (!tag) return "none";
  return Array.from(tag.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

/**
 * Every offer applied at on_select must still be applied, unchanged, on this leg — same price,
 * same free-unit count, same offer tag (compared order-insensitively) — and no offer may appear
 * that on_select did not apply. One failure per offending offer.
 *
 * Skipped when on_select's saved breakup is unavailable, when this leg carries no
 * quote.breakup array, or when neither side applies any offer.
 */
export function validateOfferLinesUnchanged(
  order: any,
  onSelectData: Record<string, any> | null,
  label: string,
  result: TestResult
): void {
  const saved = asArray(onSelectData?.quote_breakup);
  if (saved.length === 0) return;
  if (!Array.isArray(order?.quote?.breakup)) return;

  const before = offerLinesOf(saved).filter((l) => l.id);
  const now = offerLinesOfOrder(order).filter((l) => l.id);
  if (before.length === 0 && now.length === 0) return;

  const beforeByKey = new Map<string, AppliedOfferLine>();
  before.forEach((l) => {
    if (!beforeByKey.has(l.key)) beforeByKey.set(l.key, l);
  });
  const nowByKey = new Map<string, AppliedOfferLine>();
  now.forEach((l) => {
    if (!nowByKey.has(l.key)) nowByKey.set(l.key, l);
  });

  const ok = failureGate(result);
  beforeByKey.forEach((was, key) => {
    const is = nowByKey.get(key);
    if (!is) {
      result.failed.push(`${label}: offer '${was.id}' applied at on_select is missing from quote.breakup`);
      return;
    }
    const diffs: string[] = [];
    const priceSame =
      was.price !== null && is.price !== null ? sameAmount(was.price, is.price) : String(was.rawPrice) === String(is.rawPrice);
    if (!priceSame) diffs.push(`price ${was.rawPrice} -> ${is.rawPrice}`);
    if (was.count !== is.count) diffs.push(`item_quantity.count ${was.count ?? "none"} -> ${is.count ?? "none"}`);
    const tagWas = sortedTagEntries(was.offerTag);
    const tagIs = sortedTagEntries(is.offerTag);
    if (tagWas !== tagIs) diffs.push(`offer tag {${tagWas}} -> {${tagIs}}`);
    if (diffs.length > 0) {
      result.failed.push(`${label}: offer '${is.id}' differs from on_select (${diffs.join("; ")})`);
    }
  });
  nowByKey.forEach((is, key) => {
    if (!beforeByKey.has(key)) {
      result.failed.push(`${label}: offer '${is.id}' was not applied at on_select`);
    }
  });
  if (ok()) {
    result.passed.push(
      `${label}: ${now.length} applied offer(s) (${idList(now.map((l) => l.id))}) are unchanged from on_select (price, free units, offer tag)`
    );
  }
}
