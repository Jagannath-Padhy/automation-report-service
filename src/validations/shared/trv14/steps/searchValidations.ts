import { Payload, TestResult } from "../../../../types/payload";
import { fetchFlowData, saveFlowData } from "../../../../utils/redisUtils";
import { Trv14FlowProfile } from "../flowProfiles";

// Business rules for search / on_search that the workbench L1 does not cover (L1
// already checks presence, enums, tag code lists and that item location_ids /
// category_ids / fulfillment_ids point into the catalog). Values follow what the
// workbench (ONDC-Official draft-TRV14-2.0.0, commit ca523e5f) generates:
// page 1 is provider-only with PAGINATION_ID + MAX_PAGE_NUMBER, later pages add
// CURRENT_PAGE_NUMBER (not necessarily increasing) and the items.

const ISO_DURATION_RE = /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/;
const HTTP_URL_RE = /^https?:\/\/\S+$/;
const PAGINATION_KEY = "trv14_pagination";
const SEARCH_CATEGORY_KEY = "trv14_search_category";

function tagList(tags: any[] | undefined, code: string): Record<string, string> | undefined {
  const tag = (tags ?? []).find((t: any) => t?.descriptor?.code === code);
  if (!tag) return undefined;
  const out: Record<string, string> = {};
  for (const entry of tag.list ?? []) {
    if (entry?.descriptor?.code) out[entry.descriptor.code] = entry.value;
  }
  return out;
}

function isNonNegativeNumber(value: any): boolean {
  return value !== undefined && value !== null && value !== "" && !isNaN(Number(value)) && Number(value) >= 0;
}

export async function validateTrv14Search(
  element: Payload,
  sessionID: string,
  flowId: string,
  profile: Trv14FlowProfile,
  testResults: TestResult
): Promise<void> {
  const request = element?.jsonRequest;
  const context = request?.context;
  const intent = request?.message?.intent;
  if (!intent) return;

  for (const stop of intent?.fulfillment?.stops ?? []) {
    const range = stop?.time?.range;
    if (range?.start && range?.end) {
      if (Date.parse(range.start) < Date.parse(range.end)) {
        testResults.passed.push("search: fulfillment stop time.range.start is before time.range.end");
      } else {
        testResults.failed.push(
          `search: fulfillment stop time.range.start '${range.start}' must be before time.range.end '${range.end}'`
        );
      }
    }
    const stopCity = stop?.location?.city?.code;
    if (stopCity && context?.location?.city?.code && stopCity !== context.location.city.code) {
      testResults.failed.push(
        `search: fulfillment stop city '${stopCity}' must match context.location.city.code '${context.location.city.code}'`
      );
    }
  }

  const bapTerms = tagList(intent?.tags, "BAP_TERMS");
  if (bapTerms) {
    const feeType = bapTerms.BUYER_FINDER_FEES_TYPE;
    if (feeType === "percent" && !isNonNegativeNumber(bapTerms.BUYER_FINDER_FEES_PERCENTAGE)) {
      testResults.failed.push("search: BAP_TERMS.BUYER_FINDER_FEES_PERCENTAGE must be a number when BUYER_FINDER_FEES_TYPE is 'percent'");
    } else if (feeType === "amount" && !isNonNegativeNumber(bapTerms.BUYER_FINDER_FEES_AMOUNT)) {
      testResults.failed.push("search: BAP_TERMS.BUYER_FINDER_FEES_AMOUNT must be a number when BUYER_FINDER_FEES_TYPE is 'amount'");
    } else if (feeType === "percent" || feeType === "amount") {
      testResults.passed.push(`search: BAP_TERMS buyer finder fee matches its type '${feeType}'`);
    } else {
      testResults.failed.push(`search: BAP_TERMS.BUYER_FINDER_FEES_TYPE must be 'percent' or 'amount', found '${feeType}'`);
    }
    if (bapTerms.SETTLEMENT_WINDOW !== undefined && !ISO_DURATION_RE.test(bapTerms.SETTLEMENT_WINDOW)) {
      testResults.failed.push(`search: BAP_TERMS.SETTLEMENT_WINDOW must be an ISO-8601 duration, found '${bapTerms.SETTLEMENT_WINDOW}'`);
    }
    if (bapTerms.STATIC_TERMS !== undefined && !HTTP_URL_RE.test(bapTerms.STATIC_TERMS)) {
      testResults.failed.push(`search: BAP_TERMS.STATIC_TERMS must be a URL, found '${bapTerms.STATIC_TERMS}'`);
    }
  }

  if (profile.search === "INCREMENTAL_PULL") {
    const register = tagList(intent?.tags, "INCREMENTAL_PULL")?.REGISTER;
    if (register === "true") {
      testResults.passed.push("search: INCREMENTAL_PULL.REGISTER is 'true'");
    } else {
      testResults.failed.push(`search: an incremental-pull search must send INCREMENTAL_PULL.REGISTER 'true', found '${register}'`);
    }
  }

  const category = intent?.category?.descriptor?.code;
  if (category && context?.transaction_id) {
    await saveFlowData(sessionID, flowId, context.transaction_id, SEARCH_CATEGORY_KEY, { code: category });
  }
}

export async function validateTrv14OnSearch(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string,
  testResults: TestResult
): Promise<void> {
  const request = element?.jsonRequest;
  const txnId: string | undefined = request?.context?.transaction_id;
  const catalog = request?.message?.catalog;
  if (!catalog || !txnId) return;
  const providers: any[] = catalog.providers ?? [];
  const providerIds = providers.map((p) => p?.id).sort();
  // Categories and locations a page publishes; later pages must repeat page 1's.
  const catalogShape = JSON.stringify(
    providers.map((p) => ({
      id: p?.id,
      categories: (p?.categories ?? []).map((c: any) => `${c?.id}|${c?.parent_category_id ?? ""}|${c?.descriptor?.code ?? ""}|${c?.descriptor?.name ?? ""}`).sort(),
      locations: (p?.locations ?? []).map((l: any) => `${l?.id}|${l?.gps}|${l?.descriptor?.name ?? ""}`).sort(),
    }))
  );

  // Pagination: the first page fixes PAGINATION_ID, MAX_PAGE_NUMBER and the provider set.
  const pagination = tagList(catalog.tags, "PAGINATION");
  if (!pagination) {
    testResults.failed.push(`on_search (${actionId}): catalog.tags must carry PAGINATION`);
  } else {
    const max = Number(pagination.MAX_PAGE_NUMBER);
    if (!Number.isInteger(max) || max < 1) {
      testResults.failed.push(`on_search (${actionId}): PAGINATION.MAX_PAGE_NUMBER must be a positive integer, found '${pagination.MAX_PAGE_NUMBER}'`);
    }
    const first = await fetchFlowData(sessionID, flowId, txnId, PAGINATION_KEY);
    if (pagination.CURRENT_PAGE_NUMBER === undefined) {
      await saveFlowData(sessionID, flowId, txnId, PAGINATION_KEY, {
        id: pagination.PAGINATION_ID,
        max: pagination.MAX_PAGE_NUMBER,
        providerIds,
        catalogShape,
      });
      testResults.passed.push(`on_search (${actionId}): first page declares PAGINATION_ID '${pagination.PAGINATION_ID}' and MAX_PAGE_NUMBER ${pagination.MAX_PAGE_NUMBER}`);
    } else {
      const current = Number(pagination.CURRENT_PAGE_NUMBER);
      if (!Number.isInteger(current) || current < 1 || (Number.isInteger(max) && current > max)) {
        testResults.failed.push(`on_search (${actionId}): PAGINATION.CURRENT_PAGE_NUMBER must be between 1 and MAX_PAGE_NUMBER ${pagination.MAX_PAGE_NUMBER}, found '${pagination.CURRENT_PAGE_NUMBER}'`);
      } else {
        testResults.passed.push(`on_search (${actionId}): CURRENT_PAGE_NUMBER ${current} is within MAX_PAGE_NUMBER ${max}`);
      }
      if (first) {
        if (first.id !== pagination.PAGINATION_ID) {
          testResults.failed.push(`on_search (${actionId}): PAGINATION_ID '${pagination.PAGINATION_ID}' differs from the first page's '${first.id}'`);
        }
        if (first.max !== pagination.MAX_PAGE_NUMBER) {
          testResults.failed.push(`on_search (${actionId}): MAX_PAGE_NUMBER '${pagination.MAX_PAGE_NUMBER}' differs from the first page's '${first.max}'`);
        }
        if (JSON.stringify(first.providerIds) !== JSON.stringify(providerIds)) {
          testResults.failed.push(`on_search (${actionId}): providers [${providerIds.join(", ")}] differ from the first page's [${(first.providerIds ?? []).join(", ")}]`);
        }
        if (first.catalogShape && first.catalogShape !== catalogShape) {
          testResults.failed.push(`on_search (${actionId}): provider categories/locations differ from the first page's`);
        }
        if (first.id === pagination.PAGINATION_ID && first.max === pagination.MAX_PAGE_NUMBER && JSON.stringify(first.providerIds) === JSON.stringify(providerIds)) {
          testResults.passed.push(`on_search (${actionId}): PAGINATION_ID, MAX_PAGE_NUMBER and providers match the first page`);
        }
      }
    }
  }

  // The catalog must offer the category the search asked for.
  const searched = await fetchFlowData(sessionID, flowId, txnId, SEARCH_CATEGORY_KEY);
  if (searched?.code) {
    const codes = providers.flatMap((p) => (p?.categories ?? []).map((c: any) => c?.descriptor?.code));
    if (codes.includes(searched.code)) {
      testResults.passed.push(`on_search (${actionId}): catalog offers the searched category '${searched.code}'`);
    } else {
      testResults.failed.push(`on_search (${actionId}): catalog has no category with code '${searched.code}' asked for in search`);
    }
  }

  for (const provider of providers) {
    const pid = provider?.id;
    const categoryIds = new Set((provider?.categories ?? []).map((c: any) => c?.id));
    for (const category of provider?.categories ?? []) {
      if (category?.parent_category_id && !categoryIds.has(category.parent_category_id)) {
        testResults.failed.push(`on_search (${actionId}): provider ${pid} category ${category.id} has parent_category_id '${category.parent_category_id}' that is not in the catalog`);
      }
    }

    const items: any[] = provider?.items ?? [];
    const abstractIds = new Set(items.filter((i) => i?.descriptor?.code === "ABSTRACT").map((i) => i.id));
    let itemProblems = 0;
    for (const item of items) {
      const code = item?.descriptor?.code;
      if (code === "ENTRY_PASS" || code === "ADD_ON") {
        if (!abstractIds.has(item?.parent_item_id)) {
          itemProblems++;
          testResults.failed.push(`on_search (${actionId}): ${code} item ${item?.id} must have parent_item_id pointing to an ABSTRACT item, found '${item?.parent_item_id}'`);
        }
        if (!isNonNegativeNumber(item?.price?.value)) {
          itemProblems++;
          testResults.failed.push(`on_search (${actionId}): ${code} item ${item?.id} price.value must be a non-negative number, found '${item?.price?.value}'`);
        }
      }
      const min = item?.quantity?.minimum?.count;
      const max = item?.quantity?.maximum?.count;
      if (min !== undefined && max !== undefined && Number(min) > Number(max)) {
        itemProblems++;
        testResults.failed.push(`on_search (${actionId}): item ${item?.id} quantity.minimum.count ${min} is greater than quantity.maximum.count ${max}`);
      }
      for (const addOn of item?.add_ons ?? []) {
        if (!isNonNegativeNumber(addOn?.price?.value)) {
          itemProblems++;
          testResults.failed.push(`on_search (${actionId}): item ${item?.id} add-on ${addOn?.id} price.value must be a non-negative number, found '${addOn?.price?.value}'`);
        }
      }
    }
    if (items.length > 0 && itemProblems === 0) {
      testResults.passed.push(`on_search (${actionId}): provider ${pid} items have valid parents, prices, quantity ranges and add-ons`);
    }
  }
}
