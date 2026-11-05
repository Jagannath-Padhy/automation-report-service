/**
 * Ported custom (business-logic) validations for ONDC:RET11 (F&B) on_search,
 * sourced from log-validation-utility/utils/Retail/RET11_onSearch/{onSearch.ts,
 * fb_calculation/default_selection/*}.
 *
 * Schema validation (AJV in the source) is intentionally NOT ported — it's
 * replaced by runExternalSchemaAndL1Validation, which calls this project's
 * own live L0 (schema) + L1 (JVAL) validator. Only checks schema can't
 * express are kept here.
 *
 * RET11's `search` (buyer request) is domain-agnostic in the source
 * (log-validation-utility/utils/Retail/Search/search.ts has no RET1X
 * branching) — it is covered by the already-ported validateRet10Search and
 * does not need its own RET11 implementation. Only on_search is RET11-specific
 * here, driven by F&B combo/customization pricing rules not present for RET10.
 *
 * The source's fb_calculation/lower_upper_range module (price-range
 * calculation) is NOT ported: it is fully commented out in onSearch.ts itself
 * (dead code, never invoked) — only fb_calculation/default_selection is live
 * and ported below. Likewise fb_calculation/default_selection/class.ts's Tree
 * class is unused by onSearch.ts (only the plain functions in utils.ts are
 * imported) and is not ported.
 */

import { Payload, TestResult } from "../../../types/payload";
import { createBaseValidationSetup, addDefaultValidationMessage, tagLayer } from "../commonValidations";
import { runExternalSchemaAndL1Validation } from "../externalSchemaValidator";

// ---------------------------------------------------------------------------
// Generic helpers (duplicated locally rather than imported from
// ret10SearchValidations.ts, which doesn't export them and is owned by a
// sibling porting pass — keep this file self-contained).

const DECIMAL_PRECISION = 6;

function getDecimalPrecision(value: string): number {
  const parts = String(value).split(".");
  return parts.length > 1 ? parts[1].length : 0;
}

function checkGpsPrecision(coordinates: string | undefined): boolean {
  if (!coordinates || typeof coordinates !== "string" || !coordinates.includes(",")) return false;
  try {
    const [lat, long] = coordinates.split(",");
    return getDecimalPrecision(lat) >= DECIMAL_PRECISION && getDecimalPrecision(long) >= DECIMAL_PRECISION;
  } catch {
    return false;
  }
}

function isValidPhoneNumber(value: string | undefined): boolean {
  if (!value) return false;
  let v = value.trim();
  if (v.startsWith("0")) v = v.substring(1);
  return /^(\d{10}|\d{11})$/.test(v);
}

function emailRegex(value: string | undefined): boolean {
  if (!value) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// ---------------------------------------------------------------------------
// fb_calculation/default_selection port (TreeNode build + default-selection
// price reconciliation). Ported faithfully from the source's plain functions.

interface TreeNode {
  is_base_item: boolean;
  base_item?: {
    item_id: string;
    item_value: number;
    item_maximum_value: number;
    default_selection?: { min: number; max: number };
    range: { lower: number; upper: number };
  };
  custom_item?: {
    custom_group_id: string;
    customization_id: string;
    value: number;
    maximum_value: number;
    config: { min: number; max: number };
    default_select: boolean;
  };
  custom_groups?: string[];
  children?: TreeNode[];
}

type CustomGroup = {
  id: string;
  name: string;
  type: string;
  config: { min: string | null; max: string | null; seq: string | null };
};

function getMinMaxById(groups: CustomGroup[], id: string): { min: string | null; max: string | null } | null {
  const group = groups.find((g) => g.id.toLowerCase() === id.toLowerCase());
  return group ? { min: group.config.min, max: group.config.max } : null;
}

function mapItemToTreeNode(items: any[]): TreeNode[] {
  const baseItems = (items || []).filter((item: any) => {
    if (!item.tags || !Array.isArray(item.tags)) return false;
    return item.tags.some(
      (tag: any) =>
        tag.code === "type" &&
        Array.isArray(tag.list) &&
        tag.list.some((sub: any) => sub.code === "type" && sub.value === "item")
    );
  });

  return baseItems.map((item: any) => {
    const custom_groups: string[] = [];
    if (item.tags) {
      const cgTag = item.tags.find((tag: any) => tag.code === "custom_group");
      if (cgTag && Array.isArray(cgTag.list)) {
        cgTag.list.forEach((e: any) => custom_groups.push(e.value));
      }
    }

    let default_selection: { min: number; max: number } | undefined;
    let range = { lower: 0, upper: 0 };
    if (item.price && Array.isArray(item.price.tags)) {
      for (const tag of item.price.tags) {
        if (tag.code === "default_selection") {
          const minVal = tag.list.find((x: any) => x.code === "value")?.value;
          const maxVal = tag.list.find((x: any) => x.code === "maximum_value")?.value;
          if (minVal && maxVal) default_selection = { min: parseFloat(minVal), max: parseFloat(maxVal) };
        } else if (tag.code === "range") {
          const lowerVal = tag.list.find((x: any) => x.code === "lower")?.value;
          const upperVal = tag.list.find((x: any) => x.code === "upper")?.value;
          if (lowerVal && upperVal) range = { lower: parseFloat(lowerVal), upper: parseFloat(upperVal) };
        }
      }
    }

    return {
      is_base_item: true,
      base_item: {
        item_id: item.id,
        item_value: parseFloat(item.price?.value),
        item_maximum_value: parseFloat(item.price?.maximum_value),
        default_selection,
        range,
      },
      custom_groups,
      children: [],
    } as TreeNode;
  });
}

function extractCustomGroups(categories: any[]): CustomGroup[] {
  const result: CustomGroup[] = [];
  (categories || []).forEach((category: any) => {
    const typeTag = category.tags?.find((tag: any) => tag.code === "type");
    const typeValue = typeTag?.list.find((item: any) => item.code === "type")?.value;
    if (typeValue === "custom_group") {
      const configTag = category.tags.find((tag: any) => tag.code === "config");
      const configList = configTag?.list || [];
      const min = configList.find((item: any) => item.code === "min")?.value;
      const max = configList.find((item: any) => item.code === "max")?.value;
      const seq = configList.find((item: any) => item.code === "seq")?.value;
      result.push({
        id: category.id,
        name: category.descriptor?.name,
        type: typeValue,
        config: { min: min || null, max: max || null, seq: seq || null },
      });
    }
  });
  return result;
}

function mapCustomItemToTreeNode(items: any[], customGroupCategory: CustomGroup[]): TreeNode[] {
  const customItems = (items || []).filter((item: any) => {
    if (!item.tags || !Array.isArray(item.tags)) return false;
    return item.tags.some(
      (tag: any) =>
        tag.code === "type" &&
        Array.isArray(tag.list) &&
        tag.list.some((sub: any) => sub.code === "type" && sub.value === "customization")
    );
  });

  const uniqueNodes = new Map<string, TreeNode>();
  customItems.forEach((item: any) => {
    let parentId: string | undefined;
    let customGroups: string[] = [];
    let childGroups: string[] = [];
    let isDefault = false;

    if (Array.isArray(item.tags)) {
      for (const tag of item.tags) {
        if (tag.code === "custom_group" && Array.isArray(tag.list)) {
          customGroups = tag.list.map((e: any) => e.value);
        } else if (tag.code === "parent" && Array.isArray(tag.list)) {
          const parentEntry = tag.list.find((e: any) => e.code === "id");
          if (parentEntry) parentId = parentEntry.value;
          const defaultEntry = tag.list.find((e: any) => e.code === "default" && e.value === "yes");
          isDefault = !!defaultEntry;
        } else if (tag.code === "child" && Array.isArray(tag.list)) {
          childGroups = tag.list.map((e: any) => e.value);
        }
      }
    }

    if (parentId) {
      const config = getMinMaxById(customGroupCategory, parentId);
      const key = `${item.id}-${parentId}`;
      if (!uniqueNodes.has(key)) {
        uniqueNodes.set(key, {
          is_base_item: false,
          custom_item: {
            custom_group_id: parentId,
            customization_id: item.id,
            value: parseFloat(item.price?.value || "0"),
            maximum_value: parseFloat(item.price?.maximum_value || "0"),
            config: { min: Number(config?.min) || 0, max: Number(config?.max) || 0 },
            default_select: isDefault,
          },
          custom_groups: [...new Set([...customGroups, ...childGroups])],
          children: [],
        });
      }
    }
  });
  return Array.from(uniqueNodes.values());
}

function mapCustomizationsToBaseItems(baseItems: TreeNode[], customItems: TreeNode[]): TreeNode[] {
  const customizationMap = new Map<string, TreeNode[]>();
  customItems.forEach((cust) => {
    if (cust.custom_item) {
      const parentId = cust.custom_item.custom_group_id;
      if (!customizationMap.has(parentId)) customizationMap.set(parentId, []);
      customizationMap.get(parentId)!.push(cust);
    }
  });

  function attachChildren(node: TreeNode) {
    if (node.custom_groups) {
      node.children = node.children || [];
      node.custom_groups.forEach((groupId) => {
        if (customizationMap.has(groupId)) {
          const children = customizationMap.get(groupId)!;
          node.children!.push(...children);
          children.forEach(attachChildren);
        }
      });
    }
  }

  baseItems.forEach(attachChildren);
  return baseItems;
}

function calculateDefaultSelectionPrice(items: TreeNode[]) {
  function traverse(item: TreeNode): { totalMin: number; totalMax: number } {
    let totalMin = 0;
    let totalMax = 0;
    if (item.is_base_item) {
      if (item.base_item?.default_selection) {
        totalMin += item.base_item.item_value;
        totalMax += item.base_item.item_maximum_value;
      }
    } else if (item.custom_item?.default_select === true) {
      totalMin += item.custom_item.value;
      totalMax += item.custom_item.maximum_value;
    }
    if ((item.is_base_item || item.custom_item?.default_select) && item.children?.length) {
      for (const child of item.children) {
        const sub = traverse(child);
        totalMin += sub.totalMin;
        totalMax += sub.totalMax;
      }
    }
    return { totalMin, totalMax };
  }

  const out: Array<{
    base_item: string | undefined;
    default_selection_calculated: { min: number; max: number };
    default_selection_actual: { min: number; max: number } | undefined;
  }> = [];
  for (const item of items) {
    const { totalMin, totalMax } = traverse(item);
    out.push({
      base_item: item.base_item?.item_id,
      default_selection_calculated: { min: totalMin, max: totalMax },
      default_selection_actual: item.base_item?.default_selection,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------

export async function validateRet11OnSearch(
  element: Payload,
  _sessionID: string,
  _flowId: string,
  _actionId: string
): Promise<TestResult> {
  const { testResults, action, jsonRequest, context, message } = createBaseValidationSetup(element);

  await runExternalSchemaAndL1Validation(jsonRequest, testResults);

  const onSearchCatalog = message?.catalog;
  if (!onSearchCatalog || !onSearchCatalog["bpp/providers"]) {
    addDefaultValidationMessage(testResults, action);
    return testResults;
  }

  const providers = onSearchCatalog["bpp/providers"];
  const prvdrsId = new Set<string>();
  const prvdrLocId = new Set<string>();
  const itemsId = new Set<string>();
  const onSearchFFIdsArray: Array<Set<string>> = [];
  const onSearchFFTypeSet = new Set<string>();

  // Duplicate provider id / fulfillment id collection (mirrors RET10's port).
  tagLayer(testResults, "L2", () => {
    providers.forEach((provider: any) => {
      if (prvdrsId.has(provider.id)) {
        testResults.failed.push(`on_search: duplicate provider id ${provider.id} in bpp/providers`);
      } else {
        prvdrsId.add(provider.id);
        testResults.passed.push(`on_search: provider id ${provider.id} is unique in bpp/providers`);
      }
      const ffIds = new Set<string>();
      (provider.fulfillments || []).forEach((ff: any) => {
        onSearchFFTypeSet.add(ff.type);
        ffIds.add(ff.id);
      });
      onSearchFFIdsArray.push(ffIds);
    });
  });

  providers.forEach((provider: any, i: number) => {
    const items = provider.items || [];
    tagLayer(testResults, "L2", () => {
    // Store enable/disable timestamp sanity.
    if (provider.time?.timestamp && context?.timestamp) {
      const providerTime = new Date(provider.time.timestamp).getTime();
      const contextTimestamp = new Date(context.timestamp).getTime();
      if (providerTime > contextTimestamp) {
        testResults.failed.push(
          `on_search: bpp/providers[${i}]/time/timestamp (store enable/disable) must be <= context.timestamp`
        );
      } else {
        testResults.passed.push(
          `on_search: bpp/providers[${i}]/time/timestamp (store enable/disable) is <= context.timestamp`
        );
      }
    }

    // Location GPS precision + duplicate location id + store day/timing sanity.
    (provider.locations || []).forEach((loc: any, iter: number) => {
      if (loc.gps) {
        if (!checkGpsPrecision(loc.gps)) {
          testResults.failed.push(
            `on_search: bpp/providers[${i}]/locations[${iter}]/gps must have at least 6 decimal places of precision`
          );
        } else {
          testResults.passed.push(
            `on_search: bpp/providers[${i}]/locations[${iter}]/gps has sufficient decimal precision`
          );
        }
      }
      if (loc.id) {
        if (prvdrLocId.has(loc.id)) {
          testResults.failed.push(`on_search: duplicate location id ${loc.id} in bpp/providers[${i}]/locations`);
        } else {
          prvdrLocId.add(loc.id);
          testResults.passed.push(`on_search: location id ${loc.id} is unique in bpp/providers[${i}]/locations`);
        }
      }
      const days = (loc.time?.days || "").split(",").filter(Boolean);
      days.forEach((d: string) => {
        const day = parseInt(d, 10);
        if (isNaN(day) || day < 1 || day > 7) {
          testResults.failed.push(
            `on_search: bpp/providers[${i}]/locations[${iter}]/time/days must list days 1-7 (Monday-Sunday)`
          );
        } else {
          testResults.passed.push(
            `on_search: bpp/providers[${i}]/locations[${iter}]/time/days value '${d}' is a valid day (1-7)`
          );
        }
      });
    });

    // Item id duplicate check + fulfillment_id / location_id membership.
    items.forEach((item: any, j: number) => {
      if (itemsId.has(item.id)) {
        testResults.failed.push(`on_search: duplicate item id ${item.id} in bpp/providers[${i}]`);
      } else {
        itemsId.add(item.id);
        testResults.passed.push(`on_search: item id ${item.id} is unique in bpp/providers[${i}]`);
      }
      if (item.fulfillment_id) {
        if (!onSearchFFIdsArray[i]?.has(item.fulfillment_id)) {
          testResults.failed.push(
            `on_search: items[${j}].fulfillment_id "${item.fulfillment_id}" must match a fulfillment id in bpp/providers[${i}]/fulfillments`
          );
        } else {
          testResults.passed.push(
            `on_search: items[${j}].fulfillment_id matches a fulfillment id in bpp/providers[${i}]/fulfillments`
          );
        }
      }
      if (item.location_id) {
        if (!prvdrLocId.has(item.location_id)) {
          testResults.failed.push(
            `on_search: items[${j}].location_id "${item.location_id}" must match a location id in bpp/providers[${i}]/locations`
          );
        } else {
          testResults.passed.push(
            `on_search: items[${j}].location_id matches a location id in bpp/providers[${i}]/locations`
          );
        }
      }
      if (item["@ondc/org/contact_details_consumer_care"]) {
        const parts = String(item["@ondc/org/contact_details_consumer_care"]).split(",");
        if (parts.length < 3 || !emailRegex(parts[1]?.trim()) || isNaN(Number(parts[2]?.trim()))) {
          testResults.failed.push(
            `on_search: items[${j}]/@ondc/org/contact_details_consumer_care must be "name,email,contactno"`
          );
        } else {
          testResults.passed.push(
            `on_search: items[${j}]/@ondc/org/contact_details_consumer_care is "name,email,contactno"`
          );
        }
      }
    });

    // Fulfillment contact phone number sanity (mirrors source's per-category check).
    (provider.fulfillments || []).forEach((ff: any, idx: number) => {
      if (ff.contact?.phone) {
        if (!isValidPhoneNumber(ff.contact.phone)) {
          testResults.failed.push(
            `on_search: bpp/providers[${i}]/fulfillments[${idx}]/contact/phone must be a valid 10 or 11 digit number`
          );
        } else {
          testResults.passed.push(
            `on_search: bpp/providers[${i}]/fulfillments[${idx}]/contact/phone is valid`
          );
        }
      }
    });
    }); // end L2

    tagLayer(testResults, "L3", () => {
    // --- F&B-specific: customization config.min/max count checks on items ---
    items.forEach((item: any) => {
      const customGroup = item.custom_group;
      if (customGroup?.config?.min === 1) {
        const defaults = (item.customizations || []).filter((c: any) => c.is_default);
        if (defaults.length < 1) {
          testResults.failed.push(
            `on_search: item ${item.id} must have at least one default customization (config.min=1)`
          );
        } else {
          testResults.passed.push(
            `on_search: item ${item.id} has at least one default customization (config.min=1)`
          );
        }
      }
      if (customGroup?.config?.max === 2) {
        const count = (item.customizations || []).length;
        if (count > 2) {
          testResults.failed.push(`on_search: item ${item.id} has more than 2 customizations (config.max=2)`);
        } else {
          testResults.passed.push(`on_search: item ${item.id} has at most 2 customizations (config.max=2)`);
        }
      }
    });

    // --- F&B-specific: default-selection price reconciliation ---
    try {
      const categories = provider.categories || [];
      const customGroupCategory = extractCustomGroups(categories);
      const baseTreeNodes = mapItemToTreeNode(items);
      const customItemNodes = mapCustomItemToTreeNode(items, customGroupCategory);
      const mapped = mapCustomizationsToBaseItems(baseTreeNodes, customItemNodes);
      const defaultSelection = calculateDefaultSelectionPrice(mapped);

      defaultSelection.forEach(({ base_item, default_selection_calculated, default_selection_actual }) => {
        if (!default_selection_actual) return;
        if (
          default_selection_calculated.min !== default_selection_actual.min ||
          default_selection_calculated.max !== default_selection_actual.max
        ) {
          testResults.failed.push(
            `on_search: provider ${provider.id} item ${base_item} default_selection price mismatch — ` +
              `calculated min=${default_selection_calculated.min}/max=${default_selection_calculated.max}, ` +
              `given min=${default_selection_actual.min}/max=${default_selection_actual.max}`
          );
        } else {
          testResults.passed.push(
            `on_search: provider ${provider.id} item ${base_item} default_selection price matches calculated min/max`
          );
        }
      });
    } catch (e: any) {
      testResults.failed.push(
        `on_search: error computing default_selection price for provider ${provider.id} — ${e?.message || e}`
      );
    }

    // --- F&B-specific: customization group min/max element-count reconciliation ---
    try {
      const customGroupDetails: Record<string, { min: number; max: number; numberOfDefaults: number; numberOfElements: number }> = {};
      (provider.categories || []).forEach((category: any) => {
        const customGroupTag = category.tags?.find(
          (tag: any) => tag.code === "type" && tag.list?.some((item: any) => item.value === "custom_group")
        );
        if (customGroupTag) {
          const configTag = category.tags.find((tag: any) => tag.code === "config");
          const min = configTag ? parseInt(configTag.list.find((i: any) => i.code === "min")?.value, 10) : 0;
          const max = configTag ? parseInt(configTag.list.find((i: any) => i.code === "max")?.value, 10) : 0;
          if (min > max) {
            testResults.failed.push(`on_search: category ${category.id} has config.min > config.max`);
          } else {
            testResults.passed.push(`on_search: category ${category.id} has config.min <= config.max`);
          }
          customGroupDetails[category.id] = { min, max, numberOfDefaults: 0, numberOfElements: 0 };
        }
      });

      items.forEach((item: any) => {
        const typeTag = item.tags?.find((tag: any) => tag.code === "type");
        const typeValue = typeTag?.list?.find((l: any) => l.code === "type")?.value;
        if (typeValue === "customization") {
          const parentTag = item.tags.find((tag: any) => tag.code === "parent");
          const groupId = parentTag?.list?.find((l: any) => l.code === "id")?.value;
          if (groupId && customGroupDetails[groupId]) {
            customGroupDetails[groupId].numberOfElements += 1;
            const defaultParent = parentTag.list.find((l: any) => l.code === "default" && l.value === "yes");
            if (defaultParent) customGroupDetails[groupId].numberOfDefaults += 1;
          }
        }
      });

      Object.entries(customGroupDetails).forEach(([id, group]) => {
        if (group.max > 0) {
          if (group.numberOfElements < group.max) {
            testResults.failed.push(
              `on_search: customization group ${id} has fewer elements (${group.numberOfElements}) than its configured max (${group.max})`
            );
          } else {
            testResults.passed.push(
              `on_search: customization group ${id} has at least its configured max (${group.max}) elements`
            );
          }
        }
        if (group.min > 0) {
          if (group.numberOfDefaults < group.min) {
            testResults.failed.push(
              `on_search: customization group ${id} has fewer defaults (${group.numberOfDefaults}) than its configured min (${group.min})`
            );
          } else {
            testResults.passed.push(
              `on_search: customization group ${id} has at least its configured min (${group.min}) defaults`
            );
          }
        }
      });
    } catch (e: any) {
      testResults.failed.push(`on_search: error reconciling customization group counts — ${e?.message || e}`);
    }
    }); // end L3

    tagLayer(testResults, "L2", () => {
    // Simplified serviceability-construct presence check (mirrors RET10's port).
    const tags = provider.tags || [];
    const serviceabilityEntries = tags.filter((t: any) => t.code === "serviceability");
    if (serviceabilityEntries.length === 0) {
      testResults.failed.push(`on_search: bpp/providers[${i}]/tags must include a serviceability construct`);
    } else {
      testResults.passed.push(`on_search: bpp/providers[${i}]/tags includes a serviceability construct`);
    }
    });
  });

  addDefaultValidationMessage(testResults, action);
  return testResults;
}
