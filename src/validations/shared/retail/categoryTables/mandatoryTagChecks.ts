// Ported from log-validation-utility/utils/index.ts (checkMandatoryTags,
// checkForStatutory, getStatutoryRequirement, and the isCustomizationItem
// helper they depend on). Adapted to push directly into a TestResult's
// `failed` array instead of mutating an `errorObj` map, matching the rest
// of this service's convention.

import { statutory_reqs } from "./statutoryEnum";
import { groceryCategoryMappingWithStatutory } from "./category";

export function isCustomizationItem(item: any): boolean {
  if (!item?.tags || !Array.isArray(item.tags)) return false;
  return item.tags.some((tag: any) => {
    if (tag.code !== "type" || !Array.isArray(tag.list)) return false;
    return tag.list.some((listItem: any) => listItem.code === "type" && listItem.value === "customization");
  });
}

/**
 * Checks each item's `attribute`/`origin` tags against a category->mandatory-tag
 * JSON table (one of groceryJSON/fashion/BPCJSON/electronicsData/applianceData/
 * homeJSON/healthJSON). Pushes a failure message per problem found.
 */
export function checkMandatoryTags(
  providerIndex: string | number,
  items: any[],
  failed: string[],
  categoryJSON: any,
  categoryName: string
): void {
  (items || []).forEach((item: any, index: number) => {
    const isCustomization = isCustomizationItem(item);

    let attributeTag: any = null;
    let originTag: any = null;
    for (const tag of item.tags || []) {
      originTag = tag.code === "origin" ? tag : originTag;
      attributeTag = tag.code === "attribute" ? tag : attributeTag;
    }

    if (!originTag && !isCustomization) {
      failed.push(
        `on_search: bpp/providers[${providerIndex}]/items[${index}] is missing origin tag fields (required for ${categoryName})`
      );
    }

    if (!attributeTag && categoryName !== "Grocery" && !isCustomization) {
      failed.push(
        `on_search: bpp/providers[${providerIndex}]/items[${index}] is missing attribute tag fields (required for ${categoryName})`
      );
      return;
    }

    if (!attributeTag) return;

    const tags = attributeTag.list || [];
    const categoryId = item.category_id;

    if (!categoryJSON || !Object.prototype.hasOwnProperty.call(categoryJSON, categoryId)) {
      failed.push(
        `on_search: bpp/providers[${providerIndex}]/items[${index}] has an invalid category_id (${categoryId}) for ${categoryName}`
      );
      return;
    }

    const mandatoryTags = categoryJSON[categoryId];
    const missingMandatoryTags: string[] = [];
    tags.forEach((tag: { code: string }) => {
      if (!mandatoryTags[tag.code]) missingMandatoryTags.push(tag.code);
    });
    if (missingMandatoryTags.length > 0) {
      failed.push(
        `on_search: bpp/providers[${providerIndex}]/items[${index}] has invalid attribute(s) for category ${categoryId}: ${missingMandatoryTags.join(", ")}`
      );
    }

    for (const tagName in mandatoryTags) {
      if (!Object.prototype.hasOwnProperty.call(mandatoryTags, tagName)) continue;
      const tagInfo = mandatoryTags[tagName];
      if (!tagInfo?.mandatory) continue;

      let tagValue: any = null;
      let originalTag: any = null;
      const tagFound = tags.some((tag: any) => {
        const match = tag.code === tagName.toLowerCase();
        if (match) {
          tagValue = tag.value;
          originalTag = tag.value;
        }
        return match;
      });

      if (!tagFound) {
        failed.push(
          `on_search: bpp/providers[${providerIndex}]/items[${index}] is missing mandatory tag '${tagName.toLowerCase()}' (required for ${categoryName})`
        );
        continue;
      }

      if (!tagInfo.value || !tagInfo.value.length) continue;

      let isValidValue = false;
      let regexPattern = "";
      if (Array.isArray(tagInfo.value)) {
        isValidValue = tagInfo.value.includes(originalTag) || tagInfo.value.includes(tagValue);
      } else if (typeof tagInfo.value === "string" && tagInfo.value.startsWith("/") && tagInfo.value.endsWith("/")) {
        regexPattern = tagInfo.value.slice(1, -1);
        const regex = new RegExp(regexPattern);
        isValidValue = regex.test(originalTag) || regex.test(tagValue);
      }
      if (!isValidValue) {
        failed.push(
          `on_search: bpp/providers[${providerIndex}]/items[${index}] tag '${tagName}' has invalid value '${originalTag}' — must match the allowed values/pattern for ${categoryName}`
        );
      }
    }
  });
}

const STATUTORY_REQUIRED_FIELDS: Record<string, string[]> = {
  [statutory_reqs.PrepackagedFood]: [
    "nutritional_info",
    "additives_info",
    "brand_owner_FSSAI_license_no",
    "other_FSSAI_license_no",
    "importer_FSSAI_license_no",
  ],
  [statutory_reqs.PackagedCommodities]: [
    "manufacturer_or_packer_name",
    "manufacturer_or_packer_address",
    "common_or_generic_name_of_commodity",
    "month_year_of_manufacture_packing_import",
  ],
};

/** RET10 (Grocery)-only, matching the original source's own gating. */
export function getStatutoryRequirement(categoryId: string): statutory_reqs | undefined {
  return (groceryCategoryMappingWithStatutory as Record<string, statutory_reqs>)[categoryId];
}

export function checkForStatutory(
  item: any,
  providerIndex: number,
  itemIndex: number,
  failed: string[],
  statutoryReq: statutory_reqs
): void {
  const data = item?.[statutoryReq];
  const requiredFields = STATUTORY_REQUIRED_FIELDS[statutoryReq];
  if (data && typeof data === "object") {
    (requiredFields || []).forEach((field) => {
      if (typeof data[field] !== "string" || data[field].trim() === "") {
        failed.push(
          `on_search: bpp/providers[${providerIndex}]/items[${itemIndex}]/'${statutoryReq}'/${field} is missing or not a string`
        );
      }
    });
  } else {
    failed.push(
      `on_search: bpp/providers[${providerIndex}]/items[${itemIndex}] is missing the required '${statutoryReq}' statutory block`
    );
  }
}
