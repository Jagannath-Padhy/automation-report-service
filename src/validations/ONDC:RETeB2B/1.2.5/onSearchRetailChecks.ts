import { TestResult } from "../../../types/payload";
import {
  HHMM,
  failureGate,
  itemLabel,
  providerLabel,
  tagGroupsByCode,
  tagValue,
} from "./onSearchB2BChecks";

// Checks ported from log-validation-utility's retail on_search validator
// (utils/Retail_.1.2.5/Search/on_search.ts), adapted for eB2B.
//
// Rules deliberately NOT ported because they false-fail a compliant eB2B catalog
// are listed in docs/RETeB2B-on_search-broadcast-validations.md §5.

const ISO8601_DURATION = /^P(?!$)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/;
const DESCRIPTOR_CODE = /^([1-5]):(.+)$/;
const SERVICEABILITY_TYPES = new Set(["10", "11", "12", "13"]);
const VEG_NONVEG_CODES = new Set(["veg", "non_veg", "egg"]);
const CATEGORY_TYPES = new Set(["custom_menu", "custom_group", "variant_group"]);

function dayOnly(value: any): string | null {
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function isNumericString(value: any): boolean {
  return value !== undefined && value !== null && /^[+-]?\d+(\.\d+)?$/.test(String(value));
}

function reportDuplicates(
  ids: any[],
  label: string,
  context: string,
  result: TestResult
): void {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) {
    if (id === undefined || id === null) continue;
    const key = String(id);
    if (seen.has(key)) dupes.add(key);
    seen.add(key);
  }
  for (const dupe of dupes) {
    result.failed.push(`on_search: ${context} has duplicate ${label} '${dupe}'`);
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export function validateOnSearchContext(context: any, result: TestResult): void {
  const cleanRun = failureGate(result);

  if (context?.transaction_id && context.transaction_id === context.message_id) {
    result.failed.push("on_search: context.transaction_id and context.message_id must differ");
  }

  for (const key of ["bap_id", "bpp_id"]) {
    const value = context?.[key];
    if (typeof value === "string" && /^(https?:\/\/|www\.)/i.test(value.trim())) {
      result.failed.push(
        `on_search: context.${key} '${value}' must be a subscriber id, not a URL`
      );
    }
  }

  if (context?.ttl !== undefined && !ISO8601_DURATION.test(String(context.ttl))) {
    result.failed.push(
      `on_search: context.ttl '${context.ttl}' is not a valid ISO-8601 duration`
    );
  }

  if (cleanRun()) {
    result.passed.push(
      `on_search: context ids distinct, subscriber ids well-formed, ttl '${context?.ttl}' valid`
    );
  }
}

// ---------------------------------------------------------------------------
// Catalog level
// ---------------------------------------------------------------------------

export function validateBppDescriptorTerms(catalog: any, result: TestResult): void {
  const descriptor = catalog?.["bpp/descriptor"];
  if (!descriptor) {
    result.failed.push("on_search: catalog['bpp/descriptor'] is required");
    return;
  }

  const cleanRun = failureGate(result);
  const bppTermsGroups = tagGroupsByCode(descriptor?.tags, "bpp_terms");

  if (bppTermsGroups.length === 0) {
    result.failed.push("on_search: catalog['bpp/descriptor'] is missing its bpp_terms tag group");
    return;
  }

  let npType: string | undefined;
  for (const group of bppTermsGroups) {
    npType = npType ?? tagValue(group.list, "np_type");

    // `accept_bap_terms` is a Y/N flag here, NOT a forbidden field.
    //
    // This used to read "bpp_terms must not contain accept_bap_terms", ported from the B2C
    // retail validator. It contradicted the eB2B contract and a reference payload at once:
    //   - the contract's broadcast /on_search example sends
    //     bpp_terms = [{np_type: "MSN"}, {accept_bap_terms: "Y"}]
    //     (ONDC eB2B Concept and API Contract, the bpp/descriptor block — see
    //      docs/RETeB2B-search-contract-audit.md §3.1 #1 for the exact citation);
    //   - Order_to_confirm_to_fulfillment_with_offers(Prepaid)'s on_search sends exactly
    //     that, so the rule reported a false failure on a compliant catalog.
    // It only ever stayed quiet because the deep catalog path in OnSearch.ts is scoped to
    // Discovery_flow_broadcast_search, whose catalog happens to omit the flag. Widening that
    // scope would have surfaced it immediately.
    //
    // Both flags are validated the same way: present-and-meaningful, or absent.
    for (const flag of ["accept_bap_terms", "collect_payment"]) {
      const value = tagValue(group.list, flag);
      if (value !== undefined && value !== "Y" && value !== "N") {
        result.failed.push(
          `on_search: bpp_terms ${flag} '${value}' must be 'Y' or 'N'`
        );
      }
    }
  }

  if (!npType || !String(npType).trim()) {
    result.failed.push("on_search: bpp_terms is missing np_type");
  }

  if (cleanRun()) {
    result.passed.push(`on_search: bpp_terms valid (np_type '${npType}')`);
  }
}

export function validateProviderUniqueness(providers: any[], result: TestResult): void {
  const cleanRun = failureGate(result);
  reportDuplicates(
    providers.map((provider: any) => provider?.id),
    "provider id",
    "catalog",
    result
  );
  if (cleanRun()) {
    result.passed.push(`on_search: all ${providers.length} provider id(s) are unique`);
  }
}

// ---------------------------------------------------------------------------
// Provider level
// ---------------------------------------------------------------------------

export function validateProviderTimestamps(
  provider: any,
  contextTimestamp: any,
  result: TestResult
): void {
  if (!contextTimestamp) return;
  const cleanRun = failureGate(result);
  const ceiling = new Date(String(contextTimestamp)).getTime();
  if (Number.isNaN(ceiling)) return;

  const providerTs = provider?.time?.timestamp;
  if (providerTs && new Date(String(providerTs)).getTime() > ceiling) {
    result.failed.push(
      `on_search: ${providerLabel(provider)} time.timestamp '${providerTs}' is later than context.timestamp '${contextTimestamp}'`
    );
  }

  let late = 0;
  for (const item of provider?.items || []) {
    const itemTs = item?.time?.timestamp;
    if (itemTs && new Date(String(itemTs)).getTime() > ceiling) {
      late++;
      result.failed.push(
        `on_search: ${providerLabel(provider)} ${itemLabel(item)} time.timestamp '${itemTs}' is later than context.timestamp`
      );
    }
  }

  if (cleanRun() && late === 0) {
    result.passed.push(
      `on_search: ${providerLabel(provider)} provider and item timestamps are not later than context.timestamp`
    );
  }
}

export function validateProviderEntityUniqueness(provider: any, result: TestResult): void {
  const cleanRun = failureGate(result);
  const label = providerLabel(provider);

  reportDuplicates((provider?.locations || []).map((l: any) => l?.id), "location id", label, result);
  reportDuplicates((provider?.categories || []).map((c: any) => c?.id), "category id", label, result);
  reportDuplicates((provider?.items || []).map((i: any) => i?.id), "item id", label, result);
  reportDuplicates((provider?.fulfillments || []).map((f: any) => f?.id), "fulfillment id", label, result);
  reportDuplicates((provider?.offers || []).map((o: any) => o?.id), "offer id", label, result);

  if (cleanRun()) {
    result.passed.push(
      `on_search: ${label} location/category/item/fulfillment/offer ids are all unique`
    );
  }
}

export function validateProviderLocations(
  provider: any,
  contextTimestamp: any,
  result: TestResult
): void {
  const locations = provider?.locations || [];
  if (locations.length === 0) return;

  const cleanRun = failureGate(result);
  const label = providerLabel(provider);
  const todayKey = contextTimestamp ? dayOnly(contextTimestamp) : null;

  for (const location of locations) {
    const locLabel = `${label} location ${location?.id ?? "?"}`;

    const days = location?.time?.days;
    if (days !== undefined) {
      for (const raw of String(days).split(",")) {
        const day = parseInt(raw.trim(), 10);
        if (Number.isNaN(day) || day < 1 || day > 7) {
          result.failed.push(`on_search: ${locLabel} time.days entry '${raw.trim()}' must be 1-7`);
        }
      }
    }

    const range = location?.time?.range;
    if (range) {
      const start = String(range.start ?? "");
      const end = String(range.end ?? "");
      if (!HHMM.test(start) || !HHMM.test(end) || start > end) {
        result.failed.push(
          `on_search: ${locLabel} time.range '${start}'-'${end}' must be HHMM (0000-2359) and ordered`
        );
      }
    }

    // Compared date-only: a holiday dated today is still upcoming even though
    // its midnight timestamp precedes a mid-day context.timestamp.
    const holidays = location?.time?.schedule?.holidays;
    if (todayKey && Array.isArray(holidays)) {
      for (const holiday of holidays) {
        const holidayKey = dayOnly(holiday);
        if (!holidayKey) {
          result.failed.push(`on_search: ${locLabel} holiday '${holiday}' is not a valid date`);
        } else if (holidayKey < todayKey) {
          result.failed.push(
            `on_search: ${locLabel} holiday '${holidayKey}' is in the past relative to context.timestamp (${todayKey})`
          );
        }
      }
    }
  }

  if (cleanRun()) {
    result.passed.push(
      `on_search: ${label} all ${locations.length} location(s) have valid days/hours and no past holidays`
    );
  }
}

export function validateFulfillmentContacts(provider: any, result: TestResult): void {
  const fulfillments = provider?.fulfillments || [];
  if (fulfillments.length === 0) return;

  const cleanRun = failureGate(result);
  const label = providerLabel(provider);
  let withContact = 0;

  for (const fulfillment of fulfillments) {
    const contact = fulfillment?.contact;
    if (!contact) continue;
    withContact++;

    const phone = contact.phone === undefined ? undefined : String(contact.phone).replace(/\D/g, "");
    if (phone !== undefined && !/^\d{10,11}$/.test(phone)) {
      result.failed.push(
        `on_search: ${label} fulfillment ${fulfillment?.id} contact.phone '${contact.phone}' must be 10 or 11 digits`
      );
    }

    if (contact.email !== undefined && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(contact.email))) {
      result.failed.push(
        `on_search: ${label} fulfillment ${fulfillment?.id} contact.email '${contact.email}' is not a valid email`
      );
    }
  }

  if (withContact > 0 && cleanRun()) {
    result.passed.push(
      `on_search: ${label} all ${withContact} fulfillment contact(s) have a valid phone/email`
    );
  }
}

export function validateCategoryTags(provider: any, result: TestResult): void {
  const categories = provider?.categories || [];
  if (categories.length === 0) return;

  const cleanRun = failureGate(result);
  const label = providerLabel(provider);

  for (const category of categories) {
    const catLabel = `${label} category ${category?.id ?? "?"}`;

    for (const group of tagGroupsByCode(category?.tags, "type")) {
      const type = tagValue(group.list, "type");
      if (type !== undefined && !CATEGORY_TYPES.has(type)) {
        result.failed.push(
          `on_search: ${catLabel} tag type '${type}' must be one of ${[...CATEGORY_TYPES].join(", ")}`
        );
      }
    }

    for (const group of tagGroupsByCode(category?.tags, "attr")) {
      const name = tagValue(group.list, "name");
      const seq = tagValue(group.list, "seq");
      if (!name || !String(name).trim()) {
        result.failed.push(`on_search: ${catLabel} attr tag is missing its name`);
      }
      if (seq !== undefined && !/^\d+$/.test(String(seq))) {
        result.failed.push(`on_search: ${catLabel} attr tag seq '${seq}' must be a positive integer`);
      }
    }

    const images = category?.descriptor?.images;
    if (Array.isArray(images) && images.length === 0) {
      result.failed.push(`on_search: ${catLabel} descriptor.images must not be an empty array`);
    }
  }

  if (cleanRun()) {
    result.passed.push(`on_search: ${label} all ${categories.length} category tag group(s) valid`);
  }
}

export function validateServiceabilityConstructs(provider: any, result: TestResult): void {
  const groups = tagGroupsByCode(provider?.tags, "serviceability");
  if (groups.length === 0) return;

  const cleanRun = failureGate(result);
  const label = providerLabel(provider);
  const locationIds = new Set((provider?.locations || []).map((l: any) => l?.id).filter(Boolean));
  const seen = new Set<string>();

  for (const group of groups) {
    const fingerprint = JSON.stringify(group.list);
    if (seen.has(fingerprint)) {
      result.failed.push(`on_search: ${label} has a duplicate serviceability construct`);
    }
    seen.add(fingerprint);

    if (!Array.isArray(group.list) || group.list.length < 5) {
      result.failed.push(
        `on_search: ${label} serviceability construct must have at least 5 entries, found ${group.list?.length ?? 0}`
      );
      continue;
    }

    const location = tagValue(group.list, "location");
    if (!location || (locationIds.size > 0 && !locationIds.has(location))) {
      result.failed.push(
        `on_search: ${label} serviceability references location '${location}' which is not a declared provider location`
      );
    }

    const type = tagValue(group.list, "type");
    const val = tagValue(group.list, "val");
    const unit = tagValue(group.list, "unit");

    if (!type || !SERVICEABILITY_TYPES.has(type)) {
      result.failed.push(
        `on_search: ${label} serviceability type '${type}' must be one of ${[...SERVICEABILITY_TYPES].join(", ")}`
      );
      continue;
    }

    if (type === "10") {
      if (!isNumericString(val)) {
        result.failed.push(`on_search: ${label} hyperlocal serviceability val '${val}' must be numeric`);
      }
      if (unit !== "km") {
        result.failed.push(`on_search: ${label} hyperlocal serviceability unit '${unit}' must be 'km'`);
      }
    } else if (type === "11") {
      if (unit !== "pincode") {
        result.failed.push(`on_search: ${label} intercity serviceability unit '${unit}' must be 'pincode'`);
      }
      const pincodes = String(val ?? "").split(/[,-]/).map((p) => p.trim()).filter(Boolean);
      if (pincodes.length === 0 || pincodes.some((p) => !/^\d{6}$/.test(p))) {
        result.failed.push(
          `on_search: ${label} intercity serviceability val '${val}' must be a list of 6-digit pincodes`
        );
      }
    } else if (type === "12") {
      if (val !== "IND") {
        result.failed.push(`on_search: ${label} PAN-India serviceability val '${val}' must be 'IND'`);
      }
      if (unit !== "country") {
        result.failed.push(`on_search: ${label} PAN-India serviceability unit '${unit}' must be 'country'`);
      }
    } else if (type === "13") {
      if (unit !== "geojson") {
        result.failed.push(`on_search: ${label} polygon serviceability unit '${unit}' must be 'geojson'`);
      }
      try {
        JSON.parse(String(val));
      } catch (_) {
        result.failed.push(`on_search: ${label} polygon serviceability val is not parseable GeoJSON`);
      }
    }
  }

  if (cleanRun()) {
    const types = [...new Set(groups.map((g) => tagValue(g.list, "type")).filter(Boolean))];
    result.passed.push(
      `on_search: ${label} all ${groups.length} serviceability construct(s) well-formed (type: ${types.join(", ")})`
    );
  }
}

export function validateServiceabilityCoverage(provider: any, result: TestResult): void {
  const groups = tagGroupsByCode(provider?.tags, "serviceability");
  if (groups.length === 0) return;

  const cleanRun = failureGate(result);
  const label = providerLabel(provider);

  const covered = new Set(groups.map((g) => tagValue(g.list, "category")).filter(Boolean));
  if (covered.has("*")) {
    result.passed.push(
      `on_search: ${label} serviceability declares a '*' wildcard, covering all item categories`
    );
    return;
  }

  const itemCategories = new Set(
    (provider?.items || []).map((item: any) => item?.category_id).filter(Boolean)
  );

  for (const category of itemCategories) {
    if (!covered.has(category as string)) {
      result.failed.push(
        `on_search: ${label} item category '${category}' has no serviceability construct`
      );
    }
  }

  if (itemCategories.size > 0 && cleanRun()) {
    result.passed.push(
      `on_search: ${label} all ${itemCategories.size} item category(ies) are covered by a serviceability construct`
    );
  }
}

/**
 * At least one `timing` group of type `Order` is mandatory. A provider with NO timing groups
 * used to return silently, so the most common form of the defect was the one never flagged
 * (the Vistar tester's V3, docs/RETeB2B-vistar-seller-tester-coverage.md Finding 3). Every
 * full spec catalog declares Order and Delivery timing.
 */
export function validateOrderTimingPresence(provider: any, result: TestResult): void {
  const groups = tagGroupsByCode(provider?.tags, "timing");
  if (groups.length === 0) {
    result.failed.push(
      `on_search: ${providerLabel(provider)} declares no 'timing' tag groups — at least one timing construct of type 'Order' is mandatory`
    );
    return;
  }

  const types = groups.map((g) => tagValue(g.list, "type")).filter(Boolean);
  if (!types.includes("Order")) {
    result.failed.push(
      `on_search: ${providerLabel(provider)} must declare at least one timing construct of type 'Order' (found: ${types.join(", ") || "none"})`
    );
    return;
  }

  result.passed.push(`on_search: ${providerLabel(provider)} declares a mandatory 'Order' timing construct`);
}

// ---------------------------------------------------------------------------
// Item level
// ---------------------------------------------------------------------------

export function validateItemDescriptors(items: any[] | undefined, result: TestResult): void {
  if (!Array.isArray(items) || items.length === 0) return;
  const cleanRun = failureGate(result);

  for (const item of items) {
    const descriptor = item?.descriptor;
    for (const field of ["short_desc", "long_desc"]) {
      const value = descriptor?.[field];
      if (value === undefined || !String(value).trim()) {
        result.failed.push(`on_search: ${itemLabel(item)} descriptor.${field} must not be empty`);
      }
    }

    const code = descriptor?.code;
    if (code !== undefined && !DESCRIPTOR_CODE.test(String(code))) {
      result.failed.push(
        `on_search: ${itemLabel(item)} descriptor.code '${code}' must be '<type>:<code>' with type 1-5 (1-EAN, 2-ISBN, 3-GTIN, 4-HSN, 5-others)`
      );
    }
  }

  if (cleanRun()) {
    result.passed.push(
      `on_search: all ${items.length} item descriptor(s) have short_desc/long_desc and a well-formed code`
    );
  }
}

export function validateItemLocationRefs(provider: any, result: TestResult): void {
  const items = provider?.items || [];
  if (items.length === 0) return;

  const cleanRun = failureGate(result);
  const locationIds = new Set((provider?.locations || []).map((l: any) => l?.id).filter(Boolean));
  if (locationIds.size === 0) return;

  let referencing = 0;
  for (const item of items) {
    if (item?.location_id === undefined || item.location_id === null) continue;
    referencing++;
    if (!locationIds.has(item.location_id)) {
      result.failed.push(
        `on_search: ${providerLabel(provider)} ${itemLabel(item)} references location_id '${item.location_id}' which is not a declared provider location`
      );
    }
  }

  if (referencing > 0 && cleanRun()) {
    result.passed.push(
      `on_search: ${providerLabel(provider)} all ${referencing} item location_id reference(s) resolve to declared locations [${[...locationIds].join(", ")}]`
    );
  }
}

export function validateItemPriceBounds(items: any[] | undefined, result: TestResult): void {
  if (!Array.isArray(items) || items.length === 0) return;
  const cleanRun = failureGate(result);
  let compared = 0;

  for (const item of items) {
    const value = parseFloat(String(item?.price?.value ?? ""));
    const maximum = item?.price?.maximum_value;
    if (maximum === undefined || Number.isNaN(value)) continue;

    const max = parseFloat(String(maximum));
    if (Number.isNaN(max)) continue;
    compared++;

    if (value > max) {
      result.failed.push(
        `on_search: ${itemLabel(item)} price.value (${value}) exceeds price.maximum_value (${max})`
      );
    }
  }

  if (compared > 0 && cleanRun()) {
    result.passed.push(
      `on_search: price.value within price.maximum_value for all ${compared} item(s)`
    );
  }
}

export function validateItemMaximumCount(items: any[] | undefined, result: TestResult): void {
  if (!Array.isArray(items) || items.length === 0) return;
  const cleanRun = failureGate(result);
  let checked = 0;

  for (const item of items) {
    const raw = item?.quantity?.maximum?.count;
    if (raw === undefined || raw === null) continue;
    checked++;

    const max = parseInt(String(raw), 10);
    if (Number.isNaN(max) || max <= 0) {
      result.failed.push(
        `on_search: ${itemLabel(item)} quantity.maximum.count '${raw}' must be greater than 0`
      );
    }
  }

  if (checked > 0 && cleanRun()) {
    result.passed.push(`on_search: quantity.maximum.count is positive for all ${checked} item(s)`);
  }
}

export function validateMandatoryItemTags(items: any[] | undefined, result: TestResult): void {
  if (!Array.isArray(items) || items.length === 0) return;
  const cleanRun = failureGate(result);

  for (const item of items) {
    const originGroup = tagGroupsByCode(item?.tags, "origin")[0];
    if (!originGroup) {
      result.failed.push(`on_search: ${itemLabel(item)} is missing its mandatory 'origin' tag`);
    } else if (!tagValue(originGroup.list, "country")) {
      result.failed.push(`on_search: ${itemLabel(item)} origin tag is missing its country`);
    }

    if (tagGroupsByCode(item?.tags, "attribute").length === 0) {
      result.failed.push(`on_search: ${itemLabel(item)} is missing its mandatory 'attribute' tag`);
    }

    for (const group of tagGroupsByCode(item?.tags, "veg_nonveg")) {
      for (const entry of group.list || []) {
        if (entry?.code && !VEG_NONVEG_CODES.has(entry.code)) {
          result.failed.push(
            `on_search: ${itemLabel(item)} veg_nonveg code '${entry.code}' must be one of ${[...VEG_NONVEG_CODES].join(", ")}`
          );
        }
      }
    }
  }

  if (cleanRun()) {
    result.passed.push(
      `on_search: all ${items.length} item(s) carry mandatory origin/attribute tags with valid veg_nonveg codes`
    );
  }
}

export function validateReplacementTerms(items: any[] | undefined, result: TestResult): void {
  if (!Array.isArray(items) || items.length === 0) return;
  const cleanRun = failureGate(result);
  let checked = 0;

  for (const item of items) {
    const terms = item?.replacement_terms;
    if (terms === undefined) continue;
    checked++;

    if (!Array.isArray(terms) || terms.length === 0) {
      result.failed.push(
        `on_search: ${itemLabel(item)} replacement_terms must be a non-empty array when present`
      );
      continue;
    }

    for (const term of terms) {
      const duration = term?.replace_within?.duration;
      if (!duration || !ISO8601_DURATION.test(String(duration))) {
        result.failed.push(
          `on_search: ${itemLabel(item)} replacement_terms replace_within.duration '${duration}' is not a valid ISO-8601 duration`
        );
      }
    }
  }

  if (checked === 0) {
    result.passed.push("on_search: no replacement_terms declared on items — nothing to validate");
    return;
  }

  if (cleanRun()) {
    result.passed.push(`on_search: replacement_terms valid for all ${checked} item(s)`);
  }
}

export function validateItemStatutoryFields(items: any[] | undefined, result: TestResult): void {
  if (!Array.isArray(items) || items.length === 0) return;
  const cleanRun = failureGate(result);

  // Only the fields that are always applicable are required. Import-only fields
  // (importer_FSSAI_license_no, other_FSSAI_license_no, imported_product_*) are
  // legitimately blank for domestic goods — the spec's own example leaves them empty.
  const PREPACKAGED_REQUIRED = [
    "nutritional_info",
    "additives_info",
    "brand_owner_FSSAI_license_no",
  ];
  const COMMODITIES_REQUIRED = [
    "manufacturer_or_packer_name",
    "manufacturer_or_packer_address",
    "common_or_generic_name_of_commodity",
    "month_year_of_manufacture_packing_import",
  ];

  let checked = 0;

  for (const item of items) {
    const food = item?.["@ondc/org/statutory_reqs_prepackaged_food"];
    if (food && typeof food === "object") {
      checked++;
      for (const field of PREPACKAGED_REQUIRED) {
        if (!food[field] || !String(food[field]).trim()) {
          result.failed.push(
            `on_search: ${itemLabel(item)} statutory_reqs_prepackaged_food.${field} must not be empty`
          );
        }
      }
    }

    const commodities = item?.["@ondc/org/statutory_reqs_packaged_commodities"];
    if (commodities && typeof commodities === "object") {
      checked++;
      for (const field of COMMODITIES_REQUIRED) {
        if (!commodities[field] || !String(commodities[field]).trim()) {
          result.failed.push(
            `on_search: ${itemLabel(item)} statutory_reqs_packaged_commodities.${field} must not be empty`
          );
        }
      }
    }
  }

  if (checked === 0) {
    result.passed.push("on_search: no statutory declarations on items — nothing to validate");
    return;
  }

  if (cleanRun()) {
    result.passed.push(
      `on_search: statutory declarations complete across ${checked} item declaration(s)`
    );
  }
}

// ---------------------------------------------------------------------------
// Offers (structural + cross-reference only; per-offer-type rules deferred)
// ---------------------------------------------------------------------------

export function validateOffers(provider: any, result: TestResult): void {
  const offers = provider?.offers;
  if (offers === undefined) return;

  const label = providerLabel(provider);

  if (!Array.isArray(offers)) {
    result.failed.push(`on_search: ${label} offers must be an array`);
    return;
  }
  if (offers.length === 0) {
    result.passed.push(`on_search: ${label} declares no offers — nothing to validate`);
    return;
  }

  const cleanRun = failureGate(result);
  const itemIds = new Set((provider?.items || []).map((i: any) => i?.id).filter(Boolean));
  const locationIds = new Set((provider?.locations || []).map((l: any) => l?.id).filter(Boolean));
  const itemCategories = new Set(
    (provider?.items || []).map((i: any) => i?.category_id).filter(Boolean)
  );

  for (const offer of offers) {
    const offerLabel = `${label} offer ${offer?.id ?? "?"}`;

    if (!offer?.id || !String(offer.id).trim()) {
      result.failed.push(`on_search: ${label} offer is missing its id`);
    }
    if (!offer?.descriptor?.code || !String(offer.descriptor.code).trim()) {
      result.failed.push(`on_search: ${offerLabel} is missing descriptor.code (the offer type)`);
    }

    for (const [field, declared, kind] of [
      ["location_ids", locationIds, "location"],
      ["item_ids", itemIds, "item"],
    ] as Array<[string, Set<any>, string]>) {
      const refs = offer?.[field];
      if (!Array.isArray(refs) || refs.length === 0) {
        result.failed.push(`on_search: ${offerLabel} ${field} must be a non-empty array`);
        continue;
      }
      for (const ref of refs) {
        if (declared.size > 0 && !declared.has(ref)) {
          result.failed.push(
            `on_search: ${offerLabel} ${field} references ${kind} '${ref}' which is not declared by this provider`
          );
        }
      }
    }

    // category_ids is legitimately empty for item-scoped offers; only validate entries present.
    for (const category of offer?.category_ids || []) {
      if (itemCategories.size > 0 && !itemCategories.has(category)) {
        result.failed.push(
          `on_search: ${offerLabel} category_ids references '${category}' which is not an item category`
        );
      }
    }

    if (!offer?.time?.label || !String(offer.time.label).trim()) {
      result.failed.push(`on_search: ${offerLabel} time.label is required`);
    }
    const start = offer?.time?.range?.start;
    const end = offer?.time?.range?.end;
    if (!start || !end) {
      result.failed.push(`on_search: ${offerLabel} time.range must declare both start and end`);
    } else {
      const startMs = new Date(String(start)).getTime();
      const endMs = new Date(String(end)).getTime();
      if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
        result.failed.push(`on_search: ${offerLabel} time.range '${start}'-'${end}' is not a valid date range`);
      } else if (startMs > endMs) {
        result.failed.push(`on_search: ${offerLabel} time.range start '${start}' is later than end '${end}'`);
      }
    }

    const metaGroup = tagGroupsByCode(offer?.tags, "meta")[0];
    if (!metaGroup) {
      result.failed.push(`on_search: ${offerLabel} is missing its meta tag group`);
    } else {
      for (const field of ["additive", "auto"]) {
        const value = tagValue(metaGroup.list, field);
        if (value !== "yes" && value !== "no") {
          result.failed.push(
            `on_search: ${offerLabel} meta.${field} '${value}' must be 'yes' or 'no'`
          );
        }
      }
    }

    // Discount magnitudes are expressed as negatives in ONDC.
    const benefitGroup = tagGroupsByCode(offer?.tags, "benefit")[0];
    if (benefitGroup) {
      for (const field of ["value", "value_cap"]) {
        const raw = tagValue(benefitGroup.list, field);
        if (raw === undefined) continue;
        const parsed = parseFloat(String(raw));
        if (Number.isNaN(parsed)) {
          result.failed.push(`on_search: ${offerLabel} benefit.${field} '${raw}' is not numeric`);
        } else if (parsed > 0) {
          result.failed.push(
            `on_search: ${offerLabel} benefit.${field} '${raw}' must be negative (discounts are expressed as negatives)`
          );
        }
      }

      const benefitItemId = tagValue(benefitGroup.list, "item_id");
      if (benefitItemId && itemIds.size > 0 && !itemIds.has(benefitItemId)) {
        result.failed.push(
          `on_search: ${offerLabel} benefit.item_id '${benefitItemId}' is not a declared item`
        );
      }
    }
  }

  if (cleanRun()) {
    const codes = offers.map((o: any) => o?.descriptor?.code).filter(Boolean);
    result.passed.push(
      `on_search: ${label} all ${offers.length} offer(s) structurally valid with resolved item/location refs (${codes.join(", ")})`
    );
  }
}
