import assert from "assert";
import { TestResult, Payload } from "../../types/payload";
import logger from "@ondc/automation-logger";
import { validateProviderHolidays } from "./holidayChecks";
import {
  LBNPfeatureFlow,
  LSPfeatureFlow,
  rules,
  validateLBNPFeaturesForFlows,
  validateLSPFeaturesForFlows,
} from "../../utils/constants";
import { fetchData, getTransactionIds, saveData } from "../../utils/redisUtils";

/**
 * Common validation setup that initializes TestResult and extracts basic payload data
 */
export function createBaseValidationSetup(payload: Payload): {
  testResults: TestResult;
  action: string;
  jsonRequest: any;
  jsonResponse: any;
  context: any;
  message: any;
  error: any
} {
  const action = payload?.action.toLowerCase();
  logger.info(`Inside ${action} validations`);

  const testResults: TestResult = {
    response: {},
    passed: [],
    failed: [],
  };

  const { jsonRequest, jsonResponse } = payload;
  if (jsonResponse?.response) testResults.response = jsonResponse?.response;

  const { context, message, error } = jsonRequest;

  return {
    testResults,
    action,
    jsonRequest,
    jsonResponse,
    context,
    message,
    error
  };
}

/**
 * Validates provider holidays - common across all domains
 */
export function validateHolidays(
  message: any,
  context: any,
  action: string,
  testResults: TestResult
): void {
  const contextTimestamp = context?.timestamp;
  const holidays = message?.intent?.provider?.time?.schedule?.holidays;
  validateProviderHolidays(holidays, contextTimestamp, action, testResults);
}

/**
 * Validates LBNP (Logistics Buyer Network Participant) features
 */
export function validateLBNPFeatures(
  flowId: string,
  message: any,
  testResults: TestResult
): void {
  if (LBNPfeatureFlow.includes(flowId)) {
    const intentTags = message?.intent?.tags ? message?.intent?.tags : message?.order?.tags
    const isValid = validateLBNPFeaturesForFlows(flowId, rules, intentTags);
    try {
      assert.ok(
        isValid,
        `Feature code needs to be published in the catalog/tags`
      );
      testResults.passed.push(
        `Feature code in catalog/tags validation passed`
      );
      // return testResults
    } catch (error: any) {
      testResults.failed.push(error.message);
    }
  } else {
    return;
  }
}

/**
 * Validates LSP (Logistics Service Provider) features
 */
export function validateLSPFeatures(
  flowId: string,
  message: any,
  testResults: TestResult
): void {
  if (LSPfeatureFlow.includes(flowId)) {
    const catalogTags = message?.catalog?.tags ? message?.catalog?.tags : message?.order?.tags
    const isValid = validateLSPFeaturesForFlows(flowId, rules, catalogTags);
    try {
      assert.ok(
        isValid,
        `Feature code needs to be published in the catalog/tags`
      );
      testResults.passed.push(
        `Feature code in catalog/tags validation passed`
      );
    } catch (error: any) {
      testResults.failed.push(error.message);
    }
  } else {
    return;
  }
}

/**
 * Validates prepaid payment flow
 */
export function validatePrepaidPaymentFlow(
  flowId: string,
  message: any,
  testResults: TestResult
): void {
  if (flowId === "PREPAID_PAYMENT_FLOW") {
    try {
      assert.ok(
        message?.intent?.payment?.type === "ON-ORDER",
        `Payment type should be ON-ORDER for prepaid payment flow`
      );
      testResults.passed.push(`Payment type validation passed`);
    } catch (error: any) {
      testResults.failed.push(error.message);
    }
  }
}

/**
 * Validates Cash on Delivery (COD) flow
 */
export function validateCODFlow(
  flowId: string,
  message: any,
  testResults: TestResult
): void {
  if (flowId === "CASH_ON_DELIVERY_FLOW") {
    const fulfillmentTags = message?.intent?.fulfillment?.tags;
    const linkedOrderTag = fulfillmentTags?.find(
      (tag: { code: string }) => tag.code === "linked_order"
    );

    // Validate cod_order tag
    // try {
    //   const codOrderTag = linkedOrderTag?.list?.find?.(
    //     (tag: { code: string; value: string }) =>
    //       tag.code === "cod_order" && tag.value.toLowerCase() === "yes"
    //   );

    //   assert.ok(
    //     codOrderTag,
    //     `cod_order tag with value "yes" should be present inside linked_order tag list`
    //   );

    //   testResults.passed.push(`cod_order tag validation passed`);
    // } catch (error: any) {
    //   testResults.failed.push(error.message);
    // }

    // Validate collection_amount tag
    // try {
    //   const collectionTag = linkedOrderTag?.list?.find?.(
    //     (tag: { code: string; value: string }) =>
    //       tag.code === "collection_amount"
    //   );

    //   assert.ok(
    //     collectionTag,
    //     `collection_amount tag should be present inside linked_order tag list`
    //   );

    //   testResults.passed.push(`collection_amount tag validation passed`);
    // } catch (error: any) {
    //   testResults.failed.push(error.message);
    // }
  }
}

/**
 * Validates timestamp relationships
 */
export function validateTimestampRelationship(
  earlierTimestamp: string,
  laterTimestamp: string,
  testResults: TestResult,
  validationMessage: string,
  errorMessage: string
): void {
  try {
    assert.ok(
      earlierTimestamp <= laterTimestamp,
      errorMessage
    );
    testResults.passed.push(validationMessage);
  } catch (error: any) {
    testResults.failed.push(error.message);
  }
}

/**
 * Extracts TAT (Turn Around Time) hours from ISO 8601 duration string
 */
export function extractTATHours(duration: string): number | null {
  if (!duration) return null;

  const daysMatch = duration.match(/P(\d+)D/); // Extracts days (e.g., "P4D")
  const hoursMatch = duration.match(/T(\d+)H/); // Extracts hours (e.g., "T12H")

  const days = daysMatch ? parseInt(daysMatch[1]) * 24 : 0;
  const hours = hoursMatch ? parseInt(hoursMatch[1]) : 0;

  return days + hours;
}

/**
 * Formats date to ISO string (YYYY-MM-DD)
 */
export function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

/**
 * Gets timestamp from duration calculation
 */
export function getTimestampFromDuration(
  date: string | Date,
  duration: string
): Date {
  const baseDate = new Date(date);
  const hours = extractTATHours(duration);
  if (hours !== null) {
    baseDate.setHours(baseDate.getHours() + hours);
  }
  return baseDate;
}

/**
 * Validates that a field matches expected value
 */
export function validateFieldValue(
  actual: any,
  expected: any,
  fieldPath: string,
  testResults: TestResult,
  successMessage?: string
): boolean {
  try {
    assert.strictEqual(actual, expected, `${fieldPath} should be ${expected}`);
    if (successMessage) {
      testResults.passed.push(successMessage);
    }
    return true;
  } catch (error: any) {
    testResults.failed.push(error.message);
    return false;
  }
}

/**
 * Adds default validation message if no validations were run
 */
export function addDefaultValidationMessage(
  testResults: TestResult,
  action: string
): void {
  if (testResults.passed.length < 1 && testResults.failed.length < 1) {
    testResults.passed.push(`Validated ${action}`);
  }
}

/**
 * Tags every passed/failed message pushed inside `fn` with a validation-layer
 * prefix, without requiring each individual check to know about layering.
 * L2 = domain-common (applies regardless of which flow is running).
 * L3 = flow-specific (only meaningful for one particular flow/scenario, e.g.
 * RTO, cancellation reason codes, OOS, COD-gated settlement).
 */
export function tagLayer(
  testResults: TestResult,
  layer: "L2" | "L3",
  fn: () => void
): void {
  const passedStart = testResults.passed.length;
  const failedStart = testResults.failed.length;
  fn();
  for (let i = passedStart; i < testResults.passed.length; i++) {
    testResults.passed[i] = `${layer}: ${testResults.passed[i]}`;
  }
  for (let i = failedStart; i < testResults.failed.length; i++) {
    testResults.failed[i] = `${layer}: ${testResults.failed[i]}`;
  }
}

/**
 * Common search validation that combines multiple validations
 */
export function validateCommonSearch(
  payload: Payload,
  sessionID: string,
  flowId: string
): TestResult {
  const { testResults, action, context, message } = createBaseValidationSetup(payload);

  // Validate holidays
  validateHolidays(message, context, action, testResults);

  // Validate LBNP features
  validateLBNPFeatures(flowId, message, testResults);

  // Validate prepaid payment flow
  validatePrepaidPaymentFlow(flowId, message, testResults);

  // Validate COD flow
  validateCODFlow(flowId, message, testResults);

  // Add default message if no validations ran
  addDefaultValidationMessage(testResults, action);

  return testResults;
}

/**
 * Common OnSearch validation that combines multiple validations
 */
export function validateCommonOnSearch(
  payload: Payload,
  sessionID: string,
  flowId: string
): TestResult {
  const { testResults, action, context, message } = createBaseValidationSetup(payload);

  // Validate LSP features
  validateLSPFeatures(flowId, message, testResults);

  // Add default message if no validations ran
  addDefaultValidationMessage(testResults, action);

  return testResults;
}

/**
 * Validates transaction_id against stored transaction IDs in Redis
 * This validation checks if the transaction ID exists for the same flow
 */
export async function validateTransactionId(
  sessionID: string,
  flowId: string,
  currentTransactionId: string,
  testResults: TestResult
): Promise<void> {
  try {

    if (!currentTransactionId) {
      return;
    }

    // Get all stored transaction IDs for this session and flow from Redis
    const storedTransactionIds = await getTransactionIds(sessionID, flowId);
    if (storedTransactionIds.length === 0) {
      return;
    }

    // Check if current transaction_id matches any stored transaction_id
    const isValidTransactionId = storedTransactionIds.includes(currentTransactionId);

    if (isValidTransactionId) {
      testResults.passed.push(`Transaction ID '${currentTransactionId}' is valid and exists in flow`);
    } else {
      testResults.failed.push(
        `Transaction ID '${currentTransactionId}' is invalid. Expected one of: ${storedTransactionIds.join(', ')}`
      );
    }
  } catch (error: any) {
    logger.error("Error validating transaction ID:", error);
    testResults.failed.push(`Transaction ID validation failed: ${error.message}`);
  }
}

export async function validateSlaMetricsSearch(sessionID: string, transactionId: string, flowId: string, message: any, testResults: TestResult, action: string) {
  try {
    if (flowId === 'ORDER_FLOW_BASE_LINE_SLA_METRICS' && action.toLowerCase() === "search") {
      try {
        const tags = message?.intent?.tags || [];
        const slaTerms = tags.filter((tag: any) => tag.code === 'lbnp_sla_terms');

        const allowedMetrics = [
          'Order_Accept',
          'Pickup_ETA',
          'Delivery_ETA',
          'RTO',
          'Item_MD',
          'MDND'
        ];

        for (const term of slaTerms) {
          const list = term?.list || [];

          const getValue = (code: string) =>
            list.find((entry: any) => entry.code === code)?.value;

          const metric = getValue('metric');
          const baseUnit = getValue('base_unit');
          const baseMin = getValue('base_min');
          const baseMax = getValue('base_max');
          const penaltyMin = getValue('penalty_min');
          const penaltyMax = getValue('penalty_max');
          const penaltyUnit = getValue('penalty_unit');
          const penaltyValue = getValue('penalty_value');

          //  Basic presence checks
          assert.ok(allowedMetrics.includes(metric),
            `Invalid metric "${metric}" found in lbnp_sla_terms`
          );

          assert.ok(
            ['mins', 'percent', 'per_order'].includes(baseUnit),
            `Invalid base_unit "${baseUnit}" for metric ${metric}`
          );

          //  Numeric validations
          const numericFields = { baseMin, baseMax, penaltyMin, penaltyValue };
          for (const [key, val] of Object.entries(numericFields)) {
            assert.ok(
              !isNaN(Number(val)),
              `${key} must be a valid number for metric ${metric}`
            );
          }

          // 3️⃣ Penalty unit must be valid
          assert.ok(
            ['percent', 'per_order'].includes(penaltyUnit),
            `Invalid penalty_unit "${penaltyUnit}" for metric ${metric}`
          );

          // Optional: validate logical ordering (min <= max)
          if (baseMax && baseMin)
            assert.ok(
              Number(baseMin) <= Number(baseMax),
              `base_min should be <= base_max for metric ${metric}`
            );

          if (penaltyMax && penaltyMin)
            assert.ok(
              Number(penaltyMin) <= Number(penaltyMax),
              `penalty_min should be <= penalty_max for metric ${metric}`
            );
        }

        saveData(
          sessionID,
          transactionId,
          "slaTerms",
          slaTerms
        );

        testResults.passed.push(
          'All lbnp_sla_terms entries are valid for ORDER_FLOW_BASE_LINE_SLA_METRICS'
        );
      } catch (error: any) {
        testResults.failed.push(error.message);
      }
    }
  } catch (error: any) {
    testResults.failed.push(error.message);
  }
}

export async function validateSlaMetricsConfirm(sessionID: string, transactionId: string, action_id: string, message: any, testResults: TestResult, action: string) {
  if (action_id === "confirm_LOGISTICS_SLA" || action_id === "on_confirm_LOGISTICS_SLA") {
    try {
      // Fetch saved and current SLA terms
      const savedSlaTerms = await fetchData(sessionID, transactionId, "slaTerms");
      const currentTags = message?.order?.tags || [];
      const currentSlaTerms = currentTags.filter(
        (tag: any) => tag.code === "lbnp_sla_terms"
      );

      assert.ok(
        savedSlaTerms,
        "No saved SLA terms found in Redis for comparison"
      );
      assert.ok(
        currentSlaTerms.length > 0,
        `No lbnp_sla_terms found in ${action} payload`
      );

      // Deep compare each SLA term object
      const allDifferences: any[] = [];

      for (let i = 0; i < currentSlaTerms.length; i++) {
        const saved = savedSlaTerms[i];
        const current = currentSlaTerms[i];

        if (!saved) {
          allDifferences.push({
            key: `slaTerms[${i}]`,
            savedValue: undefined,
            currentValue: current,
          });
          continue;
        }

        const diffs = await deepCompareObjects(saved, current, `slaTerms[${i}]`);
        allDifferences.push(...diffs);
      }

      assert.ok(
        allDifferences.length === 0,
        `SLA Terms mismatch detected:\n${allDifferences
          .map(
            (d) =>
              `→ ${d.key}: expected "${JSON.stringify(
                d.savedValue
              )}", got "${JSON.stringify(d.currentValue)}"`
          )
          .join("\n")}`
      );

      testResults.passed.push(
        "SLA Terms validation passed — all keys and values match saved data."
      );
    } catch (error: any) {
      logger.error(`Error during SLA validation: ${error.message}`);
      testResults.failed.push(error.message);
    }
  }
}

export async function validateNpTaxType(flowId: string, message: any, testResults: TestResult, action: string) {
  try {
    if (flowId === "ORDER_FLOW_RCM") {

      const tags = action.toLowerCase() === "search" ? message?.catalog?.["bpp/descriptor"]?.tags : message?.order?.tags || [];
      const bppTermsTag = tags.find((tag: any) => tag.code === "bpp_terms");

      const npTaxTypeEntry = bppTermsTag?.list?.find(
        (entry: any) => entry.code === "np_tax_type"
      );

      if (!npTaxTypeEntry) return;

      assert.ok(
        npTaxTypeEntry.value === "RCM",
        `np_tax_type value must be "RCM", found "${npTaxTypeEntry.value}"`
      );

      testResults.passed.push(
        'np_tax_type validation passed — value is correctly set to "RCM"'
      );
    }
  } catch (error: any) {
    logger.error(`Error during on_search_LOGISTICS_RCM validation: ${error.message}`);
    testResults.failed.push(error.message);
  }
}

export async function validateCodifiedStaticTerms(
  action_id: string,
  message: any,
  sessionID: string,
  transactionId: string,
  testResults: TestResult,
  action: string
) {
  try {
    const tags = action.toLowerCase() === "search" && action.toLowerCase() === "on_search" ? message?.catalog?.["bpp/descriptor"]?.tags : message?.order?.tags;
    const bppTerms = tags.find(
      (tag: any) => tag.code === "bpp_terms"
    );

    const list = bppTerms?.list || [];

    // Convert list to key-value object for easier validation
    const termsObj = list.reduce((acc: any, entry: any) => {
      acc[entry.code] = entry.value;
      return acc;
    }, {});

    //  Required keys to be present
    const requiredKeys = [
      "max_liability",
      "max_liability_cap",
      "mandatory_arbitration",
      "court_jurisdiction",
      "delay_interest",
    ];

    // Validate on_search_LOGISTICS_CODIFIED_TERMS
    if (action_id === "on_search_LOGISTICS_CODIFIED_TERMS") {
      for (const key of requiredKeys) {
        // Optional — ensure value is not empty
        assert.ok(
          termsObj[key] !== undefined && termsObj[key] !== "",
          `Value for "${key}" cannot be empty in on_search payload`
        );
      }

      // Save validated data to Redis
      await saveData(sessionID, transactionId, "codifiedTerms", list);

      testResults.passed.push(
        "All required codified static terms validated and saved successfully from on_search payload"
      );
    }

    //  Validate on_confirm_LOGISTICS_CODIFIED_TERMS
    else if (action_id === "on_confirm_LOGISTICS_CODIFIED_TERMS") {
      const savedTerms = await fetchData(
        sessionID,
        transactionId,
        "codifiedTerms"
      );

      assert.ok(savedTerms, "No saved codifiedTerms found in Redis");

      const differences = await deepCompareObjects(savedTerms, list);

      assert.ok(
        differences.length === 0,
        `Codified static terms mismatch detected: ${JSON.stringify(
          differences,
          null,
          2
        )}`
      );

      testResults.passed.push(
        "Codified static terms matched successfully between on_search and on_confirm"
      );
    }
  } catch (error: any) {
    logger.error(`Error in codified static terms validation: ${error.message}`);
    testResults.failed.push(error.message);
  }
}

export async function validateCustomerContactDetails(
  action_id: string,
  message: any,
  sessionID: string,
  transactionId: string,
  testResults: TestResult
) {
  try {
    const tags = message?.order?.tags || [];

    // Determine which term to check based on flowId
    const tagCode =
      ['confirm_LOGISTICS_EXCHANGE', 'confirm_LOGISTICS'].includes(action_id)
        ? "bap_terms"
        : ['on_confirm_LOGISTICS_EXCHANGE', 'on_confirm_LOGISTICS'].includes(action_id)
          ? "bpp_terms"
          : "bpp_terms";

    // Extract tag section
    const termsTag = tags.find((tag: any) => tag.code === tagCode);
    if (!termsTag) return;

    const list = termsTag.list || [];
    const phoneEntry = list.find((entry: any) => entry.code === "phone");
    if (!phoneEntry) return;

    const phoneValue = phoneEntry.value;
    testResults.passed.push(
      `Phone number "${phoneValue}" saved successfully from ${tagCode}`
    );

    //  CASE 1: confirm_LOGISTICS_EXCHANGE — Save to Redis
    if (action_id === "confirm_LOGISTICS_EXCHANGE") {
      await saveData(sessionID, transactionId, "exchangePhone", phoneValue);
      testResults.passed.push(
        `Phone number "${phoneValue}" saved successfully from ${tagCode}`
      );
    }

    //  CASE 2: on_confirm_LOGISTICS_EXCHANGE — Compare with saved
    else if (action_id === "on_confirm_LOGISTICS_EXCHANGE") {
      const savedPhone = await fetchData(
        sessionID,
        transactionId,
        "exchangePhone"
      );

      assert.ok(savedPhone, "No saved phone number found in Redis");

      assert.strictEqual(
        savedPhone,
        phoneValue,
        `Phone mismatch: expected "${savedPhone}", got "${phoneValue}"`
      );

      testResults.passed.push(
        `Phone number matched successfully between confirm and on_confirm (${phoneValue})`
      );
    }
  } catch (error: any) {
    logger.error(`Error validating exchange phone term: ${error.message}`);
    testResults.failed.push(error.message);
  }
}

export async function validatePublicSpecialCapabilities(
  flowId: string,
  message: any,
  sessionID: string,
  transactionId: string,
  testResults: TestResult
) {
  try {
    if (flowId === "on_search_LOGISTICS_PUBLIC_SPECIAL") {
      //  Extract provider tags based on action
      const providers = message?.catalog?.["bpp/providers"] || [];
      assert.ok(providers.length > 0, "No providers found in catalog");

      const provider = providers[0]; // Assuming validation for first provider
      const tags = provider?.tags || [];

      //  Find special_req tag
      const specialReqTag = tags.find((t: any) => t.code === "special_req");
      if (!specialReqTag) return;

      const list = specialReqTag.list || [];
      assert.ok(list.length > 0, `"special_req".list must not be empty`);

      //  Convert to key-value for easy validation
      const specialReqMap = list.reduce((acc: any, entry: any) => {
        acc[entry.code] = entry.value;
        return acc;
      }, {});

      // Expected keys
      const expectedKeys = [
        "dangerous_goods",
        "cold_storage",
        "open_box_delivery",
        "fragile_handling",
        "cod_order"
      ];

      // Validate keys and values
      for (const key of expectedKeys) {
        const value = specialReqMap[key]?.toLowerCase();
        assert.ok(
          value === "yes" || value === "no",
          `Invalid value for "${key}". Expected "yes" or "no", got "${specialReqMap[key]}"`
        );
      }

      //  Save validated data in Redis for later comparison if needed
      await saveData(sessionID, transactionId, "specialCapabilities", specialReqMap);

      testResults.passed.push(
        `All special capabilities validated successfully in on_search payload`
      );
    }
  } catch (error: any) {
    logger.error(`Error validating special capabilities: ${error.message}`);
    testResults.failed.push(error.message);
  }
}

export async function validateSellerCreds(
  flowId: string,
  message: any,
  sessionID: string,
  transactionId: string,
  testResults: TestResult
) {
  try {
    if (flowId === "ORDER_FLOW_BASE_LINE_SELLER_CREDS") {
      const fulfillments = message?.order?.fulfillments || [];
      assert.ok(fulfillments.length > 0, "No fulfillments found in order");

      for (const fulfillment of fulfillments) {
        const tags = fulfillment?.tags || [];

        // 🔍 Find the "linked_provider" tag
        const linkedProviderTag = tags.find(
          (tag: any) => tag.code === "linked_provider"
        );
        if (!linkedProviderTag) continue;

        const list = linkedProviderTag.list || [];

        // Required codes that must exist
        const requiredCodes = ["id", "name", "cred_code", "cred_desc"];

        // Check all required codes exist and are valid
        for (const code of requiredCodes) {
          const entry = list.find((item: any) => item.code === code);
          if (!entry) continue;

          assert.ok(
            typeof entry.value === "string" && entry.value.trim() !== "",
            `Value for "${code}" under linked_provider.list must be a non-empty string`
          );
        }

        // Convert list to object (preserving any extra codes too)
        const providerData = list.reduce((acc: any, item: any) => {
          acc[item.code] = item.value;
          return acc;
        }, {});

        // Save validated data for future comparison (optional)
        await saveData(
          sessionID,
          transactionId,
          `sellerCreds_${fulfillment.type}`,
          providerData
        );
      }

      testResults.passed.push(
        `Seller credentials (linked_provider) validated successfully`
      );
    }
  } catch (error: any) {
    logger.error(`Error in validateSellerCreds: ${error.message}`);
    testResults.failed.push(error.message);
  }
}

export async function validateEpodProofs(
  flowId: string,
  message: any,
  testResults: any
) {
  try {
    if (flowId === "E-POD") {
      const fulfillments = message?.order?.fulfillments || [];
      assert.ok(fulfillments.length > 0, "No fulfillments found in order");

      const allowedTypes = ["webp", "jpeg", "png", "pdf"];

      for (const fulfillment of fulfillments) {
        const tags = fulfillment?.tags || [];
        const proofTags = tags.filter((tag: any) => tag.code === "fulfillment_proof");

        for (const proofTag of proofTags) {
          const list = proofTag?.list || [];

          // Required fields inside list
          const requiredFields = ["state", "type", "url"];

          for (const field of requiredFields) {
            const entry = list.find((item: any) => item.code === field);
            if (!entry) continue;

            assert.ok(
              typeof entry.value === "string" && entry.value.trim() !== "",
              `Value for "${field}" must be a non-empty string`
            );

            // Validate type enums
            if (field === "type") {
              assert.ok(
                allowedTypes.includes(entry.value.toLowerCase()),
                `Invalid type "${entry.value}". Must be one of ${allowedTypes.join(
                  ", "
                )}`
              );
            }
          }
        }
      }

      testResults.passed.push(
        `All fulfillment_proof tags validated successfully under E-POD flow`
      );
    }
  } catch (error: any) {
    logger.error(`Error in validateEpodProofs: ${error.message}`);
    testResults.failed.push(error.message);
  }
}

export function validateP2H2PRequirements(
  context: any,
  message: any,
  testResults: TestResult,
  action: string
) {
  if (context?.domain !== "ONDC:LOG11") return;
}


export async function deepCompareObjects(saved: any, current: any, parentKey = "") {
  const differences = [];

  const allKeys = new Set([
    ...Object.keys(saved || {}),
    ...Object.keys(current || {}),
  ]);

  for (const key of allKeys) {
    const fullKey = parentKey ? `${parentKey}.${key}` : key;
    const savedValue = saved?.[key];
    const currentValue = current?.[key];

    const bothObjects =
      savedValue &&
      currentValue &&
      typeof savedValue === "object" &&
      typeof currentValue === "object" &&
      !Array.isArray(savedValue) &&
      !Array.isArray(currentValue);

    if (bothObjects) {
      // Recursively compare nested objects
      const nestedDiffs: any = deepCompareObjects(savedValue, currentValue, fullKey);
      differences.push(...nestedDiffs);
    } else if (JSON.stringify(savedValue) !== JSON.stringify(currentValue)) {
      // Record mismatch if value differs or missing
      differences.push({
        key: fullKey,
        savedValue,
        currentValue,
      });
    }
  }

  return differences;
}



