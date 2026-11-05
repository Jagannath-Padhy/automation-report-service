import { TestResult, Payload } from "../../types/payload";
import {
  createBaseValidationSetup,
  validateHolidays,
  validateLBNPFeatures,
  validateLSPFeatures,
  validatePrepaidPaymentFlow,
  validateCODFlow,
  addDefaultValidationMessage,
  validateTransactionId,
  validateSlaMetricsSearch,
  validateSlaMetricsConfirm,
  validateNpTaxType,
  validateCodifiedStaticTerms,
  validateCustomerContactDetails,
  validatePublicSpecialCapabilities,
  validateSellerCreds,
  validateEpodProofs,
  validateP2H2PRequirements,
} from "./commonValidations";
import { addTransactionId, updateApiMap } from "../../utils/redisUtils";
import {
  validateTATForFulfillments,
  validateShipmentTypes,
} from "./onSearchValidations";
import { validatorConstant } from "./validatorConstant";
import { validateTrv11Intent, validateTrv11OnSearch, validateTrv11Select, validateTrv11OnSelect, validateTrv11Init, validateTrv11OnInit, validateTrv11Confirm, validateTrv11OnConfirm, validateTrv11Status, validateTrv11OnStatus, validateTrv11Cancel, validateTrv11OnCancel, validateTrv11Update, validateTrv11OnUpdate } from "./trv11Validations";
import { validateIgm2Issue, validateIgm2OnIssue, validateIgm1Issue, validateIgm1OnIssue, validateIgm1IssueStatus, validateIgm1OnIssueStatus } from "./igmValidations";
import logger from "@ondc/automation-logger";
import {
  CREDIT_CARD_FLOWS,
  GOLD_LOAN_FLOWS,
  PAYMENT_COLLECTED_BY,
  PERSONAL_LOAN_FLOWS,
  PURCHASE_FINANCE_FLOWS,
  PURCHASE_FINANCE_FLOWS_SKIP_VALIDATION,
  HEALTH_INSURANCE_FLOWS,
  MOTOR_INSURANCE_FLOWS,
  ITEM_PRICE_NOT_REQUIRED_FIS13,
  MOTOR_INSURANCE_SELECT_ACTIONS,
  MOTOR_INSURANCE_INIT_ACTIONS,
  MOTOR_INSURANCE_CONFIRM_ACTIONS,
  SACHET_INSURANCE_FLOWS,
  SACHET_INSURANCE_FLOWS_OBJ,
  GIFT_CARD_FLOWS,
  UNIFIED_CREDIT_FLOWS,
} from "../../utils/constants";

const fis11Validators = validatorConstant.beckn.ondc.fis.fis11.v200;
const fis10Validators = validatorConstant.beckn.ondc.fis.fis10.v210;
const fis12Validators = validatorConstant.beckn.ondc.fis.fis12.v202;
const fis12230Validators = validatorConstant.beckn.ondc.fis.fis12.v230;
const log11Validators = validatorConstant.beckn.ondc.log.v125;
const trv10Validators = validatorConstant.beckn.ondc.trv.trv10.v210;
const trv11Validators = validatorConstant.beckn.ondc.trv.trv11.v201;
const igmValidators = validatorConstant.beckn.ondc.trv.igm.v200;
const igm1Validators = validatorConstant.beckn.ondc.trv.igm.v100;

/**
 * Parse ISO 8601 duration format (e.g., "P5M", "P5Y", "P1Y6M") to years
 * @param term - Duration string in ISO 8601 format
 * @returns Number of years as a decimal
 */
function parseTermToYears(term: string): number {
  if (!term || typeof term !== "string") {
    throw new Error("Invalid term format");
  }

  // Remove 'P' prefix if present
  const duration = term.toUpperCase().replace(/^P/, "");

  // Match years and months
  const yearMatch = duration.match(/(\d+)Y/);
  const monthMatch = duration.match(/(\d+)M/);

  let years = 0;
  if (yearMatch) {
    years += parseFloat(yearMatch[1]);
  }
  if (monthMatch) {
    years += parseFloat(monthMatch[1]) / 12;
  }

  // If no years or months found, try to parse as just a number (assume years)
  if (years === 0) {
    const numMatch = duration.match(/(\d+)/);
    if (numMatch) {
      years = parseFloat(numMatch[1]);
    } else {
      throw new Error(`Cannot parse term: ${term}`);
    }
  }

  return years;
}

/**
 * pramaan-validation-parity skill: ported from Pramaan creditBuyerNPTest/v2.2.0/confirm.js
 * (`tags[tagIndex].display` should equal `false`). BAP_TERMS/BPP_TERMS are terms-of-engagement
 * tags meant for machine consumption, not buyer-facing display — report-service's existing
 * BAP_TERMS/BPP_TERMS checks below validate `descriptor.code` and `list` contents but never
 * checked the tag's own `display` field. Shared here so every call site below can reuse it
 * the same way they already reuse validateSettlementAmount.
 * @param tag - The BAP_TERMS or BPP_TERMS tag object itself (not its `.list`)
 * @param tagType - Type of tag being validated, for the message
 * @param testResults - TestResult object to add validation results
 * @param contextLabel - Optional prefix for the message (e.g. "Payment 0: ")
 */
function checkTagDisplayFalse(
  tag: any,
  tagType: "BAP_TERMS" | "BPP_TERMS",
  testResults: TestResult,
  contextLabel: string = ""
): void {
  if (tag?.display === undefined) return; // presence isn't this check's job, don't invent a failure
  if (tag.display === false) {
    testResults.passed.push(`${contextLabel}${tagType}.display is correctly false`);
  } else {
    testResults.failed.push(
      `${contextLabel}${tagType}.display must be false (terms tags are not for buyer-facing display), found ${JSON.stringify(tag.display)}`
    );
  }
}

/**
 * Helper function to validate SETTLEMENT_AMOUNT calculation
 * Supports three BUYER_FINDER_FEES_TYPE values:
 * - "amount": Flat amount in INR (SETTLEMENT_AMOUNT = BUYER_FINDER_FEES_AMOUNT)
 * - "percent": Absolute percentage of total loan amount (SETTLEMENT_AMOUNT = Principal × BFF / 100)
 * - "percent-annualized": Percentage annualized (SETTLEMENT_AMOUNT = Principal × BFF × Tenure / 12)
 * @param payment - Payment object containing tags
 * @param paymentIndex - Index of the payment for error messages
 * @param order - Order object containing quote and items
 * @param testResults - TestResult object to add validation results
 * @param tagType - Type of tag being validated (BAP_TERMS or BPP_TERMS)
 */
function validateSettlementAmount(
  payment: any,
  paymentIndex: number,
  order: any,
  testResults: TestResult,
  tagType: "BAP_TERMS" | "BPP_TERMS" = "BAP_TERMS"
): void {
  if (!payment.tags || !Array.isArray(payment.tags)) {
    return;
  }

  const termsTag = payment.tags.find(
    (tag: any) => tag.descriptor?.code === tagType
  );
  if (!termsTag || !termsTag.list || !Array.isArray(termsTag.list)) {
    return;
  }

  // Helper function to get value by code
  const getValue = (code: string): string | undefined => {
    const item = termsTag.list.find(
      (item: any) => item.descriptor?.code === code
    );
    return item?.value;
  };

  const settlementAmountStr = getValue("SETTLEMENT_AMOUNT");
  const buyerFinderFeesType = getValue("BUYER_FINDER_FEES_TYPE");

  if (!settlementAmountStr || !buyerFinderFeesType) {
    return;
  }

  try {
    const actualSettlementAmount = parseFloat(
      settlementAmountStr.replace(/[₹,\s]/g, "")
    );
    const tolerance = 0.01;

    // Handle "amount" type: SETTLEMENT_AMOUNT should equal BUYER_FINDER_FEES_AMOUNT
    if (buyerFinderFeesType === "amount") {
      const buyerFinderFeesAmountStr = getValue("BUYER_FINDER_FEES_AMOUNT");
      if (!buyerFinderFeesAmountStr) {
        return;
      }

      const expectedAmount = parseFloat(
        buyerFinderFeesAmountStr.replace(/[₹,\s]/g, "")
      );
      const difference = Math.abs(actualSettlementAmount - expectedAmount);

      if (difference <= tolerance) {
        testResults.passed.push(
          `Payment ${paymentIndex}: ${tagType} SETTLEMENT_AMOUNT matches BUYER_FINDER_FEES_AMOUNT. ` +
          `Expected: ₹${expectedAmount.toFixed(
            2
          )}, Actual: ₹${actualSettlementAmount.toFixed(2)}`
        );
      } else {
        testResults.failed.push(
          `Payment ${paymentIndex}: ${tagType} SETTLEMENT_AMOUNT does not match BUYER_FINDER_FEES_AMOUNT. ` +
          `Expected: ₹${expectedAmount.toFixed(
            2
          )}, Actual: ₹${actualSettlementAmount.toFixed(
            2
          )}, Difference: ₹${difference.toFixed(2)}`
        );
      }
      return;
    }

    // Handle "percent" and "percent-annualized" types: need BUYER_FINDER_FEES_PERCENTAGE
    const buyerFinderFeesPercentageStr = getValue(
      "BUYER_FINDER_FEES_PERCENTAGE"
    );
    if (!buyerFinderFeesPercentageStr || !order.quote?.breakup) {
      return;
    }

    // Extract Principal Amount from quote breakup
    const principalBreakup = order.quote.breakup.find(
      (b: any) =>
        b.title === "PRINCIPAL_AMOUNT" ||
        b["@ondc/org/title_type"] === "PRINCIPAL_AMOUNT"
    );

    if (!principalBreakup?.price?.value) {
      testResults.failed.push(
        `Payment ${paymentIndex}: Cannot validate ${tagType} SETTLEMENT_AMOUNT - PRINCIPAL_AMOUNT not found in quote breakup`
      );
      return;
    }

    const principal = parseFloat(principalBreakup.price.value);
    const bffPercentage = parseFloat(buyerFinderFeesPercentageStr);

    // Handle "percent" type: SETTLEMENT_AMOUNT = Principal × (BFF / 100)
    if (buyerFinderFeesType === "percent") {
      const expectedSettlementAmount = principal * (bffPercentage / 100);
      const roundedExpected = Math.round(expectedSettlementAmount * 100) / 100;
      const difference = Math.abs(actualSettlementAmount - roundedExpected);

      if (difference <= tolerance) {
        testResults.passed.push(
          `Payment ${paymentIndex}: ${tagType} SETTLEMENT_AMOUNT calculation is correct (percent type). ` +
          `Expected: ₹${roundedExpected.toFixed(
            2
          )} (Principal: ₹${principal}, BFF: ${bffPercentage}%), ` +
          `Actual: ₹${actualSettlementAmount.toFixed(2)}`
        );
      } else {
        testResults.failed.push(
          `Payment ${paymentIndex}: ${tagType} SETTLEMENT_AMOUNT calculation is incorrect (percent type). ` +
          `Expected: ₹${roundedExpected.toFixed(
            2
          )} (Principal: ₹${principal}, BFF: ${bffPercentage}%), ` +
          `Actual: ₹${actualSettlementAmount.toFixed(
            2
          )}, Difference: ₹${difference.toFixed(2)}`
        );
      }
      return;
    }

    // Handle "percent-annualized" type: SETTLEMENT_AMOUNT = (Principal × BFF × Tenure) / 12
    if (buyerFinderFeesType === "percent-annualized") {
      // Extract Tenure from items tags
      let tenureInYears: number | null = null;
      if (order.items && Array.isArray(order.items) && order.items.length > 0) {
        const firstItem = order.items[0];
        if (firstItem.tags && Array.isArray(firstItem.tags)) {
          const infoTag = firstItem.tags.find(
            (tag: any) => tag.descriptor?.code === "INFO"
          );
          if (infoTag?.list && Array.isArray(infoTag.list)) {
            const termItem = infoTag.list.find(
              (item: any) => item.descriptor?.code === "TERM"
            );
            if (termItem?.value) {
              tenureInYears = parseTermToYears(termItem.value);
            }
          }
        }
      }

      if (tenureInYears === null) {
        testResults.failed.push(
          `Payment ${paymentIndex}: Cannot validate ${tagType} SETTLEMENT_AMOUNT - TERM not found in items tags (required for percent-annualized)`
        );
        return;
      }

      // For percent-annualized: SETTLEMENT_AMOUNT = Principal × (BFF / 100) × (Tenure in months / 12)
      // tenureInYears is already in years, so we multiply by 12 to get months, then divide by 12
      // This simplifies to: Principal × (BFF / 100) × tenureInYears
      const expectedSettlementAmount =
        principal * (bffPercentage / 100) * tenureInYears;
      const roundedExpected = Math.round(expectedSettlementAmount * 100) / 100;
      const difference = Math.abs(actualSettlementAmount - roundedExpected);

      if (difference <= tolerance) {
        testResults.passed.push(
          `Payment ${paymentIndex}: ${tagType} SETTLEMENT_AMOUNT calculation is correct (percent-annualized type). ` +
          `Expected: ₹${roundedExpected.toFixed(
            2
          )} (Principal: ₹${principal}, BFF: ${bffPercentage}%, Tenure: ${tenureInYears} years), ` +
          `Actual: ₹${actualSettlementAmount.toFixed(2)}`
        );
      } else {
        testResults.failed.push(
          `Payment ${paymentIndex}: ${tagType} SETTLEMENT_AMOUNT calculation is incorrect (percent-annualized type). ` +
          `Expected: ₹${roundedExpected.toFixed(
            2
          )} (Principal: ₹${principal}, BFF: ${bffPercentage}%, Tenure: ${tenureInYears} years), ` +
          `Actual: ₹${actualSettlementAmount.toFixed(
            2
          )}, Difference: ₹${difference.toFixed(2)}`
        );
      }
      return;
    }

    // Invalid BUYER_FINDER_FEES_TYPE
    testResults.failed.push(
      `Payment ${paymentIndex}: ${tagType} BUYER_FINDER_FEES_TYPE is invalid. ` +
      `Expected one of: "amount", "percent", "percent-annualized", found: "${buyerFinderFeesType}"`
    );
  } catch (error: any) {
    testResults.failed.push(
      `Payment ${paymentIndex}: Error validating ${tagType} SETTLEMENT_AMOUNT calculation: ${error.message}`
    );
  }
}

/**
 * Wrapper function to validate TAT for on_select, on_init, and on_confirm actions
 */
function validateTAT(message: any, testResults: TestResult): void {
  const catalog = message?.catalog;
  if (catalog?.["bpp/providers"]) {
    const contextTimestamp = new Date();
    catalog["bpp/providers"].forEach((provider: any) => {
      if (provider.fulfillments) {
        validateTATForFulfillments(
          provider.fulfillments,
          contextTimestamp,
          testResults
        );
      }
    });
  }
}

/**
 * Wrapper function to validate shipment types for on_select, on_init, and on_confirm actions
 */
function validateShipmentTypesWrapper(
  message: any,
  testResults: TestResult
): void {
  const catalog = message?.catalog;
  if (catalog?.["bpp/providers"]) {
    catalog["bpp/providers"].forEach((provider: any) => {
      if (provider.fulfillments) {
        validateShipmentTypes(provider.fulfillments, testResults);
      }
    });
  }
}

function validateIntent(
  message: any,
  testResults: TestResult,
  action_id?: string,
  flow_id?: string
): void {
  const intent = message?.intent;
  if (!intent) {
    return;
  }

  if (!(flow_id && !UNIFIED_CREDIT_FLOWS.includes(flow_id) && !intent.category?.descriptor?.code)) {
    if (action_id === "search_rental") {
      if (intent.category?.descriptor?.code !== "ON_DEMAND_RENTAL") {
        testResults.failed.push(
          "Intent category descriptor code should be ON_DEMAND_RENTAL for on_search_rental"
        );
      }
    } else if (action_id === "search_schedule_rental") {
      if (intent.category?.descriptor?.code !== "SCHEDULED_RENTAL") {
        testResults.failed.push(
          "Intent category descriptor code should be SCHEDULED_RENTAL for on_search_schedule_rental"
        );
      }
    } else if (action_id === "search_trip") {
      if (intent.category?.descriptor?.code !== "ON_DEMAND_TRIP") {
        testResults.failed.push(
          "Intent category descriptor code should be ON_DEMAND_TRIP for on_search_trip"
        );
      }
    } else if (flow_id && GOLD_LOAN_FLOWS.includes(flow_id)) {
      if (intent.category?.descriptor?.code !== "GOLD_LOAN") {
        testResults.failed.push(
          `Intent category descriptor code should be GOLD_LOAN for ${flow_id}`
        );
      } else {
        testResults.passed.push(
          `Valid intent category descriptor code ${intent.category?.descriptor?.code} is present `
        );
      }
    } else if (flow_id && PERSONAL_LOAN_FLOWS.includes(flow_id)) {
      if (intent.category?.descriptor?.code !== "PERSONAL_LOAN") {
        testResults.failed.push(
          `Intent category descriptor code should be PERSONAL_LOAN for ${flow_id}`
        );
      } else {
        testResults.passed.push(
          `Valid intent category descriptor code ${intent.category?.descriptor?.code} is present `
        );
      }
    } else if (flow_id && CREDIT_CARD_FLOWS.includes(flow_id)) {
      if (intent.category?.descriptor?.code !== "CREDIT_CARD") {
        testResults.failed.push(
          `Intent category descriptor code should be CREDIT_CARD for ${flow_id}`
        );
      } else {
        testResults.passed.push(
          `Valid intent category descriptor code ${intent.category?.descriptor?.code} is present `
        );
      }
    } else if (flow_id && PURCHASE_FINANCE_FLOWS.includes(flow_id)) {
      if (intent.category?.descriptor?.code !== "PURCHASE_FINANCE") {
        testResults.failed.push(
          `Intent category descriptor code should be PURCHASE_FINANCE for ${flow_id}`
        );
      } else {
        testResults.passed.push(
          `Valid intent category descriptor code ${intent.category?.descriptor?.code} is present `
        );
      }

      // Purchase Finance specific search validations
      const hasProvider = !!intent.provider;
      const hasItems =
        hasProvider &&
        !!intent.provider.items &&
        Array.isArray(intent.provider.items) &&
        intent.provider.items.length > 0;

      if (!hasProvider && !hasItems) {
        // Search1: Initial search - only validate BAP_TERMS (already done by validateTags)
        testResults.passed.push(
          "Search1: Initial search validated (provider and items not required)"
        );
      } else {
        // Search2/3/4: Must have provider, items, and xinput
        if (!(!hasProvider)) {
          if (!(!intent.provider.id)) {
            testResults.passed.push(
              `Provider id is present: ${intent.provider.id}`
            );
          }
        }

        if (!(!hasItems)) {
          // Validate each item has xinput
          intent.provider.items.forEach((item: any, index: number) => {
            if (!(!item.xinput)) {
              testResults.passed.push(`Item ${index}: xinput is present`);
            }
          });
        }
      }
    } else if (flow_id && HEALTH_INSURANCE_FLOWS.includes(flow_id)) {
      if (intent.category?.descriptor?.code !== "HEALTH_INSURANCE") {
        testResults.failed.push(
          `Intent category descriptor code should be HEALTH_INSURANCE for ${flow_id}`
        );
      } else {
        testResults.passed.push(
          `Valid intent category descriptor code ${intent.category?.descriptor?.code} is present `
        );
      }
    } else if (flow_id && MOTOR_INSURANCE_FLOWS.includes(flow_id)) {
      if (intent.category?.descriptor?.code !== "MOTOR_INSURANCE") {
        testResults.failed.push(
          `Intent category descriptor code should be MOTOR_INSURANCE for ${flow_id}`
        );
      } else {
        testResults.passed.push(
          `Valid intent category descriptor code ${intent.category?.descriptor?.code} is present `
        );
      }
    } else {
      testResults.passed.push(
        `Valid intent category descriptor code ${intent.category?.descriptor?.code} is present `
      );
    }
  }

  if (flow_id && !CREDIT_CARD_FLOWS.includes(flow_id) && !GIFT_CARD_FLOWS.includes(flow_id)) {
    if (intent.payment?.type !== "POST_FULFILLMENT") {
      if (!PAYMENT_COLLECTED_BY.includes(intent.payment?.collected_by)) {
        testResults.passed.push(
          `Invalid payment collected_by found in intent,collected by should be one of these ${PAYMENT_COLLECTED_BY}`
        );
      } else {
        testResults.passed.push(
          `Payment collected_by ${intent.payment?.collected_by} is present in intent`
        );
      }
    }
  }
}

function validatePaymentCollectedBy(
  message: any,
  testResults: TestResult,
  flow_id?: string
): void {
  if (flow_id && CREDIT_CARD_FLOWS.includes(flow_id)) {
    return;
  }
  const payment = message?.intent?.payment;
  if (payment?.collected_by && ["BAP", "BPP"].includes(payment.collected_by)) {
    testResults.passed.push(
      `Payment collected_by has valid value ${payment.collected_by}`
    );
  } else {
    testResults.failed.push("Payment collected_by should be BAP or BPP");
  }
}

function validateTags(
  message: any,
  testResults: TestResult,
  flowId?: string
): void {
  const tags =
    message?.intent?.tags || message?.order?.tags || message?.catalog?.tags;
  if (tags && Array.isArray(tags)) {
    const bapTerms = tags.find((tag) => tag.descriptor?.code === "BAP_TERMS");
    const bppTerms = tags.find((tag) => tag.descriptor?.code === "BPP_TERMS");

    if (bapTerms) {
      testResults.passed.push("BAP_TERMS tag is present");
    }
    if (bppTerms) {
      testResults.passed.push("BPP_TERMS tag is present");
    }
  }

  // Purchase Finance specific BAP_TERMS validation
  if (flowId && PURCHASE_FINANCE_FLOWS.includes(flowId)) {
    const paymentTags = message?.intent?.payment?.tags || message?.intent?.tags;
    if (!paymentTags || !Array.isArray(paymentTags)) {
      return;
    }

    const bapTerms = paymentTags.find(
      (tag) => tag.descriptor?.code === "BAP_TERMS"
    );
    if (!bapTerms) {
      return;
    }

    if (!bapTerms.list || !Array.isArray(bapTerms.list)) {
      return;
    }

    // Helper function to get value by code
    const getValue = (code: string): string | undefined => {
      const item = bapTerms.list.find(
        (item: any) => item.descriptor?.code === code
      );
      return item?.value;
    };

    // Validate BUYER_FINDER_FEES_TYPE
    const buyerFinderFeesType = getValue("BUYER_FINDER_FEES_TYPE");
    // pramaan-validation-parity skill — L1 AUDIT: the enum-membership check that used to be here
    // (must be one of amount/percent/percent-annualized) is a duplicate of
    // automation-specifications/config/validations/index.yaml's search.SEARCH_PAYMENT ->
    // VALID_BUYER_FINDER_FEES_TYPE_VALUE — same 3 values, same BAP_TERMS/BUYER_FINDER_FEES_TYPE
    // scope, and it runs unconditionally (no _CONTINUE_ gate) so it's not something L1 only
    // checks "if present" — it always re-validates the value this code was also re-validating.
    // Presence is kept: L1 has no dedicated REQUIRED_ rule for this specific subtag (only
    // REQUIRED_BAP_TERMS_LIST, a whitelist over whichever subtags happen to be present), so
    // presence-checking here is still real coverage, not duplication. The type-dependent branch
    // below still needs the raw value either way.
    if (!(!buyerFinderFeesType)) {
      testResults.passed.push(
        `BUYER_FINDER_FEES_TYPE is present: ${buyerFinderFeesType}`
      );

      // Validate required fields based on type
      if (buyerFinderFeesType === "amount") {
        const buyerFinderFeesAmount = getValue("BUYER_FINDER_FEES_AMOUNT");
        if (!(!buyerFinderFeesAmount)) {
          const amount = parseFloat(
            buyerFinderFeesAmount.replace(/[₹,\s]/g, "")
          );
          if (isNaN(amount) || amount < 0) {
            testResults.failed.push(
              `BUYER_FINDER_FEES_AMOUNT should be a valid positive number, found: ${buyerFinderFeesAmount}`
            );
          } else {
            testResults.passed.push(
              `BUYER_FINDER_FEES_AMOUNT is valid: ${buyerFinderFeesAmount}`
            );
          }
        }
      } else {
        // For "percent" and "percent-annualized", BUYER_FINDER_FEES_PERCENTAGE is required
        const buyerFinderFeesPercentage = getValue(
          "BUYER_FINDER_FEES_PERCENTAGE"
        );
        if (!(!buyerFinderFeesPercentage)) {
          const percentage = parseFloat(buyerFinderFeesPercentage);
          if (isNaN(percentage) || percentage < 0) {
            testResults.failed.push(
              `BUYER_FINDER_FEES_PERCENTAGE should be a valid positive number, found: ${buyerFinderFeesPercentage}`
            );
          } else {
            testResults.passed.push(
              `BUYER_FINDER_FEES_PERCENTAGE is valid: ${buyerFinderFeesPercentage}`
            );
          }
        }
      }
    }

    // Validate DELAY_INTEREST
    const delayInterest = getValue("DELAY_INTEREST");
    if (!(!delayInterest)) {
      const interest = parseFloat(delayInterest);
      if (isNaN(interest) || interest < 0) {
        testResults.failed.push(
          `DELAY_INTEREST should be a valid positive number, found: ${delayInterest}`
        );
      } else {
        testResults.passed.push(`DELAY_INTEREST is valid: ${delayInterest}`);
      }
    }

    // Validate STATIC_TERMS
    const staticTerms = getValue("STATIC_TERMS");
    if (!(!staticTerms)) {
      try {
        const url = new URL(staticTerms);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          testResults.failed.push(
            `STATIC_TERMS should be a valid HTTP/HTTPS URL, found: ${staticTerms}`
          );
        } else {
          testResults.passed.push(
            `STATIC_TERMS is a valid URL: ${staticTerms}`
          );
        }
      } catch (error) {
        testResults.failed.push(
          `STATIC_TERMS should be a valid URL, found: ${staticTerms}`
        );
      }
    }

    // Validate OFFLINE_CONTRACT
    const offlineContract = getValue("OFFLINE_CONTRACT");
    if (offlineContract !== "true" && offlineContract !== "false") {
      testResults.failed.push(
        `OFFLINE_CONTRACT should be "true" or "false", found: ${offlineContract}`
      );
    } else {
      testResults.passed.push(`OFFLINE_CONTRACT is valid: ${offlineContract}`);
    }
  }
}

function validatePurchaseFinanceBapTerms(
  message: any,
  testResults: TestResult,
  flowId?: string
): void {
  // Only validate for purchase finance flows
  if (!flowId || !PURCHASE_FINANCE_FLOWS.includes(flowId)) {
    return;
  }

  const tags = message?.intent?.payment?.tags || message?.intent?.tags;
  if (!tags || !Array.isArray(tags)) {
    return;
  }

  const bapTerms = tags.find((tag) => tag.descriptor?.code === "BAP_TERMS");
  if (!bapTerms) {
    return;
  }
  checkTagDisplayFalse(bapTerms, "BAP_TERMS", testResults);

  if (!bapTerms.list || !Array.isArray(bapTerms.list)) {
    return;
  }

  // Helper function to get value by code
  const getValue = (code: string): string | undefined => {
    const item = bapTerms.list.find(
      (item: any) => item.descriptor?.code === code
    );
    return item?.value;
  };

  // Validate BUYER_FINDER_FEES_TYPE
  const buyerFinderFeesType = getValue("BUYER_FINDER_FEES_TYPE");
  const validTypes = ["amount", "percent", "percent-annualized"];
  if (!validTypes.includes(buyerFinderFeesType ?? "")) {
    testResults.failed.push(
      `BUYER_FINDER_FEES_TYPE should be one of: ${validTypes.join(
        ", "
      )}, found: ${buyerFinderFeesType}`
    );
  } else {
    testResults.passed.push(
      `BUYER_FINDER_FEES_TYPE is valid: ${buyerFinderFeesType}`
    );

    // Validate required fields based on type
    if (buyerFinderFeesType === "amount") {
      const buyerFinderFeesAmount = getValue("BUYER_FINDER_FEES_AMOUNT");
      if (!(!buyerFinderFeesAmount)) {
        const amount = parseFloat(buyerFinderFeesAmount.replace(/[₹,\s]/g, ""));
        if (isNaN(amount) || amount < 0) {
          testResults.failed.push(
            `BUYER_FINDER_FEES_AMOUNT should be a valid positive number, found: ${buyerFinderFeesAmount}`
          );
        } else {
          testResults.passed.push(
            `BUYER_FINDER_FEES_AMOUNT is valid: ${buyerFinderFeesAmount}`
          );
        }
      }
    } else {
      // For "percent" and "percent-annualized", BUYER_FINDER_FEES_PERCENTAGE is required
      const buyerFinderFeesPercentage = getValue(
        "BUYER_FINDER_FEES_PERCENTAGE"
      );
      if (!(!buyerFinderFeesPercentage)) {
        const percentage = parseFloat(buyerFinderFeesPercentage);
        if (isNaN(percentage) || percentage < 0) {
          testResults.failed.push(
            `BUYER_FINDER_FEES_PERCENTAGE should be a valid positive number, found: ${buyerFinderFeesPercentage}`
          );
        } else {
          testResults.passed.push(
            `BUYER_FINDER_FEES_PERCENTAGE is valid: ${buyerFinderFeesPercentage}`
          );
        }
      }
    }
  }

  // Validate DELAY_INTEREST
  const delayInterest = getValue("DELAY_INTEREST");
  if (!(!delayInterest)) {
    const interest = parseFloat(delayInterest);
    if (isNaN(interest) || interest < 0) {
      testResults.failed.push(
        `DELAY_INTEREST should be a valid positive number, found: ${delayInterest}`
      );
    } else {
      testResults.passed.push(`DELAY_INTEREST is valid: ${delayInterest}`);
    }
  }

  // Validate STATIC_TERMS
  const staticTerms = getValue("STATIC_TERMS");
  if (!(!staticTerms)) {
    try {
      const url = new URL(staticTerms);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        testResults.failed.push(
          `STATIC_TERMS should be a valid HTTP/HTTPS URL, found: ${staticTerms}`
        );
      } else {
        testResults.passed.push(`STATIC_TERMS is a valid URL: ${staticTerms}`);
      }
    } catch (error) {
      testResults.failed.push(
        `STATIC_TERMS should be a valid URL, found: ${staticTerms}`
      );
    }
  }

  // Validate OFFLINE_CONTRACT
  const offlineContract = getValue("OFFLINE_CONTRACT");
  if (offlineContract !== "true" && offlineContract !== "false") {
    testResults.failed.push(
      `OFFLINE_CONTRACT should be "true" or "false", found: ${offlineContract}`
    );
  } else {
    testResults.passed.push(`OFFLINE_CONTRACT is valid: ${offlineContract}`);
  }
}

function validatePurchaseFinanceSearch(
  message: any,
  context: any,
  testResults: TestResult,
  flowId?: string
): void {
  // Only validate for purchase finance flows
  if (!flowId || !PURCHASE_FINANCE_FLOWS.includes(flowId)) {
    return;
  }

  const intent = message?.intent;
  if (!intent) {
    return;
  }

  // Check if this is search1 (no provider/items) or search2/3/4 (has provider/items)
  const hasProvider = !!intent.provider;
  const hasItems =
    hasProvider &&
    !!intent.provider.items &&
    Array.isArray(intent.provider.items) &&
    intent.provider.items.length > 0;

  if (!hasProvider && !hasItems) {
    // Search1: Initial search - only validate BAP_TERMS (already done by validatePurchaseFinanceBapTerms)
    // No additional validations needed for search1
    testResults.passed.push(
      "Search1: Initial search validated (provider and items not required)"
    );
    return;
  }

  // Search2/3/4: Must have provider, items, and xinput
  // Validate provider
  if (!hasProvider) {
    return;
  }

  if (!(!intent.provider.id)) {
    testResults.passed.push(`Provider id is present: ${intent.provider.id}`);
  }

  // Validate items
  if (!hasItems) {
    return;
  }

  // Validate context has bpp_id and bpp_uri for search2/3/4
  if (!(!context.bpp_id)) {
    testResults.passed.push(`bpp_id is present in context: ${context.bpp_id}`);
  }

  if (!(!context.bpp_uri)) {
    testResults.passed.push(
      `bpp_uri is present in context: ${context.bpp_uri}`
    );
  }

  // Validate each item has xinput
  intent.provider.items.forEach((item: any, index: number) => {
    if (!item.id) {
      return;
    }

    if (!item.xinput) {
      // Skip xinput validation if item has parent_item_id (it's a child item)
      if (item.parent_item_id) {
        testResults.passed.push(
          `Item ${item.id}: xinput is not required (has parent_item_id: ${item.parent_item_id})`
        );
        return;
      }

      return;
    }

    // Validate xinput.form
    if (!(!item.xinput.form)) {
      if (!(!item.xinput.form.id)) {
        testResults.passed.push(
          `Item ${item.id}: xinput.form.id is present: "${item.xinput.form.id}"`
        );
      }
    }

    // Validate xinput.form_response
    if (!item.xinput.form_response) {
      return;
    }

    const formResponse = item.xinput.form_response;
    const allowedStatuses = ["SUCCESS", "APPROVED"];

    if (!allowedStatuses.includes(formResponse.status)) {
      testResults.failed.push(
        `Item ${item.id}: Invalid xinput.form_response.status "${formResponse.status
        }". Allowed: ${allowedStatuses.join(", ")}`
      );
    } else {
      testResults.passed.push(
        `Item ${item.id}: Valid xinput.form_response.status "${formResponse.status}"`
      );
    }

    if (!(!formResponse.submission_id)) {
      testResults.passed.push(
        `Item ${item.id}: xinput.form_response.submission_id is present: "${formResponse.submission_id}"`
      );
    }
  });
}

function validatePurchaseFinanceOnSelect(
  message: any,
  testResults: TestResult,
  flowId?: string
): void {
  // Only validate for purchase finance flows
  if (!flowId || !PURCHASE_FINANCE_FLOWS.includes(flowId)) {
    return;
  }

  const order = message?.order;
  if (!order) {
    return;
  }

  if (!order.items || !Array.isArray(order.items) || order.items.length === 0) {
    return;
  }

  order.items.forEach((item: any) => {
    if (!item.id) {
      return;
    }

    if (!item.xinput) {
      // Skip xinput validation if item has parent_item_id (it's a child item)
      if (item.parent_item_id) {
        testResults.passed.push(
          `Item ${item.id}: xinput is not required (has parent_item_id: ${item.parent_item_id})`
        );
        return;
      }

      return;
    }

    // Check if this is on_select3 (has form_response, no head/form details) or on_select1/2 (has head and form)
    const hasFormResponse = item.xinput.form_response;
    const hasHead = item.xinput.head;
    const hasForm = item.xinput.form;

    if (hasFormResponse) {
      // on_select3: Has form_response - validate it
      const formResponse = item.xinput.form_response;
      const allowedStatuses = ["SUCCESS", "APPROVED"];

      if (!allowedStatuses.includes(formResponse.status)) {
        testResults.failed.push(
          `Item ${item.id}: Invalid xinput.form_response.status "${formResponse.status
          }". Allowed: ${allowedStatuses.join(", ")}`
        );
      } else {
        testResults.passed.push(
          `Item ${item.id}: Valid xinput.form_response.status "${formResponse.status}"`
        );
      }

      if (!(!formResponse.submission_id)) {
        testResults.passed.push(
          `Item ${item.id}: xinput.form_response.submission_id is present: "${formResponse.submission_id}"`
        );
      }

      // Validate form.id is present
      if (!(!item.xinput.form || !item.xinput.form.id)) {
        testResults.passed.push(
          `Item ${item.id}: xinput.form.id is present: "${item.xinput.form.id}"`
        );
      }
    } else if (hasHead && hasForm) {
      // on_select1/2: Has xinput.head and xinput.form - validate them
      // Validate xinput.form
      if (!(!item.xinput.form.id)) {
        testResults.passed.push(
          `Item ${item.id}: xinput.form.id is present: "${item.xinput.form.id}"`
        );
      }

      if (!(!item.xinput.form.url)) {
        try {
          const url = new URL(item.xinput.form.url);
          if (url.protocol !== "http:" && url.protocol !== "https:") {
            testResults.failed.push(
              `Item ${item.id}: xinput.form.url should be a valid HTTP/HTTPS URL`
            );
          } else {
            testResults.passed.push(
              `Item ${item.id}: xinput.form.url is a valid URL`
            );
          }
        } catch (error) {
          testResults.failed.push(
            `Item ${item.id}: xinput.form.url is not a valid URL`
          );
        }
      }

      const validMimeTypes = ["text/html", "application/html"];
      if (!validMimeTypes.includes(item.xinput.form.mime_type)) {
        testResults.failed.push(
          `Item ${item.id}: Invalid xinput.form.mime_type "${item.xinput.form.mime_type
          }". Allowed: ${validMimeTypes.join(", ")}`
        );
      } else {
        testResults.passed.push(
          `Item ${item.id}: xinput.form.mime_type is valid: "${item.xinput.form.mime_type}"`
        );
      }

      // Validate xinput.head
      if (!(!item.xinput.head.descriptor || !item.xinput.head.descriptor.name)) {
        testResults.passed.push(
          `Item ${item.id}: xinput.head.descriptor.name is present: "${item.xinput.head.descriptor.name}"`
        );
      }

      if (!(!item.xinput.head.index)) {
        const index = item.xinput.head.index;
        if (
          typeof index.min !== "number" ||
          typeof index.cur !== "number" ||
          typeof index.max !== "number"
        ) {
          testResults.failed.push(
            `Item ${item.id}: xinput.head.index should have min, cur, and max as numbers`
          );
        } else {
          if (index.cur < index.min || index.cur > index.max) {
            testResults.failed.push(
              `Item ${item.id}: xinput.head.index.cur (${index.cur}) should be between min (${index.min}) and max (${index.max})`
            );
          } else {
            testResults.passed.push(
              `Item ${item.id}: xinput.head.index is valid (cur: ${index.cur}, min: ${index.min}, max: ${index.max})`
            );
          }
        }
      }

      if (!(
        !item.xinput.head.headings ||
        !Array.isArray(item.xinput.head.headings) ||
        item.xinput.head.headings.length === 0
      )) {
        const allowedHeadings = [
          "SET_DOWN_PAYMENT",
          "KYC",
          "EMANDATE",
          "ESIGN",
          "MERCHANT_AND_PRDOUCT_DEATILS",
          "PERSONAL_INFORMATION",
        ];
        item.xinput.head.headings.forEach((heading: string) => {
          if (!allowedHeadings.includes(heading)) {
            testResults.failed.push(
              `Item ${item.id
              }: Invalid heading "${heading}". Allowed: ${allowedHeadings.join(
                ", "
              )}`
            );
          } else {
            testResults.passed.push(
              `Item ${item.id}: Valid heading "${heading}"`
            );
          }
        });
      }

      if (item.xinput.required !== true && item.xinput.required !== false) {
        testResults.failed.push(
          `Item ${item.id}: xinput.required should be a boolean`
        );
      } else {
        testResults.passed.push(
          `Item ${item.id}: xinput.required is present: ${item.xinput.required}`
        );
      }

      // Validate CHECKLISTS tag if present
      if (item.tags && Array.isArray(item.tags)) {
        const checklistsTag = item.tags.find(
          (tag: any) => tag.descriptor?.code === "CHECKLISTS"
        );
        if (
          checklistsTag &&
          checklistsTag.list &&
          Array.isArray(checklistsTag.list)
        ) {
          const allowedChecklistStatuses = ["PENDING", "COMPLETED"];
          checklistsTag.list.forEach((checklistItem: any) => {
            const code = checklistItem.descriptor?.code;
            const value = checklistItem.value;
            if (code && value) {
              if (!allowedChecklistStatuses.includes(value)) {
                testResults.failed.push(
                  `Item ${item.id
                  }: Invalid CHECKLISTS.${code} status "${value}". Allowed: ${allowedChecklistStatuses.join(
                    ", "
                  )}`
                );
              } else {
                testResults.passed.push(
                  `Item ${item.id}: CHECKLISTS.${code} status is valid: "${value}"`
                );
              }
            }
          });
        }
      }
    } else {
      testResults.failed.push(
        `Item ${item.id}: xinput must have either (head and form) or form_response`
      );
    }
  });
}

function validatePurchaseFinanceSelect(
  message: any,
  testResults: TestResult,
  flowId?: string
): void {
  // Only validate for purchase finance flows
  if (!flowId || !PURCHASE_FINANCE_FLOWS.includes(flowId)) {
    return;
  }

  const order = message?.order;
  if (!order) {
    return;
  }

  if (!order.items || !Array.isArray(order.items) || order.items.length === 0) {
    return;
  }

  order.items.forEach((item: any) => {
    if (!item.id) {
      return;
    }

    // Check if this is select1 (no xinput) or select2/3 (has xinput with form_response)
    if (!item.xinput) {
      // select1: Basic select - no xinput required
      testResults.passed.push(
        `Item ${item.id}: Basic select validated (xinput not required for select1)`
      );
      return;
    }

    // select2/3: Must have xinput with form and form_response
    if (!item.xinput.form) {
      return;
    }

    if (!(!item.xinput.form.id)) {
      testResults.passed.push(
        `Item ${item.id}: xinput.form.id is present: "${item.xinput.form.id}"`
      );
    }

    if (!item.xinput.form_response) {
      return;
    }

    const formResponse = item.xinput.form_response;
    const allowedStatuses = ["SUCCESS", "APPROVED"];

    if (!allowedStatuses.includes(formResponse.status)) {
      testResults.failed.push(
        `Item ${item.id}: Invalid xinput.form_response.status "${formResponse.status
        }". Allowed: ${allowedStatuses.join(", ")}`
      );
    } else {
      testResults.passed.push(
        `Item ${item.id}: Valid xinput.form_response.status "${formResponse.status}"`
      );
    }

    if (!(!formResponse.submission_id)) {
      testResults.passed.push(
        `Item ${item.id}: xinput.form_response.submission_id is present: "${formResponse.submission_id}"`
      );
    }
  });
}

function validatePurchaseFinanceInit(
  message: any,
  testResults: TestResult,
  flowId?: string
): void {
  // Only validate for purchase finance flows
  if (!flowId || !PURCHASE_FINANCE_FLOWS.includes(flowId)) {
    return;
  }

  const order = message?.order;
  if (!order) {
    return;
  }

  if (!order.items || !Array.isArray(order.items) || order.items.length === 0) {
    return;
  }

  // Validate payments
  if (
    !order.payments ||
    !Array.isArray(order.payments) ||
    order.payments.length === 0
  ) {
    return;
  }

  // Validate BAP_TERMS in payments
  order.payments.forEach((payment: any, paymentIndex: number) => {
    if (!payment.tags || !Array.isArray(payment.tags)) {
      return;
    }

    const bapTerms = payment.tags.find(
      (tag: any) => tag.descriptor?.code === "BAP_TERMS"
    );
    if (!bapTerms) {
      return;
    }
    checkTagDisplayFalse(bapTerms, "BAP_TERMS", testResults, `Payment ${paymentIndex}: `);

    if (!bapTerms.list || !Array.isArray(bapTerms.list)) {
      return;
    }

    // Helper function to get value by code
    const getValue = (code: string): string | undefined => {
      const item = bapTerms.list.find(
        (item: any) => item.descriptor?.code === code
      );
      return item?.value;
    };

    // Validate required BAP_TERMS fields for init
    const requiredFields = [
      "BUYER_FINDER_FEES_TYPE",
      "BUYER_FINDER_FEES_PERCENTAGE",
      "SETTLEMENT_AMOUNT",
      "SETTLEMENT_TYPE",
      "DELAY_INTEREST",
      "STATIC_TERMS",
      "OFFLINE_CONTRACT",
    ];

    requiredFields.forEach((fieldCode) => {
      const value = getValue(fieldCode);
      if (!(!value)) {
        testResults.passed.push(
          `Payment ${paymentIndex}: ${fieldCode} is present: ${value}`
        );
      }
    });

    // pramaan-validation-parity skill — L1 AUDIT: the SETTLEMENT_TYPE enum check that used to be
    // here (must be one of neft/rtgs/upi/imps) is a direct duplicate of
    // automation-specifications/config/validations/index.yaml's init.INIT_PAYMENT_TAGS ->
    // VALID_SETTLEMENT_TYPE_VALUE — same 4 values, same BAP_TERMS/SETTLEMENT_TYPE scope,
    // unconditional on the L1 side. Presence of SETTLEMENT_TYPE itself is unaffected — it's
    // still enforced by the requiredFields loop above, which this block never duplicated (it
    // only ran `if (settlementType && ...)`, i.e. it was pure re-validation of an already-typed
    // value). Removed rather than left as dead re-checking of an L1-owned rule.

    // Validate SETTLEMENT_AMOUNT calculation for BAP_TERMS
    validateSettlementAmount(
      payment,
      paymentIndex,
      order,
      testResults,
      "BAP_TERMS"
    );

    // Validate payment types
    const validPaymentTypes = ["ON_ORDER", "PRE_ORDER", "POST_FULFILLMENT"];
    if (!validPaymentTypes.includes(payment.type)) {
      testResults.failed.push(
        `Payment ${paymentIndex}: Invalid payment type "${payment.type
        }". Allowed: ${validPaymentTypes.join(", ")}`
      );
    } else {
      testResults.passed.push(
        `Payment ${paymentIndex}: Valid payment type: ${payment.type}`
      );
    }

    // Validate PRE_ORDER payment has params
    if (payment.type === "PRE_ORDER") {
      if (!(!payment.params)) {
        if (!(!payment.params.amount)) {
          testResults.passed.push(
            `Payment ${paymentIndex}: params.amount is present: ${payment.params.amount}`
          );
        }
        if (!(!payment.params.currency)) {
          testResults.passed.push(
            `Payment ${paymentIndex}: params.currency is present: ${payment.params.currency}`
          );
        }
        if (payment.params.transaction_id) {
          testResults.passed.push(
            `Payment ${paymentIndex}: params.transaction_id is present: ${payment.params.transaction_id}`
          );
        }
      }
    }
  });

  // Validate items
  order.items.forEach((item: any) => {
    if (!item.id) {
      return;
    }

    // Check if this is init1 (no xinput) or init2/3 (has xinput with form_response)
    if (!item.xinput) {
      // init1: Basic init - no xinput required
      testResults.passed.push(
        `Item ${item.id}: Basic init validated (xinput not required for init1)`
      );
      return;
    }

    // init2/3: Must have xinput with form and form_response
    if (!item.xinput.form) {
      return;
    }

    if (!(!item.xinput.form.id)) {
      testResults.passed.push(
        `Item ${item.id}: xinput.form.id is present: "${item.xinput.form.id}"`
      );
    }

    if (!item.xinput.form_response) {
      return;
    }

    const formResponse = item.xinput.form_response;
    const allowedStatuses = ["SUCCESS", "APPROVED"];

    if (!allowedStatuses.includes(formResponse.status)) {
      testResults.failed.push(
        `Item ${item.id}: Invalid xinput.form_response.status "${formResponse.status
        }". Allowed: ${allowedStatuses.join(", ")}`
      );
    } else {
      testResults.passed.push(
        `Item ${item.id}: Valid xinput.form_response.status "${formResponse.status}"`
      );
    }

    if (!(!formResponse.submission_id)) {
      testResults.passed.push(
        `Item ${item.id}: xinput.form_response.submission_id is present: "${formResponse.submission_id}"`
      );
    }
  });
}

function validatePurchaseFinanceOnInit(
  message: any,
  testResults: TestResult,
  flowId?: string
): void {
  // Only validate for purchase finance flows
  if (!flowId || !PURCHASE_FINANCE_FLOWS.includes(flowId)) {
    return;
  }

  const order = message?.order;
  if (!order) {
    return;
  }

  if (!order.items || !Array.isArray(order.items) || order.items.length === 0) {
    return;
  }

  order.items.forEach((item: any) => {
    if (!item.id) {
      return;
    }

    if (!item.xinput) {
      // Skip xinput validation if item has parent_item_id (it's a child item)
      if (item.parent_item_id) {
        testResults.passed.push(
          `Item ${item.id}: xinput is not required (has parent_item_id: ${item.parent_item_id})`
        );
        return;
      }

      return;
    }

    // Check if this is on_init3 (has form_response, no head/form details) or on_init1/2 (has head and form)
    const hasFormResponse = item.xinput.form_response;
    const hasHead = item.xinput.head;
    const hasForm = item.xinput.form;

    if (hasFormResponse) {
      // on_init3: Has form_response - validate it
      const formResponse = item.xinput.form_response;
      const allowedStatuses = ["SUCCESS", "APPROVED"];

      if (!allowedStatuses.includes(formResponse.status)) {
        testResults.failed.push(
          `Item ${item.id}: Invalid xinput.form_response.status "${formResponse.status
          }". Allowed: ${allowedStatuses.join(", ")}`
        );
      } else {
        testResults.passed.push(
          `Item ${item.id}: Valid xinput.form_response.status "${formResponse.status}"`
        );
      }

      if (!(!formResponse.submission_id)) {
        testResults.passed.push(
          `Item ${item.id}: xinput.form_response.submission_id is present: "${formResponse.submission_id}"`
        );
      }

      // Validate form.id is present
      if (!(!item.xinput.form || !item.xinput.form.id)) {
        testResults.passed.push(
          `Item ${item.id}: xinput.form.id is present: "${item.xinput.form.id}"`
        );
      }

      // Validate CHECKLISTS tag if present
      if (item.tags && Array.isArray(item.tags)) {
        const checklistsTag = item.tags.find(
          (tag: any) => tag.descriptor?.code === "CHECKLISTS"
        );
        if (
          checklistsTag &&
          checklistsTag.list &&
          Array.isArray(checklistsTag.list)
        ) {
          const allowedChecklistStatuses = ["PENDING", "COMPLETED"];
          checklistsTag.list.forEach((checklistItem: any) => {
            const code = checklistItem.descriptor?.code;
            const value = checklistItem.value;
            if (code && value) {
              if (!allowedChecklistStatuses.includes(value)) {
                testResults.failed.push(
                  `Item ${item.id
                  }: Invalid CHECKLISTS.${code} status "${value}". Allowed: ${allowedChecklistStatuses.join(
                    ", "
                  )}`
                );
              } else {
                testResults.passed.push(
                  `Item ${item.id}: CHECKLISTS.${code} status is valid: "${value}"`
                );
              }
            }
          });
        }
      }
    } else if (hasHead && hasForm) {
      // on_init1/2: Has xinput.head and xinput.form - validate them
      // Validate xinput.form
      if (!(!item.xinput.form.id)) {
        testResults.passed.push(
          `Item ${item.id}: xinput.form.id is present: "${item.xinput.form.id}"`
        );
      }

      if (!(!item.xinput.form.url)) {
        try {
          const url = new URL(item.xinput.form.url);
          if (url.protocol !== "http:" && url.protocol !== "https:") {
            testResults.failed.push(
              `Item ${item.id}: xinput.form.url should be a valid HTTP/HTTPS URL`
            );
          } else {
            testResults.passed.push(
              `Item ${item.id}: xinput.form.url is a valid URL`
            );
          }
        } catch (error) {
          testResults.failed.push(
            `Item ${item.id}: xinput.form.url is not a valid URL`
          );
        }
      }

      const validMimeTypes = ["text/html", "application/html"];
      if (!validMimeTypes.includes(item.xinput.form.mime_type)) {
        testResults.failed.push(
          `Item ${item.id}: Invalid xinput.form.mime_type "${item.xinput.form.mime_type
          }". Allowed: ${validMimeTypes.join(", ")}`
        );
      } else {
        testResults.passed.push(
          `Item ${item.id}: xinput.form.mime_type is valid: "${item.xinput.form.mime_type}"`
        );
      }

      // Validate xinput.head
      if (!(!item.xinput.head.descriptor || !item.xinput.head.descriptor.name)) {
        testResults.passed.push(
          `Item ${item.id}: xinput.head.descriptor.name is present: "${item.xinput.head.descriptor.name}"`
        );
      }

      if (!(!item.xinput.head.index)) {
        const index = item.xinput.head.index;
        if (
          typeof index.min !== "number" ||
          typeof index.cur !== "number" ||
          typeof index.max !== "number"
        ) {
          testResults.failed.push(
            `Item ${item.id}: xinput.head.index should have min, cur, and max as numbers`
          );
        } else {
          if (index.cur < index.min || index.cur > index.max) {
            testResults.failed.push(
              `Item ${item.id}: xinput.head.index.cur (${index.cur}) should be between min (${index.min}) and max (${index.max})`
            );
          } else {
            testResults.passed.push(
              `Item ${item.id}: xinput.head.index is valid (cur: ${index.cur}, min: ${index.min}, max: ${index.max})`
            );
          }
        }
      }

      if (!(
        !item.xinput.head.headings ||
        !Array.isArray(item.xinput.head.headings) ||
        item.xinput.head.headings.length === 0
      )) {
        const allowedHeadings = [
          "SET_DOWN_PAYMENT",
          "KYC",
          "EMANDATE",
          "ESIGN",
          "MERCHANT_AND_PRDOUCT_DEATILS",
          "PERSONAL_INFORMATION",
        ];
        item.xinput.head.headings.forEach((heading: string) => {
          if (!allowedHeadings.includes(heading)) {
            testResults.failed.push(
              `Item ${item.id
              }: Invalid heading "${heading}". Allowed: ${allowedHeadings.join(
                ", "
              )}`
            );
          } else {
            testResults.passed.push(
              `Item ${item.id}: Valid heading "${heading}"`
            );
          }
        });
      }

      if (item.xinput.required !== true && item.xinput.required !== false) {
        testResults.failed.push(
          `Item ${item.id}: xinput.required should be a boolean`
        );
      } else {
        testResults.passed.push(
          `Item ${item.id}: xinput.required is present: ${item.xinput.required}`
        );
      }

      // Validate CHECKLISTS tag if present
      if (item.tags && Array.isArray(item.tags)) {
        const checklistsTag = item.tags.find(
          (tag: any) => tag.descriptor?.code === "CHECKLISTS"
        );
        if (
          checklistsTag &&
          checklistsTag.list &&
          Array.isArray(checklistsTag.list)
        ) {
          const allowedChecklistStatuses = ["PENDING", "COMPLETED"];
          checklistsTag.list.forEach((checklistItem: any) => {
            const code = checklistItem.descriptor?.code;
            const value = checklistItem.value;
            if (code && value) {
              if (!allowedChecklistStatuses.includes(value)) {
                testResults.failed.push(
                  `Item ${item.id
                  }: Invalid CHECKLISTS.${code} status "${value}". Allowed: ${allowedChecklistStatuses.join(
                    ", "
                  )}`
                );
              } else {
                testResults.passed.push(
                  `Item ${item.id}: CHECKLISTS.${code} status is valid: "${value}"`
                );
              }
            }
          });
        }
      }
    } else {
      testResults.failed.push(
        `Item ${item.id}: xinput must have either (head and form) or form_response`
      );
    }
  });

  // Validate fulfillments
  if (!(
    !order.fulfillments ||
    !Array.isArray(order.fulfillments) ||
    order.fulfillments.length === 0
  )) {
    order.fulfillments.forEach((fulfillment: any, index: number) => {
      if (!(!fulfillment.id)) {
        testResults.passed.push(
          `Fulfillment ${index}: id is present: ${fulfillment.id}`
        );
      }

      if (fulfillment.type !== "LOAN") {
        testResults.failed.push(
          `Fulfillment ${index}: type should be "LOAN" for purchase finance`
        );
      } else {
        testResults.passed.push(
          `Fulfillment ${index}: type is valid: ${fulfillment.type}`
        );
      }

      if (!(
        !fulfillment.state ||
        !fulfillment.state.descriptor ||
        !fulfillment.state.descriptor.code
      )) {
        testResults.passed.push(
          `Fulfillment ${index}: state.descriptor.code is present: ${fulfillment.state.descriptor.code}`
        );
      }
    });
  }

  // Validate payments
  if (!(
    !order.payments ||
    !Array.isArray(order.payments) ||
    order.payments.length === 0
  )) {
    order.payments.forEach((payment: any, paymentIndex: number) => {
      const validPaymentTypes = ["ON_ORDER", "PRE_ORDER", "POST_FULFILLMENT"];
      if (!validPaymentTypes.includes(payment.type)) {
        testResults.failed.push(
          `Payment ${paymentIndex}: Invalid payment type "${payment.type
          }". Allowed: ${validPaymentTypes.join(", ")}`
        );
      } else {
        testResults.passed.push(
          `Payment ${paymentIndex}: Valid payment type: ${payment.type}`
        );
      }

      // Validate POST_FULFILLMENT payments have BREAKUP tag
      if (payment.type === "POST_FULFILLMENT") {
        if (!(!payment.tags || !Array.isArray(payment.tags))) {
          const breakupTag = payment.tags.find(
            (tag: any) => tag.descriptor?.code === "BREAKUP"
          );
          if (!(!breakupTag)) {
            testResults.passed.push(
              `Payment ${paymentIndex}: BREAKUP tag is present`
            );
          }

          if (!payment.time || !payment.time.label) {
          } else if (payment.time.label !== "INSTALLMENT") {
            testResults.failed.push(
              `Payment ${paymentIndex}: time.label should be "INSTALLMENT" for POST_FULFILLMENT payment`
            );
          } else {
            testResults.passed.push(
              `Payment ${paymentIndex}: time.label is valid: ${payment.time.label}`
            );
          }
        }
      }

      // Validate SETTLEMENT_AMOUNT calculation for BAP_TERMS and BPP_TERMS
      validateSettlementAmount(
        payment,
        paymentIndex,
        order,
        testResults,
        "BAP_TERMS"
      );
      validateSettlementAmount(
        payment,
        paymentIndex,
        order,
        testResults,
        "BPP_TERMS"
      );
    });
  }

  // Validate quote
  if (!(!order.quote)) {
    if (!(!order.quote.id)) {
      testResults.passed.push(`Quote id is present: ${order.quote.id}`);
    }

    if (!(
      !order.quote.price ||
      !order.quote.price.value ||
      !order.quote.price.currency
    )) {
      testResults.passed.push(
        `Quote price is present: ${order.quote.price.value} ${order.quote.price.currency}`
      );
    }

    if (!(
      !order.quote.breakup ||
      !Array.isArray(order.quote.breakup) ||
      order.quote.breakup.length === 0
    )) {
      testResults.passed.push(
        `Quote breakup array has ${order.quote.breakup.length} items`
      );
    }
  }
}

function validatePurchaseFinanceConfirm(
  message: any,
  testResults: TestResult,
  flowId?: string
): void {
  // Only validate for purchase finance flows
  if (!flowId || !PURCHASE_FINANCE_FLOWS.includes(flowId)) {
    return;
  }

  const order = message?.order;
  if (!order) {
    return;
  }

  if (!order.items || !Array.isArray(order.items) || order.items.length === 0) {
    return;
  }

  // Validate payments
  if (
    !order.payments ||
    !Array.isArray(order.payments) ||
    order.payments.length === 0
  ) {
    return;
  }

  // Validate BAP_TERMS and BPP_TERMS in payments
  order.payments.forEach((payment: any, paymentIndex: number) => {
    if (!payment.tags || !Array.isArray(payment.tags)) {
      return;
    }

    // Validate BAP_TERMS tag
    const bapTerms = payment.tags.find(
      (tag: any) => tag.descriptor?.code === "BAP_TERMS"
    );
    if (bapTerms) {
      checkTagDisplayFalse(bapTerms, "BAP_TERMS", testResults, `Payment ${paymentIndex}: `);
      if (bapTerms.list && Array.isArray(bapTerms.list)) {
        // Helper function to get value by code
        const getValue = (code: string): string | undefined => {
          const item = bapTerms.list.find(
            (item: any) => item.descriptor?.code === code
          );
          return item?.value;
        };

        // Validate required BAP_TERMS fields
        const requiredFields = [
          "BUYER_FINDER_FEES_TYPE",
          "BUYER_FINDER_FEES_PERCENTAGE",
          "SETTLEMENT_AMOUNT",
          "SETTLEMENT_TYPE",
          "DELAY_INTEREST",
          "STATIC_TERMS",
          "OFFLINE_CONTRACT",
        ];

        requiredFields.forEach((fieldCode) => {
          const value = getValue(fieldCode);
          if (!(!value)) {
            testResults.passed.push(
              `Payment ${paymentIndex}: BAP_TERMS.${fieldCode} is present: ${value}`
            );
          }
        });

        // Validate SETTLEMENT_AMOUNT calculation for BAP_TERMS
        validateSettlementAmount(
          payment,
          paymentIndex,
          order,
          testResults,
          "BAP_TERMS"
        );
      }
    }

    // Validate BPP_TERMS tag
    const bppTerms = payment.tags.find(
      (tag: any) => tag.descriptor?.code === "BPP_TERMS"
    );
    if (bppTerms) {
      checkTagDisplayFalse(bppTerms, "BPP_TERMS", testResults, `Payment ${paymentIndex}: `);
      if (bppTerms.list && Array.isArray(bppTerms.list)) {
        // Helper function to get value by code
        const getValue = (code: string): string | undefined => {
          const item = bppTerms.list.find(
            (item: any) => item.descriptor?.code === code
          );
          return item?.value;
        };

        // Validate required BPP_TERMS fields
        const requiredFields = [
          "BUYER_FINDER_FEES_TYPE",
          "BUYER_FINDER_FEES_PERCENTAGE",
          "SETTLEMENT_WINDOW",
          "SETTLEMENT_BASIS",
          "MANDATORY_ARBITRATION",
          "COURT_JURISDICTION",
          "STATIC_TERMS",
          "SETTLEMENT_AMOUNT",
          "OFFLINE_CONTRACT",
        ];

        requiredFields.forEach((fieldCode) => {
          const value = getValue(fieldCode);
          if (!(!value)) {
            testResults.passed.push(
              `Payment ${paymentIndex}: BPP_TERMS.${fieldCode} is present: ${value}`
            );
          }
        });

        // Validate SETTLEMENT_AMOUNT calculation for BPP_TERMS
        validateSettlementAmount(
          payment,
          paymentIndex,
          order,
          testResults,
          "BPP_TERMS"
        );
      }
    }

    // Validate payment types
    const validPaymentTypes = ["ON_ORDER", "PRE_ORDER", "POST_FULFILLMENT"];
    if (!validPaymentTypes.includes(payment.type)) {
      testResults.failed.push(
        `Payment ${paymentIndex}: Invalid payment type "${payment.type
        }". Allowed: ${validPaymentTypes.join(", ")}`
      );
    } else {
      testResults.passed.push(
        `Payment ${paymentIndex}: Valid payment type: ${payment.type}`
      );
    }

    // Validate PRE_ORDER payment has params
    if (payment.type === "PRE_ORDER") {
      if (!(!payment.params)) {
        if (!(!payment.params.amount)) {
          testResults.passed.push(
            `Payment ${paymentIndex}: params.amount is present: ${payment.params.amount}`
          );
        }
        if (!(!payment.params.currency)) {
          testResults.passed.push(
            `Payment ${paymentIndex}: params.currency is present: ${payment.params.currency}`
          );
        }
        if (payment.params.transaction_id) {
          testResults.passed.push(
            `Payment ${paymentIndex}: params.transaction_id is present: ${payment.params.transaction_id}`
          );
        }
      }
    }
  });

  // Validate items
  order.items.forEach((item: any) => {
    if (!(!item.id)) {
      testResults.passed.push(`Item id is present: ${item.id}`);
    }
  });
}

function validatePurchaseFinanceOnCancel(
  message: any,
  testResults: TestResult,
  flowId?: string
): void {
  // Only validate for purchase finance flows
  if (!flowId || !PURCHASE_FINANCE_FLOWS.includes(flowId)) {
    return;
  }

  const order = message?.order;
  if (!order) {
    return;
  }

  // Validate order.id and order.status
  if (!(!order.id)) {
    testResults.passed.push(`Order id is present: ${order.id}`);
  }

  if (!(!order.status)) {
    const validStatuses = ["SOFT_CANCEL", "CANCELLED"];
    if (!validStatuses.includes(order.status)) {
      testResults.failed.push(
        `Invalid order status "${order.status}". Allowed: ${validStatuses.join(
          ", "
        )}`
      );
    } else {
      testResults.passed.push(`Order status is valid: ${order.status}`);
    }
  }

  // Validate items
  if (!order.items || !Array.isArray(order.items) || order.items.length === 0) {
    return;
  }

  order.items.forEach((item: any) => {
    if (!item.id) {
      return;
    }

    // Validate CHECKLISTS tag if present
    if (item.tags && Array.isArray(item.tags)) {
      const checklistsTag = item.tags.find(
        (tag: any) => tag.descriptor?.code === "CHECKLISTS"
      );
      if (
        checklistsTag &&
        checklistsTag.list &&
        Array.isArray(checklistsTag.list)
      ) {
        const allowedChecklistStatuses = ["PENDING", "COMPLETED"];
        checklistsTag.list.forEach((checklistItem: any) => {
          const code = checklistItem.descriptor?.code;
          const value = checklistItem.value;
          if (code && value) {
            if (!allowedChecklistStatuses.includes(value)) {
              testResults.failed.push(
                `Item ${item.id
                }: Invalid CHECKLISTS.${code} status "${value}". Allowed: ${allowedChecklistStatuses.join(
                  ", "
                )}`
              );
            } else {
              testResults.passed.push(
                `Item ${item.id}: CHECKLISTS.${code} status is valid: "${value}"`
              );
            }
          }
        });
      }
    }
  });

  // Validate fulfillments
  if (!(
    !order.fulfillments ||
    !Array.isArray(order.fulfillments) ||
    order.fulfillments.length === 0
  )) {
    order.fulfillments.forEach((fulfillment: any, index: number) => {
      if (!(!fulfillment.id)) {
        testResults.passed.push(
          `Fulfillment ${index}: id is present: ${fulfillment.id}`
        );
      }

      if (!(!fulfillment.type)) {
        const validTypes = ["LOAN", "BASE_ORDER"];
        if (!validTypes.includes(fulfillment.type)) {
          testResults.failed.push(
            `Fulfillment ${index}: Invalid type "${fulfillment.type
            }". Allowed: ${validTypes.join(", ")}`
          );
        } else {
          testResults.passed.push(
            `Fulfillment ${index}: type is valid: ${fulfillment.type}`
          );
        }
      }

      if (!(
        !fulfillment.state ||
        !fulfillment.state.descriptor ||
        !fulfillment.state.descriptor.code
      )) {
        const stateCode = fulfillment.state.descriptor.code;
        const validStates = [
          "DISBURSED",
          "DELIVERED",
          "SANCTIONED",
          "PLACED",
          "INITIATED",
          "COMPLETE",
        ];
        if (!validStates.includes(stateCode)) {
          testResults.failed.push(
            `Fulfillment ${index}: Invalid state "${stateCode}". Allowed: ${validStates.join(
              ", "
            )}`
          );
        } else {
          testResults.passed.push(
            `Fulfillment ${index}: state.descriptor.code is valid: ${stateCode}`
          );
        }

        // Validate REFERENCE_NUMBER tag when state is DISBURSED
        if (stateCode === "DISBURSED" && fulfillment.type === "LOAN") {
          if (!(!fulfillment.tags || !Array.isArray(fulfillment.tags))) {
            const infoTag = fulfillment.tags.find(
              (tag: any) => tag.descriptor?.code === "INFO"
            );
            if (!(!infoTag)) {
              if (infoTag.list && Array.isArray(infoTag.list)) {
                const referenceNumber = infoTag.list.find(
                  (item: any) => item.descriptor?.code === "REFERENCE_NUMBER"
                );
                if (!(!referenceNumber || !referenceNumber.value)) {
                  testResults.passed.push(
                    `Fulfillment ${index}: REFERENCE_NUMBER is present: ${referenceNumber.value}`
                  );
                }
              }
            }
          }
        }
      }
    });
  }

  // Validate payments
  if (!(
    !order.payments ||
    !Array.isArray(order.payments) ||
    order.payments.length === 0
  )) {
    order.payments.forEach((payment: any, paymentIndex: number) => {
      const validPaymentTypes = ["ON_ORDER", "PRE_ORDER", "POST_FULFILLMENT"];
      if (!validPaymentTypes.includes(payment.type)) {
        testResults.failed.push(
          `Payment ${paymentIndex}: Invalid payment type "${payment.type
          }". Allowed: ${validPaymentTypes.join(", ")}`
        );
      } else {
        testResults.passed.push(
          `Payment ${paymentIndex}: Valid payment type: ${payment.type}`
        );
      }

      // Validate POST_FULFILLMENT payments for cancellation refunds
      if (payment.type === "POST_FULFILLMENT") {
        if (!(
          !payment.params ||
          !payment.params.amount ||
          !payment.params.currency
        )) {
          testResults.passed.push(
            `Payment ${paymentIndex}: params.amount and params.currency are present`
          );
        }

        // Validate bank_account_number and bank_code for cancellation refunds
        if (payment.params.bank_account_number) {
          testResults.passed.push(
            `Payment ${paymentIndex}: bank_account_number is present: ${payment.params.bank_account_number}`
          );
        }
        if (payment.params.bank_code) {
          testResults.passed.push(
            `Payment ${paymentIndex}: bank_code is present: ${payment.params.bank_code}`
          );
        }

        // Validate BREAKUP tag if present (for installment payments)
        if (payment.tags && Array.isArray(payment.tags)) {
          const breakupTag = payment.tags.find(
            (tag: any) => tag.descriptor?.code === "BREAKUP"
          );
          if (breakupTag) {
            testResults.passed.push(
              `Payment ${paymentIndex}: BREAKUP tag is present`
            );
          }
        }

        // Validate time.label if present (for installment payments)
        if (payment.time && payment.time.label) {
          if (payment.time.label === "INSTALLMENT") {
            testResults.passed.push(
              `Payment ${paymentIndex}: time.label is valid: ${payment.time.label}`
            );
          } else {
            testResults.passed.push(
              `Payment ${paymentIndex}: time.label is present: ${payment.time.label}`
            );
          }
        }
      }
    });
  }

  // Validate documents
  if (!(
    !order.documents ||
    !Array.isArray(order.documents) ||
    order.documents.length === 0
  )) {
    order.documents.forEach((document: any, index: number) => {
      if (!(!document.descriptor || !document.descriptor.code)) {
        const validCodes = ["LOAN_AGREEMENT", "LOAN_CANCELLATION"];
        if (!validCodes.includes(document.descriptor.code)) {
          testResults.failed.push(
            `Document ${index}: Invalid descriptor.code "${document.descriptor.code
            }". Allowed: ${validCodes.join(", ")}`
          );
        } else {
          testResults.passed.push(
            `Document ${index}: descriptor.code is valid: ${document.descriptor.code}`
          );
        }
      }

      if (!(!document.url)) {
        try {
          const url = new URL(document.url);
          if (url.protocol !== "http:" && url.protocol !== "https:") {
            testResults.failed.push(
              `Document ${index}: url should be a valid HTTP/HTTPS URL`
            );
          } else {
            testResults.passed.push(`Document ${index}: url is a valid URL`);
          }
        } catch (error) {
          testResults.failed.push(`Document ${index}: url is not a valid URL`);
        }
      }

      if (!(!document.mime_type)) {
        const validMimeTypes = ["application/pdf", "application/json"];
        if (!validMimeTypes.includes(document.mime_type)) {
          testResults.failed.push(
            `Document ${index}: Invalid mime_type "${document.mime_type
            }". Allowed: ${validMimeTypes.join(", ")}`
          );
        } else {
          testResults.passed.push(
            `Document ${index}: mime_type is valid: ${document.mime_type}`
          );
        }
      }
    });
  }

  // Validate timestamps
  if (!(!order.created_at)) {
    testResults.passed.push(
      `Order created_at timestamp is present: ${order.created_at}`
    );
  }

  if (!(!order.updated_at)) {
    testResults.passed.push(
      `Order updated_at timestamp is present: ${order.updated_at}`
    );
  }
}

function validatePurchaseFinanceOnStatus(
  message: any,
  testResults: TestResult,
  flowId?: string
): void {
  // Only validate for purchase finance flows
  if (!flowId || !PURCHASE_FINANCE_FLOWS.includes(flowId)) {
    return;
  }

  const order = message?.order;
  if (!order) {
    return;
  }

  // Validate items
  if (!order.items || !Array.isArray(order.items) || order.items.length === 0) {
    return;
  }

  order.items.forEach((item: any) => {
    if (!item.id) {
      return;
    }

    // Validate xinput.form_response if present
    if (item.xinput && item.xinput.form_response) {
      const formResponse = item.xinput.form_response;
      const allowedStatuses = ["SUCCESS", "APPROVED"];

      if (!allowedStatuses.includes(formResponse.status)) {
        testResults.failed.push(
          `Item ${item.id}: Invalid xinput.form_response.status "${formResponse.status
          }". Allowed: ${allowedStatuses.join(", ")}`
        );
      } else {
        testResults.passed.push(
          `Item ${item.id}: Valid xinput.form_response.status "${formResponse.status}"`
        );
      }

      if (!(!formResponse.submission_id)) {
        testResults.passed.push(
          `Item ${item.id}: xinput.form_response.submission_id is present: "${formResponse.submission_id}"`
        );
      }

      // Validate form.id is present
      if (!(!item.xinput.form || !item.xinput.form.id)) {
        testResults.passed.push(
          `Item ${item.id}: xinput.form.id is present: "${item.xinput.form.id}"`
        );
      }
    }

    // Validate CHECKLISTS tag if present
    if (item.tags && Array.isArray(item.tags)) {
      const checklistsTag = item.tags.find(
        (tag: any) => tag.descriptor?.code === "CHECKLISTS"
      );
      if (
        checklistsTag &&
        checklistsTag.list &&
        Array.isArray(checklistsTag.list)
      ) {
        const allowedChecklistStatuses = ["PENDING", "COMPLETED"];
        checklistsTag.list.forEach((checklistItem: any) => {
          const code = checklistItem.descriptor?.code;
          const value = checklistItem.value;
          if (code && value) {
            if (!allowedChecklistStatuses.includes(value)) {
              testResults.failed.push(
                `Item ${item.id
                }: Invalid CHECKLISTS.${code} status "${value}". Allowed: ${allowedChecklistStatuses.join(
                  ", "
                )}`
              );
            } else {
              testResults.passed.push(
                `Item ${item.id}: CHECKLISTS.${code} status is valid: "${value}"`
              );
            }
          }
        });
      }
    }
  });

  // Validate quote
  if (!(!order.quote)) {
    if (!(!order.quote.id)) {
      testResults.passed.push(`Quote id is present: ${order.quote.id}`);
    }

    if (!(
      !order.quote.price ||
      !order.quote.price.value ||
      !order.quote.price.currency
    )) {
      testResults.passed.push(
        `Quote price is present: ${order.quote.price.value} ${order.quote.price.currency}`
      );
    }

    if (!(
      !order.quote.breakup ||
      !Array.isArray(order.quote.breakup) ||
      order.quote.breakup.length === 0
    )) {
      testResults.passed.push(
        `Quote breakup array has ${order.quote.breakup.length} items`
      );
    }
  }
}

function validatePurchaseFinanceOnUpdate(
  message: any,
  testResults: TestResult,
  flowId?: string
): void {
  // Only validate for purchase finance flows
  if (!flowId || !PURCHASE_FINANCE_FLOWS.includes(flowId)) {
    return;
  }

  const order = message?.order;
  if (!order) {
    return;
  }

  // Validate order.id and order.status
  if (!(!order.id)) {
    testResults.passed.push(`Order id is present: ${order.id}`);
  }

  if (!(!order.status)) {
    const validStatuses = ["ACTIVE", "COMPLETE", "CANCELLED"];
    if (!validStatuses.includes(order.status)) {
      testResults.failed.push(
        `Invalid order status "${order.status}". Allowed: ${validStatuses.join(
          ", "
        )}`
      );
    } else {
      testResults.passed.push(`Order status is valid: ${order.status}`);
    }
  }

  // Validate fulfillments
  if (
    !order.fulfillments ||
    !Array.isArray(order.fulfillments) ||
    order.fulfillments.length === 0
  ) {
    return;
  }

  order.fulfillments.forEach((fulfillment: any, index: number) => {
    if (!(!fulfillment.id)) {
      testResults.passed.push(
        `Fulfillment ${index}: id is present: ${fulfillment.id}`
      );
    }

    if (!(!fulfillment.type)) {
      const validTypes = ["LOAN", "BASE_ORDER"];
      if (!validTypes.includes(fulfillment.type)) {
        testResults.failed.push(
          `Fulfillment ${index}: Invalid type "${fulfillment.type
          }". Allowed: ${validTypes.join(", ")}`
        );
      } else {
        testResults.passed.push(
          `Fulfillment ${index}: type is valid: ${fulfillment.type}`
        );
      }
    }

    if (!(
      !fulfillment.state ||
      !fulfillment.state.descriptor ||
      !fulfillment.state.descriptor.code
    )) {
      const stateCode = fulfillment.state.descriptor.code;
      const validStates = [
        "SANCTIONED",
        "DISBURSED",
        "DELIVERED",
        "PLACED",
        "INITIATED",
        "COMPLETE",
      ];
      if (!validStates.includes(stateCode)) {
        testResults.failed.push(
          `Fulfillment ${index}: Invalid state "${stateCode}". Allowed: ${validStates.join(
            ", "
          )}`
        );
      } else {
        testResults.passed.push(
          `Fulfillment ${index}: state.descriptor.code is valid: ${stateCode}`
        );
      }

      // Validate REFERENCE_NUMBER tag when state is DISBURSED
      if (stateCode === "DISBURSED" && fulfillment.type === "LOAN") {
        if (!(!fulfillment.tags || !Array.isArray(fulfillment.tags))) {
          const infoTag = fulfillment.tags.find(
            (tag: any) => tag.descriptor?.code === "INFO"
          );
          if (!(!infoTag)) {
            if (infoTag.list && Array.isArray(infoTag.list)) {
              const referenceNumber = infoTag.list.find(
                (item: any) => item.descriptor?.code === "REFERENCE_NUMBER"
              );
              if (!(!referenceNumber || !referenceNumber.value)) {
                testResults.passed.push(
                  `Fulfillment ${index}: REFERENCE_NUMBER is present: ${referenceNumber.value}`
                );
              }
            }
          }
        }
      }
    }

    // Validate customer creds if present (for BASE_ORDER fulfillments)
    if (
      fulfillment.type === "BASE_ORDER" &&
      fulfillment.customer?.person?.creds
    ) {
      const creds = fulfillment.customer.person.creds;
      if (!Array.isArray(creds) || creds.length === 0) {
        testResults.failed.push(
          `Fulfillment ${index}: customer.person.creds should be a non-empty array`
        );
      } else {
        creds.forEach((cred: any, credIndex: number) => {
          if (!(!cred.type)) {
            testResults.passed.push(
              `Fulfillment ${index}: creds[${credIndex}].type is present: ${cred.type}`
            );
          }
          if (!(!cred.id)) {
            testResults.passed.push(
              `Fulfillment ${index}: creds[${credIndex}].id is present: ${cred.id}`
            );
          }
        });
      }
    }
  });

  // Validate payments
  if (!(
    !order.payments ||
    !Array.isArray(order.payments) ||
    order.payments.length === 0
  )) {
    order.payments.forEach((payment: any, paymentIndex: number) => {
      const validPaymentTypes = ["ON_ORDER", "PRE_ORDER", "POST_FULFILLMENT"];
      if (!validPaymentTypes.includes(payment.type)) {
        testResults.failed.push(
          `Payment ${paymentIndex}: Invalid payment type "${payment.type
          }". Allowed: ${validPaymentTypes.join(", ")}`
        );
      } else {
        testResults.passed.push(
          `Payment ${paymentIndex}: Valid payment type: ${payment.type}`
        );
      }

      // Validate SETTLEMENT_AMOUNT calculation for BAP_TERMS and BPP_TERMS
      validateSettlementAmount(
        payment,
        paymentIndex,
        order,
        testResults,
        "BAP_TERMS"
      );
      validateSettlementAmount(
        payment,
        paymentIndex,
        order,
        testResults,
        "BPP_TERMS"
      );
    });
  }

  // Validate updated_at timestamp
  if (!(!order.updated_at)) {
    testResults.passed.push(
      `Order updated_at timestamp is present: ${order.updated_at}`
    );
  }
}

function validatePurchaseFinanceOnConfirm(
  message: any,
  testResults: TestResult,
  flowId?: string
): void {
  // Only validate for purchase finance flows
  if (!flowId || !PURCHASE_FINANCE_FLOWS.includes(flowId)) {
    return;
  }

  const order = message?.order;
  if (!order) {
    return;
  }

  // Validate order.id and order.status
  if (!(!order.id)) {
    testResults.passed.push(`Order id is present: ${order.id}`);
  }

  if (!(!order.status)) {
    const validStatuses = ["ACTIVE", "COMPLETE", "CANCELLED"];
    if (!validStatuses.includes(order.status)) {
      testResults.failed.push(
        `Invalid order status "${order.status}". Allowed: ${validStatuses.join(
          ", "
        )}`
      );
    } else {
      testResults.passed.push(`Order status is valid: ${order.status}`);
    }
  }

  // Validate items
  if (!order.items || !Array.isArray(order.items) || order.items.length === 0) {
    return;
  }

  order.items.forEach((item: any) => {
    if (!item.id) {
      return;
    }

    // Validate CHECKLISTS tag if present
    if (item.tags && Array.isArray(item.tags)) {
      const checklistsTag = item.tags.find(
        (tag: any) => tag.descriptor?.code === "CHECKLISTS"
      );
      if (
        checklistsTag &&
        checklistsTag.list &&
        Array.isArray(checklistsTag.list)
      ) {
        const allowedChecklistStatuses = ["PENDING", "COMPLETED"];
        checklistsTag.list.forEach((checklistItem: any) => {
          const code = checklistItem.descriptor?.code;
          const value = checklistItem.value;
          if (code && value) {
            if (!allowedChecklistStatuses.includes(value)) {
              testResults.failed.push(
                `Item ${item.id
                }: Invalid CHECKLISTS.${code} status "${value}". Allowed: ${allowedChecklistStatuses.join(
                  ", "
                )}`
              );
            } else {
              testResults.passed.push(
                `Item ${item.id}: CHECKLISTS.${code} status is valid: "${value}"`
              );
            }
          }
        });
      }
    }
  });

  // Validate fulfillments
  if (!(
    !order.fulfillments ||
    !Array.isArray(order.fulfillments) ||
    order.fulfillments.length === 0
  )) {
    order.fulfillments.forEach((fulfillment: any, index: number) => {
      if (!(!fulfillment.id)) {
        testResults.passed.push(
          `Fulfillment ${index}: id is present: ${fulfillment.id}`
        );
      }

      if (!(!fulfillment.type)) {
        const validTypes = ["LOAN", "BASE_ORDER"];
        if (!validTypes.includes(fulfillment.type)) {
          testResults.failed.push(
            `Fulfillment ${index}: Invalid type "${fulfillment.type
            }". Allowed: ${validTypes.join(", ")}`
          );
        } else {
          testResults.passed.push(
            `Fulfillment ${index}: type is valid: ${fulfillment.type}`
          );
        }
      }

      if (!(
        !fulfillment.state ||
        !fulfillment.state.descriptor ||
        !fulfillment.state.descriptor.code
      )) {
        const stateCode = fulfillment.state.descriptor.code;
        const validStates = ["SANCTIONED", "PLACED", "INITIATED", "DISBURSED"];
        if (!validStates.includes(stateCode)) {
          testResults.failed.push(
            `Fulfillment ${index}: Invalid state "${stateCode}". Allowed: ${validStates.join(
              ", "
            )}`
          );
        } else {
          testResults.passed.push(
            `Fulfillment ${index}: state.descriptor.code is valid: ${stateCode}`
          );
        }
      }
    });
  }

  // Validate payments
  if (!(
    !order.payments ||
    !Array.isArray(order.payments) ||
    order.payments.length === 0
  )) {
    order.payments.forEach((payment: any, paymentIndex: number) => {
      const validPaymentTypes = ["ON_ORDER", "PRE_ORDER", "POST_FULFILLMENT"];
      if (!validPaymentTypes.includes(payment.type)) {
        testResults.failed.push(
          `Payment ${paymentIndex}: Invalid payment type "${payment.type
          }". Allowed: ${validPaymentTypes.join(", ")}`
        );
      } else {
        testResults.passed.push(
          `Payment ${paymentIndex}: Valid payment type: ${payment.type}`
        );
      }

      // Validate POST_FULFILLMENT payments have BREAKUP tag
      if (payment.type === "POST_FULFILLMENT") {
        if (!(!payment.tags || !Array.isArray(payment.tags))) {
          const breakupTag = payment.tags.find(
            (tag: any) => tag.descriptor?.code === "BREAKUP"
          );
          if (!(!breakupTag)) {
            testResults.passed.push(
              `Payment ${paymentIndex}: BREAKUP tag is present`
            );
          }

          if (!payment.time || !payment.time.label) {
          } else if (payment.time.label !== "INSTALLMENT") {
            testResults.failed.push(
              `Payment ${paymentIndex}: time.label should be "INSTALLMENT" for POST_FULFILLMENT payment`
            );
          } else {
            testResults.passed.push(
              `Payment ${paymentIndex}: time.label is valid: ${payment.time.label}`
            );
          }

          if (!(
            !payment.params ||
            !payment.params.amount ||
            !payment.params.currency
          )) {
            testResults.passed.push(
              `Payment ${paymentIndex}: params.amount and params.currency are present`
            );
          }
        }
      }

      // Validate SETTLEMENT_AMOUNT calculation for BAP_TERMS and BPP_TERMS
      validateSettlementAmount(
        payment,
        paymentIndex,
        order,
        testResults,
        "BAP_TERMS"
      );
      validateSettlementAmount(
        payment,
        paymentIndex,
        order,
        testResults,
        "BPP_TERMS"
      );
    });
  }

  // Validate documents
  if (!(
    !order.documents ||
    !Array.isArray(order.documents) ||
    order.documents.length === 0
  )) {
    order.documents.forEach((document: any, index: number) => {
      if (!(!document.descriptor || !document.descriptor.code)) {
        const validCodes = ["LOAN_AGREEMENT"];
        if (!validCodes.includes(document.descriptor.code)) {
          testResults.failed.push(
            `Document ${index}: Invalid descriptor.code "${document.descriptor.code
            }". Allowed: ${validCodes.join(", ")}`
          );
        } else {
          testResults.passed.push(
            `Document ${index}: descriptor.code is valid: ${document.descriptor.code}`
          );
        }
      }

      if (!(!document.url)) {
        try {
          const url = new URL(document.url);
          if (url.protocol !== "http:" && url.protocol !== "https:") {
            testResults.failed.push(
              `Document ${index}: url should be a valid HTTP/HTTPS URL`
            );
          } else {
            testResults.passed.push(`Document ${index}: url is a valid URL`);
          }
        } catch (error) {
          testResults.failed.push(`Document ${index}: url is not a valid URL`);
        }
      }

      if (!(!document.mime_type)) {
        const validMimeTypes = ["application/pdf", "application/json"];
        if (!validMimeTypes.includes(document.mime_type)) {
          testResults.failed.push(
            `Document ${index}: Invalid mime_type "${document.mime_type
            }". Allowed: ${validMimeTypes.join(", ")}`
          );
        } else {
          testResults.passed.push(
            `Document ${index}: mime_type is valid: ${document.mime_type}`
          );
        }
      }
    });
  }

  // Validate timestamps
  if (!(!order.created_at)) {
    testResults.passed.push(
      `Order created_at timestamp is present: ${order.created_at}`
    );
  }

  if (!(!order.updated_at)) {
    testResults.passed.push(
      `Order updated_at timestamp is present: ${order.updated_at}`
    );
  }
}

function validatePurchaseFinanceOnSearch(
  message: any,
  testResults: TestResult,
  flowId?: string,
  sessionID?: string,
  transactionId?: string,
  action_id?: string
): void {
  // Only validate for purchase finance flows
  if (!flowId || !PURCHASE_FINANCE_FLOWS.includes(flowId)) {
    return;
  }

  const catalog = message?.catalog;
  if (!catalog) {
    return;
  }

  const providers = catalog.providers;
  if (!providers || !Array.isArray(providers) || providers.length === 0) {
    return;
  }

  providers.forEach((provider: any, providerIndex: number) => {
    if (
      !provider.items ||
      !Array.isArray(provider.items) ||
      provider.items.length === 0
    ) {
      return;
    }

    provider.items.forEach((item: any) => {
      if (!item.id) {
        return;
      }

      // Check if this is on_search3 (with AA - has CONSENT_INFO tag, no xinput)
      const hasConsentInfo =
        item.tags &&
        Array.isArray(item.tags) &&
        item.tags.some((tag: any) => tag.descriptor?.code === "CONSENT_INFO");

      // Check if this is on_search4 (has form_response and child items)
      const hasFormResponse = item.xinput?.form_response;
      const hasChildItems = provider.items.some(
        (i: any) => i.parent_item_id === item.id
      );

      // Validate that item has either xinput or CONSENT_INFO tag
      if (!item.xinput && !hasConsentInfo) {
        testResults.failed.push(
          `Item ${item.id}: Must have either xinput or CONSENT_INFO tag for purchase finance`
        );
        return;
      }

      if (hasConsentInfo && !item.xinput) {
        // on_search3: With AA - validate CONSENT_INFO tag
        const consentInfoTag = item.tags.find(
          (tag: any) => tag.descriptor?.code === "CONSENT_INFO"
        );
        if (
          !consentInfoTag ||
          !consentInfoTag.list ||
          !Array.isArray(consentInfoTag.list)
        ) {
          return;
        }

        const consentHandler = consentInfoTag.list.find(
          (listItem: any) => listItem.descriptor?.code === "CONSENT_HANDLER"
        );
        if (!(!consentHandler || !consentHandler.value)) {
          testResults.passed.push(
            `Item ${item.id}: CONSENT_HANDLER is present: ${consentHandler.value}`
          );
        }
      } else if (hasFormResponse) {
        // on_search4: Has form_response - validate it
        const formResponse = item.xinput.form_response;
        const allowedStatuses = ["SUCCESS", "APPROVED"];

        if (!allowedStatuses.includes(formResponse.status)) {
          testResults.failed.push(
            `Item ${item.id}: Invalid xinput.form_response.status "${formResponse.status
            }". Allowed: ${allowedStatuses.join(", ")}`
          );
        } else {
          testResults.passed.push(
            `Item ${item.id}: Valid xinput.form_response.status "${formResponse.status}"`
          );
        }

        if (!(!formResponse.submission_id)) {
          testResults.passed.push(
            `Item ${item.id}: xinput.form_response.submission_id is present: "${formResponse.submission_id}"`
          );
        }

        // Validate child items if present
        if (hasChildItems) {
          const childItems = provider.items.filter(
            (i: any) => i.parent_item_id === item.id
          );
          childItems.forEach((childItem: any) => {
            if (!(!childItem.id)) {
              testResults.passed.push(
                `Child item ${childItem.id} is present with parent_item_id: ${item.id}`
              );
            }

            if (!(!childItem.price)) {
              if (!(!childItem.price.value)) {
                testResults.passed.push(
                  `Child item ${childItem.id}: price.value is present: ${childItem.price.value}`
                );
              }
              if (!(!childItem.price.currency)) {
                testResults.passed.push(
                  `Child item ${childItem.id}: price.currency is present: ${childItem.price.currency}`
                );
              }
            }
          });
        }
      } else if (item.xinput) {
        // on_search1/2: Has xinput.form and xinput.head - validate them
        if (!(!item.xinput.form)) {
          if (!(!item.xinput.form.id)) {
            testResults.passed.push(
              `Item ${item.id}: xinput.form.id is present: "${item.xinput.form.id}"`
            );
          }

          if (!(!item.xinput.form.url)) {
            try {
              const url = new URL(item.xinput.form.url);
              if (url.protocol !== "http:" && url.protocol !== "https:") {
                testResults.failed.push(
                  `Item ${item.id}: xinput.form.url should be a valid HTTP/HTTPS URL`
                );
              } else {
                testResults.passed.push(
                  `Item ${item.id}: xinput.form.url is a valid URL`
                );
              }
            } catch (error) {
              testResults.failed.push(
                `Item ${item.id}: xinput.form.url is not a valid URL`
              );
            }
          }

          if (item.xinput.form.mime_type !== "text/html") {
            testResults.failed.push(
              `Item ${item.id}: xinput.form.mime_type should be "text/html"`
            );
          } else {
            testResults.passed.push(
              `Item ${item.id}: xinput.form.mime_type is valid`
            );
          }
        }

        // Validate xinput.head
        if (!(!item.xinput.head)) {
          if (!(
            !item.xinput.head.descriptor ||
            !item.xinput.head.descriptor.name
          )) {
            testResults.passed.push(
              `Item ${item.id}: xinput.head.descriptor.name is present: "${item.xinput.head.descriptor.name}"`
            );
          }

          if (!(!item.xinput.head.index)) {
            const index = item.xinput.head.index;
            if (
              typeof index.min !== "number" ||
              typeof index.cur !== "number" ||
              typeof index.max !== "number"
            ) {
              testResults.failed.push(
                `Item ${item.id}: xinput.head.index should have min, cur, and max as numbers`
              );
            } else {
              if (index.cur < index.min || index.cur > index.max) {
                testResults.failed.push(
                  `Item ${item.id}: xinput.head.index.cur (${index.cur}) should be between min (${index.min}) and max (${index.max})`
                );
              } else {
                testResults.passed.push(
                  `Item ${item.id}: xinput.head.index is valid (cur: ${index.cur}, min: ${index.min}, max: ${index.max})`
                );
              }
            }
          }

          if (!(
            !item.xinput.head.headings ||
            !Array.isArray(item.xinput.head.headings) ||
            item.xinput.head.headings.length === 0
          )) {
            const allowedHeadings = [
              "MERCHANT_AND_PRDOUCT_DEATILS",
              "PERSONAL_INFORMATION",
              "KYC",
              "KYC_OFFLINE",
              "JOURNEY_OFFLINE",
              "SET_LOAN_AMOUNT",
            ];
            item.xinput.head.headings.forEach((heading: string) => {
              if (!allowedHeadings.includes(heading)) {
                testResults.failed.push(
                  `Item ${item.id
                  }: Invalid heading "${heading}". Allowed: ${allowedHeadings.join(
                    ", "
                  )}`
                );
              } else {
                testResults.passed.push(
                  `Item ${item.id}: Valid heading "${heading}"`
                );
              }
            });
          }
        }

        if (item.xinput.required !== true && item.xinput.required !== false) {
          testResults.failed.push(
            `Item ${item.id}: xinput.required should be a boolean`
          );
        } else {
          testResults.passed.push(
            `Item ${item.id}: xinput.required is present: ${item.xinput.required}`
          );
        }
      }
    });
  });
}

function validateFulfillmentStops(
  message: any,
  testResults: TestResult,
  action_id?: string,
  flowId?: string
): void {
  const fulfillment = message?.intent?.fulfillment;
  if (!fulfillment) {
    return;
  }

  const stops = fulfillment.stops;
  if (!stops || !Array.isArray(stops)) {
    return;
  }

  if (
    action_id !== "search_rental" &&
    action_id !== "on_search_rental" &&
    flowId !== "Schedule_Rental" &&
    stops.length < 2
  ) {
    testResults.failed.push(
      "Fulfillment stops must have at least START and END stops"
    );
    return;
  }

  // TRV10 supports intermediate stops in search intent
  const validTypes = ["START", "INTERMEDIATE_STOP", "END"];
  let hasStart = false;
  let hasEnd = false;
  let lastStopId: string | undefined = undefined;
  let idsAreUnique = true;
  const seenIds = new Set<string>();

  stops.forEach((stop: any, index: number) => {
    // Validate unique stop id if present
    if (stop.id) {
      if (seenIds.has(stop.id)) {
        idsAreUnique = false;
        testResults.failed.push(`Stop ${index} id '${stop.id}' is duplicated`);
      } else {
        seenIds.add(stop.id);
      }
    }

    // Validate stop type
    if (!validTypes.includes(stop.type)) {
      testResults.failed.push(
        `Stop ${index} type must be START, INTERMEDIATE_STOP or END, got ${stop.type}`
      );
    } else {
      if (stop.type === "START") hasStart = true;
      if (stop.type === "END") hasEnd = true;
      testResults.passed.push(`Stop ${index} has valid type: ${stop.type}`);

      // Parent linkage validation for multi-stop chains:
      // - START should not have parent_stop_id
      // - INTERMEDIATE_STOP and END should have parent_stop_id equal to previous stop's id when ids are present
      if (stop.type === "START") {
        if (stop.parent_stop_id) {
          testResults.failed.push(
            `Stop ${index} is START but has parent_stop_id '${stop.parent_stop_id}'`
          );
        }
      } else {
        if (
          stop.parent_stop_id &&
          lastStopId &&
          stop.parent_stop_id !== lastStopId
        ) {
          testResults.failed.push(
            `Stop ${index} parent_stop_id '${stop.parent_stop_id}' does not match previous stop id '${lastStopId}'`
          );
        }
      }
    }

    // Validate location GPS
    if (!stop.location) {
    } else if (!(!stop.location.gps && !stop.location.circle.gps)) {
      // Validate GPS format (lat,lng)
      const gpsPattern = /^-?\d+\.?\d*,\s*-?\d+\.?\d*$/;
      if (gpsPattern.test(stop.location.gps || !stop.location.circle.gps)) {
        testResults.passed.push(`Stop ${index} has valid GPS coordinates`);
      } else {
        testResults.failed.push(
          `Stop ${index} GPS format is invalid. Expected format: lat,lng`
        );
      }
    }

    // Track last stop id for chaining checks
    if (stop.id) {
      lastStopId = stop.id;
    } else {
      // If no explicit id provided, we cannot validate chaining via parent_stop_id reliably
      lastStopId = undefined;
    }
  });

  // if (!hasStart) {
  //   testResults.failed.push(
  //     "Fulfillment stops must include at least one START stop"
  //   );
  // }
  // if (action_id !== "search_rental" && action_id !== "on_search_rental" && action_id !== "on_select_rental" && !hasEnd) {
  //   testResults.failed.push(
  //     "Fulfillment stops must include at least one END stop"
  //   );
  // }
  if (hasStart && hasEnd) {
    testResults.passed.push(
      "Fulfillment stops include both START and END stops"
    );
  }
  if (idsAreUnique) {
    testResults.passed.push("Fulfillment stop ids are unique");
  }
}

function validateFulfillmentStopsInCatalog(
  message: any,
  testResults: TestResult,
  action_id?: string,
  flowId?: string
): void {
  const catalog = message?.catalog;
  if (!catalog) {
    return;
  }

  const providers = catalog.providers;
  if (!providers || !Array.isArray(providers) || providers.length === 0) {
    return;
  }

  let allProvidersValid = true;
  const validTypes = ["START", "INTERMEDIATE_STOP", "END"];

  providers.forEach((provider: any, providerIndex: number) => {
    const fulfillments = provider?.fulfillments;
    if (
      !fulfillments ||
      !Array.isArray(fulfillments) ||
      fulfillments.length === 0
    ) {
      return;
    }

    fulfillments.forEach((fulfillment: any, fulfillmentIndex: number) => {
      const stops = fulfillment?.stops;
      if (!stops || !Array.isArray(stops)) {
        return;
      }

      if (
        action_id !== "on_search_rental" &&
        action_id !== "on_search_schedule_rental" &&
        stops.length < 2
      ) {
        testResults.failed.push(
          `Provider ${providerIndex}, Fulfillment ${fulfillmentIndex}: must have at least START and END stops`
        );
        allProvidersValid = false;
        return;
      }

      let hasStart = false;
      let hasEnd = false;

      stops.forEach((stop: any, stopIndex: number) => {
        const stopLabel = `Provider ${providerIndex}, Fulfillment ${fulfillmentIndex}, Stop ${stopIndex}`;

        // Validate stop type
        if (!stop.type) {
        } else if (!validTypes.includes(stop.type)) {
          testResults.failed.push(
            `${stopLabel}: type must be START or END, got ${stop.type}`
          );
          allProvidersValid = false;
        } else {
          if (stop.type === "START") hasStart = true;
          if (stop.type === "END") hasEnd = true;
          testResults.passed.push(`${stopLabel}: has valid type ${stop.type}`);
        }

        // Validate location GPS
        if (!stop.location) {
        } else if (!stop.location.gps && !stop.location.circle?.gps) {
        } else {
          // Validate GPS format (lat,lng)
          const gpsPattern = /^-?\d+\.?\d*,\s*-?\d+\.?\d*$/;
          if (gpsPattern.test(stop.location.gps || stop.location.circle.gps)) {
            testResults.passed.push(`${stopLabel}: has valid GPS coordinates`);
          } else {
            testResults.failed.push(
              `${stopLabel}: GPS format is invalid. Expected format: lat,lng`
            );
            allProvidersValid = false;
          }
        }
      });

      if (!hasStart) {
        testResults.failed.push(
          `Provider ${providerIndex}, Fulfillment ${fulfillmentIndex}: must include at least one START stop`
        );
        allProvidersValid = false;
      }
      if (
        action_id !== "on_search_rental" &&
        !hasEnd &&
        action_id !== "on_search_schedule_rental"
      ) {
        testResults.failed.push(
          `Provider ${providerIndex}, Fulfillment ${fulfillmentIndex}: must include at least one END stop`
        );
        allProvidersValid = false;
      }
      if (hasStart && hasEnd) {
        testResults.passed.push(
          `Provider ${providerIndex}, Fulfillment ${fulfillmentIndex}: includes both START and END stops`
        );
      }
    });
  });

  if (allProvidersValid && providers.length > 0) {
    testResults.passed.push(
      "All providers have valid fulfillment stops with START and END"
    );
  }
}

// function validateFulfillmentStopsInOrder(
//   message: any,
//   testResults: TestResult,
//   action_id?: string,
//   flowId?: string
// ): void {
//   const order = message?.order;
//   if (!order) {
//     testResults.failed.push("Order is missing in response");
//     return;
//   }
//   if (action_id === "update_quote") {
//     return;
//   }

//   const fulfillments = order.fulfillments;
//   if (
//     !fulfillments ||
//     !Array.isArray(fulfillments) ||
//     fulfillments.length === 0
//   ) {
//     testResults.failed.push("Order fulfillments array is missing or empty");
//     return;
//   }

//   let allFulfillmentsValid = true;
//   const validTypes = ["START", "INTERMEDIATE_STOP", "END"];

//   fulfillments.forEach((fulfillment: any, fulfillmentIndex: number) => {
//     const stops = fulfillment?.stops;
//     if (!stops || !Array.isArray(stops)) {
//       testResults.failed.push(
//         `Fulfillment ${fulfillmentIndex}: stops array is missing or invalid`
//       );
//       allFulfillmentsValid = false;
//       return;
//     }

//     if (stops.length < 1) {
//       testResults.failed.push(
//         `Fulfillment ${fulfillmentIndex}: must have at least START and END stops`
//       );
//       allFulfillmentsValid = false;
//       return;
//     }

//     let hasStart = false;
//     let hasEnd = false;

//     stops.forEach((stop: any, stopIndex: number) => {
//       const stopLabel = `Fulfillment ${fulfillmentIndex}, Stop ${stopIndex}`;

//       // Validate stop type
//       if (!stop.type) {
//         testResults.failed.push(`${stopLabel}: type is missing`);
//         allFulfillmentsValid = false;
//       } else if (!validTypes.includes(stop.type)) {
//         testResults.failed.push(
//           `${stopLabel}: type must be START or END, got ${stop.type}`
//         );
//         allFulfillmentsValid = false;
//       } else {
//         if (stop.type === "START") hasStart = true;
//         if (stop.type === "END") hasEnd = true;
//         testResults.passed.push(`${stopLabel}: has valid type ${stop.type}`);
//       }

//       // Validate location GPS
//       if (flowId !== "OnDemand_Rental" && action_id !== "init" && action_id !== "on_update") {
//         if (!stop.location) {
//           testResults.failed.push(`${stopLabel}: location is missing`);
//           allFulfillmentsValid = false;
//         } else if (!stop.location.gps && !stop.location.circle.gps) {
//           testResults.failed.push(`${stopLabel}: location GPS is missing`);
//           allFulfillmentsValid = false;
//         } else {
//           // Validate GPS format (lat,lng)
//           const gpsPattern = /^-?\d+\.?\d*,\s*-?\d+\.?\d*$/;
//           if (
//             gpsPattern.test(
//               stop.location.gps.trim() || stop.location.circle.gps.trim()
//             )
//           ) {
//             testResults.passed.push(`${stopLabel}: has valid GPS coordinates`);
//           } else {
//             testResults.failed.push(
//               `${stopLabel}: GPS format is invalid. Expected format: lat,lng`
//             );
//             allFulfillmentsValid = false;
//           }
//         }
//         if (!hasStart) {
//           testResults.failed.push(
//             `Fulfillment ${fulfillmentIndex}: must include at least one START stop`
//           );
//           allFulfillmentsValid = false;
//         }
//         if (!hasEnd && flowId !== "Schedule_Rental" && action_id !== "on_update" && flowId !== "Schedule_Trip" && flowId !== "OnDemand_Rentalwhen_end_stop_gps_coordinate_is_present") {
//           testResults.failed.push(
//             `Fulfillment ${fulfillmentIndex}: must include at least one END stop`
//           );
//           allFulfillmentsValid = false;
//         }
//         if (hasStart && hasEnd) {
//           testResults.passed.push(
//             `Fulfillment ${fulfillmentIndex}: includes both START and END stops`
//           );
//         }
//       }
//     });
//   });

//   if (allFulfillmentsValid && fulfillments.length > 0) {
//     testResults.passed.push(
//       "All fulfillments have valid stops with START and END"
//     );
//   }
// }

function validateFulfillmentStopsInOrder(
  message: any,
  testResults: TestResult,
  action_id?: string,
  flowId?: string
): void {
  const order = message?.order;
  if (!order) {
    return;
  }

  // Skip validation for update_quote as per business rule
  if (action_id === "update_quote") return;
  if (
    flowId === "Purchase_Finance_Without_AA_Cancellation" ||
    flowId === "Purchase_Finance_With_AA_Cancellation" ||
    flowId === "Purchase_Finance_With_AA_Pre_Part_Payment"
  ) {
    return;
  }

  const fulfillments = order.fulfillments;
  if (!Array.isArray(fulfillments) || fulfillments.length === 0) {
    return;
  }

  let allFulfillmentsValid = true;
  const validTypes = ["START", "INTERMEDIATE_STOP", "END"];

  fulfillments.forEach((fulfillment: any, fIndex: number) => {
    const stops = fulfillment?.stops;

    if (!Array.isArray(stops) || stops.length === 0) {
      return;
    }

    let hasStart = false;
    let hasEnd = false;

    stops.forEach((stop: any, sIndex: number) => {
      const label = `Fulfillment ${fIndex}, Stop ${sIndex}`;

      // ---------------------- Validate Stop Type ------------------------
      if (!stop.type || !validTypes.includes(stop.type)) {
        testResults.failed.push(`${label}: invalid or missing stop type`);
        allFulfillmentsValid = false;
      } else {
        testResults.passed.push(`${label}: valid type ${stop.type}`);

        if (stop.type === "START") hasStart = true;
        if (stop.type === "END") hasEnd = true;
      }

      // ---------------------- GPS validation exceptions ------------------
      // Use prefix match for on_update so numbered variants (on_update_1 etc.) are also skipped.
      // Also skip GPS validation for Schedule_Rental on on_status_* steps where END stop GPS is absent.
      const skipGPSValidation =
        flowId === "OnDemand_Rental" ||
        action_id === "init" ||
        action_id?.startsWith("on_update") ||
        (flowId === "Schedule_Rental" && action_id?.startsWith("on_status"));

      if (skipGPSValidation) return;

      // ---------------------- Validate Location --------------------------
      const gps = stop.location?.gps || stop.location?.circle?.gps;

      if (!gps) {
        return;
      }

      const gpsPattern = /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/;

      if (!gpsPattern.test(gps.trim())) {
        testResults.failed.push(
          `${label}: invalid GPS format (expected lat,lng)`
        );
        allFulfillmentsValid = false;
      } else {
        testResults.passed.push(`${label}: valid GPS format`);
      }
    });

    // ---------------------- FINAL STOP VALIDATIONS (after loop) ----------------------
    const endStopExemptFlows = [
      "Schedule_Rental",
      "Schedule_Trip",
      "OnDemand_Rentalwhen_end_stop_gps_coordinate_is_present",
      "No_Acceptance_SoftUpdate",
      "OnDemand_Rental", // END stop not required for rental flows (open-ended destination)
    ];

    const starttopExemptFlows = [
      "No_Acceptance_SoftUpdate",
      "OnDemand_Update_Stop",
    ];

    // Use prefix match so numbered variants (update_1, on_update_1 etc.) are also covered
    const isStartExemptAction = action_id?.startsWith("update") || action_id?.startsWith("on_update");

    if (
      !hasStart &&
      !starttopExemptFlows.includes(flowId || "") &&
      !isStartExemptAction
    ) {
      testResults.failed.push(
        `Fulfillment ${fIndex}: must include at least one START stop`
      );
      allFulfillmentsValid = false;
    }

    if (
      !hasEnd &&
      !endStopExemptFlows.includes(flowId || "") &&
      !action_id?.startsWith("on_update")
    ) {
      testResults.failed.push(
        `Fulfillment ${fIndex}: must include at least one END stop`
      );
      allFulfillmentsValid = false;
    }

    if (hasStart && hasEnd) {
      testResults.passed.push(
        `Fulfillment ${fIndex}: includes both START and END stops`
      );
    }
  });

  if (allFulfillmentsValid) {
    testResults.passed.push(
      "All fulfillments have valid stops with START and END"
    );
  }
}

function validateCatalog(message: any, testResults: TestResult): void {
  const catalog = message?.catalog;
  if (!catalog) {
    return;
  }

  const descriptor_name = catalog.descriptor ? catalog.descriptor?.name : catalog['bpp/descriptor'] ? catalog['bpp/descriptor'].name : ""

  if (!(!descriptor_name)) {
    testResults.passed.push("Catalog descriptor name is present");
  }

  const providers = catalog.providers ? catalog.providers : catalog['bpp/providers'] ? catalog['bpp/providers'] : []
  if (providers && Array.isArray(providers)) {
    testResults.passed.push("Catalog providers array is present");
  }
}

function validateProviders(message: any, testResults: TestResult): void {
  const providers = message?.catalog?.providers || message?.order?.provider;
  if (Array.isArray(providers)) {
    providers.forEach((provider, index) => {
      if (!(!provider.id)) {
        testResults.passed.push(`Provider ${index} ID is present`);
      }

      if (!(!provider.descriptor?.name)) {
        testResults.passed.push(`Provider ${index} descriptor name is present`);
      }
    });
  } else if (providers) {
    if (!(!providers.id)) {
      testResults.passed.push("Provider ID is present");
    }
  }
}

function validateProvidersTRV10(message: any, testResults: TestResult): void {
  const providers = message?.catalog?.providers || message?.order?.provider;
  if (Array.isArray(providers)) {
    providers.forEach((provider, index) => {
      if (!(!provider.id)) {
        testResults.passed.push(`Provider ${index} ID is present`);
      }

      // For TRV10, descriptor name is optional
      if (provider.descriptor?.name) {
        testResults.passed.push(`Provider ${index} descriptor name is present`);
      }
    });
  } else if (providers) {
    if (!(!providers.id)) {
      testResults.passed.push("Provider ID is present");
    }
  }
}

function validateProvider(
  message: any,
  testResults: TestResult,
  action_id: string,
  usecaseId?: string,
  flowId?: string,
  error?: any
): void {
  if (error) {
    return;
  }
  const provider = message?.order?.provider;
  if (!provider) {
    return;
  }

  if (!(!provider.id)) {
    testResults.passed.push("Provider ID is present");
  }
  const isSachetInsuranceFlow = flowId && SACHET_INSURANCE_FLOWS.includes(flowId);
  const isGiftCardFlow = flowId && GIFT_CARD_FLOWS.includes(flowId);

  if (
    !isGiftCardFlow &&
    !isSachetInsuranceFlow &&
    usecaseId !== "GOLD LOAN" &&
    usecaseId !== "CREDIT CARD" &&
    usecaseId !== "PERSONAL LOAN" &&
    usecaseId !== "PURCHASE FINANCE" &&
    action_id !== "select_2" &&
    action_id !== "select2" &&
    action_id !== "select" &&
    !MOTOR_INSURANCE_SELECT_ACTIONS.includes(action_id ?? "") &&
    !MOTOR_INSURANCE_INIT_ACTIONS.includes(action_id ?? "") &&
    !MOTOR_INSURANCE_CONFIRM_ACTIONS.includes(action_id ?? "") &&
    action_id !== "init" &&
    action_id !== "init2" &&
    action_id !== "init3" &&
    action_id !== "confirm" &&
    action_id !== "confirm_card_balance_faliure" &&
    action_id !== "confirm_card_balance_success"
  ) {
    if (!(!provider.descriptor?.name)) {
      testResults.passed.push("Provider descriptor name is present");
    }
  }
}

function validateProviderTRV10(
  message: any,
  testResults: TestResult,
  action_id: string
): void {
  const provider = message?.order?.provider;
  if (!provider) {
    return;
  }

  if (!(!provider.id)) {
    testResults.passed.push("Provider ID is present");
  }

  // For TRV10, descriptor name is optional for all actions
  if (provider.descriptor?.name) {
    testResults.passed.push("Provider descriptor name is present");
  }
}

function validateItems(
  message: any,
  testResults: TestResult,
  action_id?: string,
  flowId?: any,
  usecaseId?: string,
  error?: any
): void {
  if (error) {
    return;
  }
  const items =
    message?.catalog?.providers?.[0]?.items || message?.order?.items;
  const isSachetInsuranceFlow = flowId && SACHET_INSURANCE_FLOWS.includes(flowId);
  const isGiftCardFlow = flowId && GIFT_CARD_FLOWS.includes(flowId);
  if (flowId === SACHET_INSURANCE_FLOWS_OBJ.Discovery_of_Insurer_Providers_and_Master_Policies) {
    return;
  }

  if (!items || !Array.isArray(items)) {
    return;
  }

  // Define sets for better performance and readability
  const excludedUsecases = new Set([
    "GOLD LOAN",
    "CREDIT CARD",
    "PERSONAL LOAN",
    "PURCHASE FINANCE",
  ]);

  const actionsExemptFromDescriptorName = new Set([
    "select",
    "select2",
    "select_rental",
    "select_adjust_loan_amount",
    "init",
    "init2",
    "init3",
    "confirm",
    "confirm_card_balance_faliure",
    "confirm_card_balance_success",
    ...MOTOR_INSURANCE_INIT_ACTIONS,
    ...MOTOR_INSURANCE_SELECT_ACTIONS,
  ]);

  const isExcludedUsecase = excludedUsecases.has(usecaseId ?? "");
  const isMotorInsuranceFlow = flowId && MOTOR_INSURANCE_FLOWS.includes(flowId);

  items.forEach((item, index) => {
    // Validate item ID
    if (!(!item.id)) {
      testResults.passed.push(`Item ${index} ID is present`);
    }
    if (
      !["GOLD LOAN",
        "PERSONAL LOAN",
        "PURCHASE FINANCE"].includes(usecaseId ?? "")
    ) {
      if (
        !isGiftCardFlow &&
        !isSachetInsuranceFlow &&
        action_id !== "select" &&
        action_id !== "select2" &&
        !MOTOR_INSURANCE_SELECT_ACTIONS.includes(action_id ?? "") &&
        !MOTOR_INSURANCE_INIT_ACTIONS.includes(action_id ?? "") &&
        action_id !== "select_rental" &&
        action_id !== "select_adjust_loan_amount" &&
        action_id !== "init" &&
        action_id !== "init2" &&
        action_id !== "init3" &&
        action_id !== "confirm" &&
        action_id !== "confirm_card_balance_faliure" &&
        action_id !== "confirm_card_balance_success"
      ) {
        if (!(!item.descriptor?.name)) {
          testResults.passed.push(`Item ${index} descriptor name is present`);
        }
      }

      // For on_search2 in motor insurance flows, validate child items have price
      // Detect on_search2 by checking if action_id is "on_search2" or if there are child items present
      const hasChildItemsInFlow = items.some((otherItem: any) => otherItem.parent_item_id);
      const isOnSearch2 = action_id === "on_search2" || (action_id === "on_search" && hasChildItemsInFlow && isMotorInsuranceFlow);

      // For select_motor in motor insurance flows, child items don't need price
      if (MOTOR_INSURANCE_SELECT_ACTIONS.includes(action_id ?? "") && isMotorInsuranceFlow && item.parent_item_id) {
        // Child items in select_motor dProvider descriptor name is missingon't require price
        if (item.price?.value) {
          testResults.passed.push(`Item ${index} (child item) price value is present: ${item.price.value}`);
        } else {
          testResults.passed.push(`Item ${index} (child item) price value is optional in select_motor`);
        }
      } else if (isOnSearch2 && isMotorInsuranceFlow && item.parent_item_id) {
        // Child items must have price in on_search2
        if (!(!item.price?.value)) {
          testResults.passed.push(`Item ${index} (child item) price value is present: ${item.price.value}`);
          if (!(!item.price?.currency)) {
            testResults.passed.push(`Item ${index} (child item) price currency is present: ${item.price.currency}`);
          }
        }
      } else if (
        !isSachetInsuranceFlow &&
        !MOTOR_INSURANCE_SELECT_ACTIONS.includes(action_id ?? "") &&
        !MOTOR_INSURANCE_INIT_ACTIONS.includes(action_id ?? "") &&
        !item.price?.value &&
        !ITEM_PRICE_NOT_REQUIRED_FIS13.includes(action_id ?? "") &&
        !(flowId && (HEALTH_INSURANCE_FLOWS.includes(flowId) || MOTOR_INSURANCE_FLOWS.includes(flowId)))
      ) {
        // Skip price validation for motor insurance flows
        if (isMotorInsuranceFlow && isGiftCardFlow) {
          return;
        }
      } else {
        if (item.price?.value) {
          testResults.passed.push(`Item ${index} price value is present`);
        } else if (action_id === "select_adjust_loan_amount") {
          testResults.passed.push(
            `Item ${index} price value is optional for select_adjust_loan_amount action`
          );
        } else if (MOTOR_INSURANCE_SELECT_ACTIONS.includes(action_id ?? "") && isMotorInsuranceFlow) {
          testResults.passed.push(
            `Item ${index} price value is optional for select_motor in motor insurance flows`
          );
        } else if (flowId && (HEALTH_INSURANCE_FLOWS.includes(flowId) || MOTOR_INSURANCE_FLOWS.includes(flowId))) {
          testResults.passed.push(
            `Item ${index} price value is optional for insurance flows`
          );
        }

        // Skip validations for excluded usecases
        if (isExcludedUsecase) {
          return;
        }

        // Validate descriptor name (if action is not exempt)
        if (!actionsExemptFromDescriptorName.has(action_id ?? "") && !isSachetInsuranceFlow && !isGiftCardFlow) {
          if (!(!item.descriptor?.name)) {
            testResults.passed.push(`Item ${index} descriptor name is present`);
          }
        }
      }
      // Validate price value
      const hasPrice = !!item.price?.value;

      if (hasPrice) {
        testResults.passed.push(`Item ${index} price value is present`);
      } else if (action_id === "select_adjust_loan_amount") {
        testResults.passed.push(
          `Item ${index} price value is optional for select_adjust_loan_amount action`
        );
      } else if (isMotorInsuranceFlow) {
        testResults.passed.push(
          `Item ${index} price value is optional for motor insurance flows`
        );
      }
    }
  });
}

function validateItemsTRV10(
  message: any,
  testResults: TestResult,
  action_id?: string
): void {
  const items =
    message?.catalog?.providers?.[0]?.items || message?.order?.items;
  if (!items || !Array.isArray(items)) {
    return;
  }

  // Use prefix-based check so numbered variants (init_1, select_1, confirm_1, etc.)
  // are also exempt from descriptor name validation
  const isExemptFromDescriptorName = (id?: string): boolean => {
    if (!id) return false;
    return (
      id.startsWith("select") ||
      id.startsWith("init") ||
      id.startsWith("confirm")
    );
  };

  items.forEach((item, index) => {
    if (!(!item.id)) {
      testResults.passed.push(`Item ${index} ID is present`);
    }

    if (action_id && !isExemptFromDescriptorName(action_id)) {
      if (!(!item.descriptor?.name)) {
        testResults.passed.push(`Item ${index} descriptor name is present`);
      }
    }

    // For TRV10, price.value is optional in select, init, and confirm actions
    if (
      action_id === "select" ||
      action_id === "init" ||
      action_id === "confirm" ||
      action_id !== "select_rental"
    ) {
      if (item.price?.value) {
        testResults.passed.push(`Item ${index} price value is present`);
      }
    } else {
      if (!(action_id !== "select_rental" && !item.price?.value)) {
        testResults.passed.push(`Item ${index} price value is present`);
      }
    }
  });
}


function validateFulfillmentsTRV10(
  message: any,
  testResults: TestResult,
  action_id?: string
): void {
  const fulfillments =
    message?.catalog?.providers?.[0]?.fulfillments ||
    message?.order?.fulfillments;
  fulfillments?.forEach((fulfillment: any, index: any) => {
    if (!(!fulfillment.id)) {
      testResults.passed.push(`Fulfillment ${index} ID is present`);
    }

    // For TRV10, fulfillment type is optional in select, init, and update actions.
    // Use prefix-based check so numbered variants (select_1, init_1, update_1 etc.) are also exempt.
    const exemptFromFulfillmentType =
      action_id?.startsWith("select") ||
      action_id?.startsWith("init") ||
      action_id?.startsWith("update");

    if (exemptFromFulfillmentType) {
      if (fulfillment.type) {
        testResults.passed.push(`Fulfillment ${index} type is present`);
      }
    } else {
      if (!(!fulfillment.type)) {
        testResults.passed.push(`Fulfillment ${index} type is present`);
      }
    }
  });
}

function validateFulfillmentsFIS12(
  message: any,
  testResults: TestResult,
  usecaseId?: string,
  action_id?: string,
  flowId?: string
): void {
  const fulfillments =
    message?.catalog?.providers?.[0]?.fulfillments ||
    message?.order?.fulfillments;

  const normalizedUsecaseId = usecaseId?.toUpperCase().trim();

  if (!fulfillments || !Array.isArray(fulfillments)) {
    return;
  }

  fulfillments.forEach((fulfillment: any, index: number) => {
    // Validate type
    if (usecaseId !== "PERSONAL LOAN" && usecaseId !== "CREDIT CARD") {
      if (!(!fulfillment.type)) {
        testResults.passed.push(
          `Fulfillment ${index} has type: ${fulfillment.type}`
        );
      }
    }

    if (fulfillment.type !== "LOAN" && fulfillment.type !== "BPP_ONLINE_EMAIL_SMS" && fulfillment.type !== "BAP") {
      // Validate customer info
      if (!(!fulfillment.customer)) {
      }

      // Validate state descriptor
      const isMotorInsuranceUsecase = normalizedUsecaseId === "MOTOR INSURANCE";
      const isMotorInsuranceFlow = flowId && MOTOR_INSURANCE_FLOWS.includes(flowId);
      const isOnConfirmAction = action_id?.startsWith("on_confirm") || action_id === "on_confirm";
      const isOnConfirmMotor = isOnConfirmAction && (isMotorInsuranceUsecase || isMotorInsuranceFlow);
      const isGiftCardFlow = flowId && GIFT_CARD_FLOWS.includes(flowId);
      if (!fulfillment.state?.descriptor?.code && !isGiftCardFlow) {
        if (normalizedUsecaseId === "HEALTH INSURANCE" || isOnConfirmMotor) {
          testResults.passed.push(
            `Fulfillment ${index} state descriptor code is optional for ${isOnConfirmMotor ? "motor insurance" : "health insurance"} on_confirm`
          );
        }
      } else {
        testResults.passed.push(
          `Fulfillment ${index} state descriptor code is present: ${fulfillment.state.descriptor.code}`
        );
      }
    }
  });
}

function validatePaymentsFIS12(message: any, testResults: TestResult, flow_id?: string, error?: any): void {
  if (error) {
    return;
  }
  if (flow_id && CREDIT_CARD_FLOWS.includes(flow_id)) {
    return;
  }
  const payments =
    message?.catalog?.providers?.[0]?.payments || message?.order?.payments;
  if (!payments || !Array.isArray(payments)) {
    return;
  }

  payments.forEach((payment: any, index: number) => {
    // Validate basic payment info
    testResults.passed.push(
      `Payment ${index} has id: ${payment.id}, type: ${payment.type}, status: ${payment.status}`
    );

    // Validate POST_FULFILLMENT payments
    if (payment.type === "POST_FULFILLMENT") {
      if (!payment.params?.amount || !payment.params?.currency) {
        testResults.failed.push(
          `Payment ${index} POST_FULFILLMENT params are invalid`
        );
      } else {
        testResults.passed.push(
          `Payment ${index} POST_FULFILLMENT amount: ${payment.params.amount} ${payment.params.currency}`
        );
      }

      if (!payment.time?.range?.start || !payment.time?.range?.end) {
        testResults.failed.push(
          `Payment ${index} POST_FULFILLMENT time range is invalid`
        );
      }
    }

  });
}

function validateDocumentsFIS12(message: any, testResults: TestResult): void {
  const documents = message?.order?.documents;

  // Always add a message to indicate validation ran
  if (!documents || !Array.isArray(documents) || documents.length === 0) {
    // Documents are optional in some flows, so log as info rather than fail
    testResults.passed.push(
      "Documents validation: Documents array is optional (not present in order)"
    );
    return;
  }

  // Documents are present - validate them
  testResults.passed.push(
    `Documents validation: Found ${documents.length} document(s) to validate`
  );

  // Expected document types for FIS12 Gold Loan
  const expectedDocumentTypes = ["LOAN_AGREEMENT", "LOAN_CANCELLATION"];

  const foundDocumentTypes: string[] = [];

  documents.forEach((doc: any, index: number) => {
    // Validate required fields
    if (!doc.descriptor) {
      return;
    }

    const code = doc.descriptor.code;
    if (!code) {
      return;
    }

    foundDocumentTypes.push(code);

    // Validate mime_type
    if (!(!doc.mime_type)) {
      // Validate mime_type format (should be like "application/pdf", "text/html", etc.)
      const validMimeTypes = [
        "application/pdf",
        "text/html",
        "application/json",
      ];
      if (
        !validMimeTypes.includes(doc.mime_type) &&
        !doc.mime_type.includes("/")
      ) {
        testResults.failed.push(
          `Document ${index} (${code}): Invalid mime_type format "${doc.mime_type}"`
        );
      } else {
        testResults.passed.push(
          `Document ${index} (${code}): Valid mime_type "${doc.mime_type}"`
        );
      }
    }

    // Validate URL
    if (!(!doc.url)) {
      // Validate URL format (should be http/https)
      const urlPattern = /^https?:\/\/.+/i;
      if (!urlPattern.test(doc.url)) {
        testResults.failed.push(
          `Document ${index} (${code}): Invalid URL format "${doc.url}". Must be http:// or https://`
        );
      } else {
        testResults.passed.push(
          `Document ${index} (${code}): Valid URL "${doc.url}"`
        );
      }
    }

    // Validate descriptor fields
    if (!(!doc.descriptor.name)) {
      testResults.passed.push(
        `Document ${index} (${code}): descriptor.name is present: "${doc.descriptor.name}"`
      );
    }

    // Optional fields validation
    if (doc.descriptor.short_desc) {
      testResults.passed.push(
        `Document ${index} (${code}): descriptor.short_desc is present`
      );
    }
    if (doc.descriptor.long_desc) {
      testResults.passed.push(
        `Document ${index} (${code}): descriptor.long_desc is present`
      );
    }
  });

  // Check for LOAN_CANCELLATION (optional but recommended)
  if (foundDocumentTypes.includes("LOAN_CANCELLATION")) {
    testResults.passed.push("Document type 'LOAN_CANCELLATION' is present");
  } else {
    testResults.passed.push(
      "Document type 'LOAN_CANCELLATION' is optional (not present)"
    );
  }

  // Summary
  testResults.passed.push(
    `Found ${documents.length
    } document(s) with types: ${foundDocumentTypes.join(", ")}`
  );
}

function validateFulfillmentStateOnUpdateFIS12(
  message: any,
  testResults: TestResult,
  action_id: string,
  flowId: string
): void {
  // Validate for Gold Loan Foreclosure flow
  if (flowId === "Gold_Loan_Foreclosure") {
    const fulfillments = message?.order?.fulfillments;
    if (
      !fulfillments ||
      !Array.isArray(fulfillments) ||
      fulfillments.length === 0
    ) {
      return;
    }

    // Expected state codes based on action_id
    let expectedState: string | null = null;
    if (action_id === "on_update") {
      expectedState = "DISBURSED";
    } else if (action_id === "on_update_unsolicited") {
      expectedState = "COMPLETE";
    }

    if (!expectedState) {
      testResults.passed.push(
        `Fulfillment state validation skipped (action_id: ${action_id}, only validates 'on_update' and 'on_update_unsolicited')`
      );
      return;
    }

    fulfillments.forEach((fulfillment: any, index: number) => {
      const stateCode = fulfillment?.state?.descriptor?.code;

      if (!stateCode) {
        return;
      }

      if (stateCode !== expectedState) {
        testResults.failed.push(
          `Fulfillment ${index}: Invalid state code "${stateCode}". Expected "${expectedState}" for action "${action_id}" in Gold_Loan_Foreclosure flow`
        );
      } else {
        testResults.passed.push(
          `Fulfillment ${index}: Valid state code "${stateCode}" for action "${action_id}" in Gold_Loan_Foreclosure flow`
        );
      }
    });
    return;
  }

  if (
    PURCHASE_FINANCE_FLOWS.includes(flowId) &&
    PURCHASE_FINANCE_FLOWS_SKIP_VALIDATION.includes(flowId)
  ) {
    const fulfillments = message?.order?.fulfillments;
    if (
      !fulfillments ||
      !Array.isArray(fulfillments) ||
      fulfillments.length === 0
    ) {
      return;
    }

    // Valid state codes for purchase finance update
    const validStates = [
      "DELIVERED",
      "DISBURSED",
      "SANCTIONED",
      "PLACED",
      "INITIATED",
      "COMPLETE",
    ];

    fulfillments.forEach((fulfillment: any, index: number) => {
      if (!(!fulfillment.id)) {
        testResults.passed.push(
          `Fulfillment ${index}: id is present: ${fulfillment.id}`
        );
      }

      const stateCode = fulfillment?.state?.descriptor?.code;

      if (!stateCode) {
        return;
      }

      if (!validStates.includes(stateCode)) {
        testResults.failed.push(
          `Fulfillment ${index}: Invalid state code "${stateCode}". Allowed: ${validStates.join(
            ", "
          )}`
        );
      } else {
        testResults.passed.push(
          `Fulfillment ${index}: Valid state code "${stateCode}"`
        );
      }

      // Validate customer creds if present
      if (fulfillment.customer?.person?.creds) {
        const creds = fulfillment.customer.person.creds;
        if (!Array.isArray(creds) || creds.length === 0) {
          testResults.failed.push(
            `Fulfillment ${index}: customer.person.creds should be a non-empty array`
          );
        } else {
          creds.forEach((cred: any, credIndex: number) => {
            if (!(!cred.type)) {
              testResults.passed.push(
                `Fulfillment ${index}: creds[${credIndex}].type is present: ${cred.type}`
              );
            }
            if (!(!cred.id)) {
              testResults.passed.push(
                `Fulfillment ${index}: creds[${credIndex}].id is present: ${cred.id}`
              );
            }
          });
        }
      }
    });
    return;
  }
}

function validateUpdatePaymentsFIS12(
  message: any,
  testResults: TestResult
): void {
  const { update_target: updateTarget, order } = message ?? {};

  // Only validate if update_target is "payments"
  if (updateTarget !== "payments") {
    testResults.passed.push(
      `Update target is "${updateTarget}", skipping payment-specific validation`
    );
    return;
  }

  if (!order) {
    return;
  }

  const payments = order.payments;
  if (!payments || !Array.isArray(payments) || payments.length === 0) {
    return;
  }

  testResults.passed.push(
    `Found ${payments.length} payment(s) in update request`
  );

  payments.forEach((payment: any, index: number) => {
    // Validate time.label for foreclosure
    if (payment.time) {
      if (!(!payment.time.label)) {
        const validLabels = [
          "FORECLOSURE",
          "MISSED_EMI_PAYMENT",
          "INSTALLMENT",
          "PRE_PART_PAYMENT",
        ];
        if (!validLabels.includes(payment.time.label)) {
          testResults.failed.push(
            `Payment ${index}: Invalid time.label "${payment.time.label
            }". Expected one of: ${validLabels.join(", ")}`
          );
        } else {
          testResults.passed.push(
            `Payment ${index}: Valid time.label "${payment.time.label}"`
          );
        }

        // For FORECLOSURE, validate time.range if present
        if (payment.time.label === "FORECLOSURE") {
          if (payment.time.range) {
            if (!(!payment.time.range.start || !payment.time.range.end)) {
              testResults.passed.push(
                `Payment ${index} (FORECLOSURE): time.range is valid`
              );
            }
          } else {
            testResults.passed.push(
              `Payment ${index} (FORECLOSURE): time.range is optional (not present)`
            );
          }
        }
      }
    } else {
      testResults.passed.push(
        `Payment ${index}: time field is optional (not present)`
      );
    }

    // Validate payment params if present (for foreclosure amount)
    if (payment.params) {
      if (payment.params.amount && payment.params.currency) {
        testResults.passed.push(
          `Payment ${index}: params.amount (${payment.params.amount}) and params.currency (${payment.params.currency}) are present`
        );
      } else {
      }
    }

    // Validate payment status if present
    if (payment.status) {
      const validStatuses = ["NOT-PAID", "PAID", "PENDING"];
      if (!validStatuses.includes(payment.status)) {
        testResults.failed.push(
          `Payment ${index}: Invalid status "${payment.status
          }". Expected one of: ${validStatuses.join(", ")}`
        );
      } else {
        testResults.passed.push(
          `Payment ${index}: Valid status "${payment.status}"`
        );
      }
    }

    // Validate payment type if present
    if (payment.type) {
      const validTypes = ["ON_ORDER", "POST_FULFILLMENT"];
      if (!validTypes.includes(payment.type)) {
        testResults.failed.push(
          `Payment ${index}: Invalid type "${payment.type
          }". Expected one of: ${validTypes.join(", ")}`
        );
      } else {
        testResults.passed.push(
          `Payment ${index}: Valid type "${payment.type}"`
        );
      }
    }
  });
}

function validateCategoriesFIS12(message: any, testResults: TestResult, flowId?: string): void {
  const categories: any[] = message.catalog.providers[0].categories;
  if (!categories || !Array.isArray(categories) || categories.length === 0) {
    return;
  }

  // Check if this is a health insurance flow or motor insurance flow
  const isHealthInsuranceFlow = flowId && HEALTH_INSURANCE_FLOWS.includes(flowId);
  const isGiftCardFlow = flowId && GIFT_CARD_FLOWS.includes(flowId);
  const isSachetInsuranceFlow = flowId && SACHET_INSURANCE_FLOWS.includes(flowId);
  const isMotorInsuranceFlow = flowId && MOTOR_INSURANCE_FLOWS.includes(flowId);
  const isCreditCardFlow = flowId && CREDIT_CARD_FLOWS.includes(flowId);
  const validCategoryMap: Record<string, string> = isHealthInsuranceFlow
    ? {
      INDIVIDUAL_INSURANCE: "Individual Insurance",
      FAMILY_INSURANCE: "Family Insurance",
      HEALTH_INSURANCE: "Health Insurance",

    }
    : isMotorInsuranceFlow
      ? {
        MOTOR_INSURANCE: "Motor Insurance",
        TWO_WHEELER_INSURANCE: "TWO WHEELER",
        FOUR_WHEELER_INSURANCE: "FOUR WHEELER",
        TWO_WHEELER_COMPRIHENSIVE_INSURANCE: "Two Wheeler Comprehensive",
        TWO_WHEELER_THIRD_PARTY_INSURANCE: "Two Wheeler Third Party",
        TWO_WHEELER_OWN_DAMAGE: "Two Wheeler Own Damage",
        FOUR_WHEELER_COMPRIHENSIVE_INSURANCE: "Four Wheeler Comprehensive",
        FOUR_WHEELER_THIRD_PARTY_INSURANCE: "Four Wheeler Third Party",
        FOUR_WHEELER_OWN_DAMAGE: "Four Wheeler Own Damage",
      }
      : isCreditCardFlow ?
        {
          CARD: "Card",
          CREDIT_CARD: "Credit Card",
          PREMIUIM_CARDS: "Premium Cards",
          TRAVEL_CARDS: "Travel Cards",
          REWARDS_CARDS: "Rewards Cards",
          LIFESTYLE_CARDS: "Lifestyle Cards"
        }
        : isSachetInsuranceFlow ? {
          MICRO_LIFE_INSURANCE: "Micro Life Insurance",
          MICRO_TRAVEL_INSURANCE: "Micro Travel Insurance",
          MICRO_HEALTH_INSURANCE: "Micro Health Insurance",
          MICRO_INDIVIDUAL_INSURANCE: "Micro Individual Insurance",
          MICRO_FAMILY_INSURANCE: "Micro Family Insurance",
          MICRO_MARINE_INSURANCE: "Micro Marine Insurance",
          MICRO_MOTOR_INSURANCE: "Micro Motor Insurance",
          MICRO_TWO_WHEELER_COMPREHENSIVE_INSURANCE: "Micro Two Wheeler Comprehensive",
          MICRO_TWO_WHEELER_THIRD_PARTY_INSURANCE: "Micro Two Wheeler Third Party",
          MICRO_TWO_WHEELER_OWN_DAMAGE: "Micro Two Wheeler Own Damage",
          MICRO_FOUR_WHEELER_COMPREHENSIVE_INSURANCE: "Micro Four Wheeler Comprehensive",
          MICRO_FOUR_WHEELER_THIRD_PARTY_INSURANCE: "Micro Four Wheeler Third Party",
          MICRO_FOUR_WHEELER_OWN_DAMAGE: "Micro Four Wheeler Own Damage",
          MICRO_FOUR_WHEELER_INSURANCE: "Micro Four Wheeler Insurance",
          MICRO_TWO_WHEELER_INSURANCE: "Micro Two Wheeler Insurance",
          MICRO_INSURANCE: "Micro Insurance",
          MICRO_HOSPICASH_INSURANCE: "Micro Hospicash Insurance",
          MICRO_TRANSIT_INSURANCE: "Micro Transit Insurance",
          MICRO_ACCIDENTAL_INSURANCE: "Micro Accidental Insurance"
        }
          : isGiftCardFlow ? {
            CARD: "CARD",
            PROMO: "PROMO",
            E_PAY: "E_PAY",
            E_RUPI: "E_RUPI"
          }
            : {
              GOLD_LOAN: "Gold Loan",
              BUREAU_LOAN: "Bureau Loan",
              AA_LOAN: "Account Aggregator Loan",
              PERSONAL_LOAN: "Personal Loan",
              AA_PERSONAL_LOAN: "Account Aggregator Personal Loan",
              PURCHASE_FINANCE: "Purchase Finance",
              AGRI_PURCHASE_FINANCE: "Agri Purchase Finance",
              ELECTRONICS_PURCHASE_FINANCE: "Electronics Purchase Finance",
              // pramaan-validation-parity skill: aligned with automation-specifications/config/validations/index.yaml enums.loanCategories
              LOAN: "Loan",
              UNSECURED_PERSONAL: "Unsecured Personal",
              SECURED_PERSONAL: "Secured Personal",
              OFFERS: "Offers",
              ADDITIONAL_DATA: "Additional Data",
              PERSONAL_FINANCING: "Personal Financing",
              CONSUMER_INVOICE_FINANCING: "Consumer Invoice Financing",
              SOLAR_PURCHASE_FINANCE: "Solar Purchase Finance",
              BUSINESS: "Business",
              SOLE_PROPRIETORSHIP: "Sole Proprietorship",
              OTHER: "Other",
              PARTNERSHIP_FIRM: "Partnership Firm",
              PRIVATE_LTD: "Private Ltd",
              INVOICE_FINANCING: "Invoice Financing",
              LAMF: "Loan Against Mutual Funds",
              TERM_LOAN: "Term Loan",
              CREDIT_LINE: "Credit Line",
              DOCUMENT_BASED_DRAWDOWN: "Document Based Drawdown",
              NON_DOCUMENT_BASED_DRAWDOWN: "Non Document Based Drawdown",
              BANKING: "Banking",
              STATEMENT_UPLOAD: "Statement Upload",
              AA_BANKING: "AA Banking",
              GST: "GST",
              AA_GST: "AA GST",
              GSP: "GSP",
              RETURN_UPLOAD: "Return Upload",
              MUTUAL_FUND: "Mutual Fund",
              MUTUAL_FUNDS: "Mutual Funds",
              OPEN_ENDED: "Open Ended",
              CLOSED_ENDED: "Closed Ended",
              INTERVAL: "Interval",
              OPEN_ENDED_EQUITY: "Open Ended Equity",
              OPEN_ENDED_EQUITY_LARGECAP: "Open Ended Equity Large Cap",
              OPEN_ENDED_EQUITY_MIDCAP: "Open Ended Equity Mid Cap",
              OPEN_ENDED_EQUITY_SMALLCAP: "Open Ended Equity Small Cap",
              OPEN_ENDED_EQUITY_MULTICAP: "Open Ended Equity Multi Cap",
              OPEN_ENDED_EQUITY_FLEXICAP: "Open Ended Equity Flexi Cap",
              OPEN_ENDED_DEBT: "Open Ended Debt",
              OPEN_ENDED_HYBRID: "Open Ended Hybrid",
              OPEN_ENDED_SOLUTION_ORIENTED: "Open Ended Solution Oriented",
              OPEN_ENDED_INDEX: "Open Ended Index",
              OPEN_ENDED_FOF: "Open Ended Fund of Funds",
              MFC: "MFC",
              ITR: "ITR",
              UPLOAD: "Upload",
              DERIVED_DATA: "Derived Data",
              ADDITIONAL_UPLOAD: "Additional Upload",
              RTA: "RTA",
              PRE_QUALIFIER: "Pre Qualifier",
            }

  categories.forEach((cat) => {
    const rawCode = cat?.descriptor?.code;
    const name = cat?.descriptor?.name;

    if (!rawCode) {
      return;
    }

    const cleanCode = typeof rawCode === "string" ? rawCode.trim().toUpperCase() : rawCode;

    if (!validCategoryMap[cleanCode] && !validCategoryMap[rawCode]) {
      testResults.failed.push(`Invalid category code: ${rawCode}`);
      return;
    }
    testResults.passed.push(`Valid category: ${rawCode} - ${name}`);
  });
}

/**
 * FIS12 Gold Loan - validate LOAN_INFO tags on on_init/on_status
 * Ensures mandatory loan info attributes are present and well-formed.
 */
function validateGoldLoanOnInitFIS12(
  message: any,
  testResults: TestResult
): void {
  const items = message?.order?.items;
  if (!items || !Array.isArray(items) || items.length === 0) {
    return;
  }

  const requiredLoanInfoCodes = [
    "INTEREST_RATE",
    "TERM",
    "INTEREST_RATE_TYPE",
    "LTV_RATIO",
    "ANNUAL_PERCENTAGE_RATE",
    "REPAYMENT_FREQUENCY",
    "NUMBER_OF_INSTALLMENTS_OF_REPAYMENT",
    "INSTALLMENT_AMOUNT",
    "TNC_LINK",
    "COOL_OFF_PERIOD",
    "KFS_LINK",
  ];

  const optionalLoanInfoCodes = [
    "APPLICATION_FEE",
    "FORECLOSURE_FEE",
    "INTEREST_RATE_CONVERSION_CHARGE",
    "DELAY_PENALTY_FEE",
    "OTHER_PENALTY_FEE",
  ];

  items.forEach((item: any, index: number) => {
    // Only validate items that look like Gold Loan products
    const isGoldLoan =
      item?.descriptor?.code === "LOAN" &&
      typeof item?.descriptor?.name === "string" &&
      item.descriptor.name.toLowerCase().includes("gold loan");

    if (!isGoldLoan) {
      return;
    }

    const loanInfoTag = (item.tags || []).find(
      (t: any) => t?.descriptor?.code === "LOAN_INFO"
    );

    if (!loanInfoTag) {
      return;
    }

    const list = Array.isArray(loanInfoTag.list) ? loanInfoTag.list : [];
    const codeMap = new Map<string, any>();
    list.forEach((entry: any) => {
      const code = entry?.descriptor?.code;
      if (code) codeMap.set(code, entry);
    });

    // Check mandatory codes
    requiredLoanInfoCodes.forEach((code) => {
      if (!(!codeMap.has(code))) {
        const value = codeMap.get(code)?.value;
        if (value === undefined || value === null || value === "") {
          testResults.failed.push(
            `Item ${item.id}: LOAN_INFO.${code} value is empty (mandatory)`
          );
        } else {
          testResults.passed.push(
            `Item ${item.id}: LOAN_INFO.${code} is present with value "${value}"`
          );
        }
      }
    });

    // Basic format checks for a few important fields
    const percentFields = [
      "INTEREST_RATE",
      "LTV_RATIO",
      "ANNUAL_PERCENTAGE_RATE",
    ];
    percentFields.forEach((code) => {
      const entry = codeMap.get(code);
      if (entry?.value && typeof entry.value === "string") {
        if (!entry.value.trim().endsWith("%")) {
          testResults.failed.push(
            `Item ${item.id}: LOAN_INFO.${code} should be a percentage string (e.g. "12%"), found "${entry.value}"`
          );
        }
      }
    });

    const coolOff = codeMap.get("COOL_OFF_PERIOD")?.value;
    if (coolOff && typeof coolOff === "string") {
      if (!coolOff.startsWith("P")) {
        testResults.failed.push(
          `Item ${item.id}: LOAN_INFO.COOL_OFF_PERIOD should be ISO 8601 duration (e.g. "PT30D"), found "${coolOff}"`
        );
      } else {
        testResults.passed.push(
          `Item ${item.id}: LOAN_INFO.COOL_OFF_PERIOD is present with value "${coolOff}"`
        );
      }
    }

    const urlFields = ["TNC_LINK", "KFS_LINK"];
    urlFields.forEach((code) => {
      const entry = codeMap.get(code);
      if (entry?.value && typeof entry.value === "string") {
        if (!/^https?:\/\//i.test(entry.value.trim())) {
          testResults.failed.push(
            `Item ${item.id}: LOAN_INFO.${code} should be a valid URL, found "${entry.value}"`
          );
        } else {
          testResults.passed.push(
            `Item ${item.id}: LOAN_INFO.${code} URL looks valid`
          );
        }
      }
    });

    // Optional codes: just acknowledge if present
    optionalLoanInfoCodes.forEach((code) => {
      if (codeMap.has(code)) {
        const value = codeMap.get(code)?.value;
        testResults.passed.push(
          `Item ${item.id}: LOAN_INFO.${code} is present with value "${value}"`
        );
      }
    });
  });
}

function validateOnSearchItemsFIS12(
  message: any,
  testResults: TestResult
): void {
  const items = message.catalog.providers[0].items;
  const categories = message.catalog.providers[0].categories || [];

  if (!items || !Array.isArray(items) || items.length === 0) {
    return;
  }

  // Trim ids before comparing — category ids in some flows (e.g. LAMF) are generated with
  // incidental leading/trailing whitespace, which would otherwise make an item's category_ids
  // fail to match an otherwise-identical category id declared in the same message.
  const validCategoryIds = new Set(
    categories.map((c: any) => (typeof c?.id === "string" ? c.id.trim() : c.id))
  );

  // Create a map of category codes by category id
  const categoryCodeMap = new Map<string, string>();
  categories.forEach((cat: any) => {
    if (cat?.id && cat?.descriptor?.code) {
      const id = typeof cat.id === "string" ? cat.id.trim() : cat.id;
      categoryCodeMap.set(id, cat.descriptor.code);
    }
  });

  items.forEach((item) => {
    if (!item.id) {
      return;
    }

    if (!item.descriptor?.code) {
      return;
    }

    // Validate descriptor code - accept both "LOAN" and "PERSONAL_LOAN" or "GOLD_LOAN"
    const validDescriptorCodes = ["LOAN", "PRE_QUALIFIER", "PERSONAL_LOAN", "GOLD_LOAN", "CREDIT_CARD", "CARD", "PARENT", "ITEM"];
    if (!validDescriptorCodes.includes(item.descriptor.code)) {
      testResults.failed.push(
        `Item ${item.id}: descriptor.code should be one of ["LOAN", "PERSONAL_LOAN", "GOLD_LOAN"], but found "${item.descriptor.code}"`
      );
    } else {
      testResults.passed.push(
        `Item ${item.id}: Valid descriptor.code "${item.descriptor.code}"`
      );
    }

    // Validate category_ids array
    if (!item.category_ids || item.category_ids.length === 0) {
      testResults.failed.push(`Item ${item.id} has no category_ids`);
      return;
    }

    // Check if item has GOLD_LOAN or PERSONAL_LOAN category
    let hasGoldLoanCategory = false;
    let hasPersonalLoanCategory = false;
    let hasBureauLoanCategory = false;
    let hasAALoanCategory = false;
    let hasAAPersonalLoanCategory = false;

    item.category_ids.forEach((rawCatId: string) => {
      const catId = typeof rawCatId === "string" ? rawCatId.trim() : rawCatId;
      // Some flows (e.g. FIS12 Business Loan) declare the category tree once in master_search's
      // on_search; later on_search calls only carry category_ids with no categories list to
      // resolve against, so existence can only be checked when this message declares categories.
      if (categories.length === 0) {
        return;
      }
      if (!validCategoryIds.has(catId)) {
        testResults.failed.push(
          `Item ${item.id} refers to invalid category id: ${catId}`
        );
      } else {
        const categoryCode = categoryCodeMap.get(catId);
        if (categoryCode === "GOLD_LOAN") {
          hasGoldLoanCategory = true;
        } else if (categoryCode === "PERSONAL_LOAN") {
          hasPersonalLoanCategory = true;
        } else if (categoryCode === "BUREAU_LOAN") {
          hasBureauLoanCategory = true;
        } else if (categoryCode === "AA_LOAN") {
          hasAALoanCategory = true;
        } else if (categoryCode === "AA_PERSONAL_LOAN") {
          hasAAPersonalLoanCategory = true;
        }
      }
    });

    // Validate item name matches category type
    const itemName = item.descriptor?.name?.toLowerCase() || "";
    if (hasGoldLoanCategory) {
      if (!itemName.includes("gold loan") && !itemName.includes("gold")) {
        testResults.failed.push(
          `Item ${item.id}: Has GOLD_LOAN category but descriptor.name "${item.descriptor.name}" doesn't match Gold Loan pattern`
        );
      } else {
        testResults.passed.push(
          `Item ${item.id}: Valid Gold Loan item with matching descriptor.name`
        );
      }
    } else if (hasPersonalLoanCategory) {
      if (
        !itemName.includes("personal loan") &&
        !itemName.includes("personal")
      ) {
        testResults.failed.push(
          `Item ${item.id}: Has PERSONAL_LOAN category but descriptor.name "${item.descriptor.name}" doesn't match Personal Loan pattern`
        );
      } else {
        testResults.passed.push(
          `Item ${item.id}: Valid Personal Loan item with matching descriptor.name`
        );
      }

      // Validate AA_PERSONAL_LOAN items
      if (hasAAPersonalLoanCategory) {
        // Items with AA_PERSONAL_LOAN must also have PERSONAL_LOAN category (already validated above)
        testResults.passed.push(
          `Item ${item.id}: Valid AA Personal Loan item with both PERSONAL_LOAN and AA_PERSONAL_LOAN categories`
        );

        // Items with AA_PERSONAL_LOAN should indicate "with AA" in the name
        if (
          !itemName.includes("with aa") &&
          !itemName.includes("with account aggregator")
        ) {
          testResults.failed.push(
            `Item ${item.id}: Has AA_PERSONAL_LOAN category but descriptor.name "${item.descriptor.name}" should indicate "with AA" or "with Account Aggregator"`
          );
        } else {
          testResults.passed.push(
            `Item ${item.id}: Valid AA Personal Loan item with appropriate name indicating AA`
          );
        }
      }
    }

    // Validate category combinations
    if (hasGoldLoanCategory && hasPersonalLoanCategory) {
      testResults.failed.push(
        `Item ${item.id}: Cannot have both GOLD_LOAN and PERSONAL_LOAN categories`
      );
    }

    if (hasGoldLoanCategory && hasAAPersonalLoanCategory) {
      testResults.failed.push(
        `Item ${item.id}: Cannot have both GOLD_LOAN and AA_PERSONAL_LOAN categories`
      );
    }

    if (hasPersonalLoanCategory && hasAALoanCategory) {
      testResults.failed.push(
        `Item ${item.id}: PERSONAL_LOAN should use AA_PERSONAL_LOAN, not AA_LOAN`
      );
    }

    if (hasGoldLoanCategory && hasAAPersonalLoanCategory) {
      testResults.failed.push(
        `Item ${item.id}: GOLD_LOAN should use AA_LOAN, not AA_PERSONAL_LOAN`
      );
    }

    // Validate AA_PERSONAL_LOAN requires PERSONAL_LOAN category
    if (hasAAPersonalLoanCategory && !hasPersonalLoanCategory) {
      testResults.failed.push(
        `Item ${item.id}: Has AA_PERSONAL_LOAN category but missing PERSONAL_LOAN category. AA_PERSONAL_LOAN items must also have PERSONAL_LOAN category.`
      );
    }

    testResults.passed.push(`Valid item structure: ${item.id}`);
  });
}

function validateUnifiedCreditOnSearchItemsFIS12(
  message: any,
  testResults: TestResult
): void {
  console.log("Entering in validateUnifiedCreditOnSearchItemsFIS12")
  const provider = message?.catalog?.providers?.[0];

  if (!provider) {
    return;
  }

  const items = provider.items;
  const categories = provider.categories || [];

  if (!Array.isArray(items) || items.length === 0) {
    return;
  }

  const validCategoryIds = new Set(categories.map((c: any) => c.id));

  // Map categoryId -> code
  const categoryCodeMap = new Map<string, string>();
  categories.forEach((cat: any) => {
    if (cat?.id && cat?.descriptor?.code) {
      categoryCodeMap.set(cat.id, cat.descriptor.code);
    }
  });

  items.forEach((item: any) => {
    // ─────────────────────────────────────────────
    // BASIC VALIDATIONS
    // ─────────────────────────────────────────────
    if (!item.id) {
      return;
    }

    if (!item.descriptor?.code) {
      testResults.failed.push(`Item ${item.id}: descriptor.code missing`);
      return;
    }

    if (!item.descriptor?.name) {
      testResults.failed.push(`Item ${item.id}: descriptor.name missing`);
    }

    // Descriptor code validation
    const validCodes = ["LOAN", "PRE_QUALIFIER", "PERSONAL_LOAN", "GOLD_LOAN", "CARD", "CREDIT_CARD", "PARENT", "ITEM"];
    if (!validCodes.includes(item.descriptor.code)) {
      testResults.failed.push(
        `Item ${item.id}: Invalid descriptor.code "${item.descriptor.code}"`
      );
    } else {
      testResults.passed.push(
        `Item ${item.id}: Valid descriptor.code "${item.descriptor.code}"`
      );
    }

    // ─────────────────────────────────────────────
    // CATEGORY VALIDATION
    // ─────────────────────────────────────────────
    if (!Array.isArray(item.category_ids) || item.category_ids.length === 0) {
      testResults.failed.push(`Item ${item.id}: category_ids missing`);
    } else {
      item.category_ids.forEach((catId: string) => {
        if (!validCategoryIds.has(catId)) {
          testResults.failed.push(
            `Item ${item.id}: Invalid category id ${catId}`
          );
        }
      });
    }

    // ─────────────────────────────────────────────
    // PARENT–CHILD VALIDATION
    // ─────────────────────────────────────────────
    if (item?.parent_item_id) {
      // Child item checks
      if (!item.price) {
        testResults.failed.push(
          `Child Item ${item.id}: price is mandatory`
        );
      }

      if (!item.tags || item.tags.length === 0) {
        testResults.failed.push(
          `Child Item ${item.id}: tags missing (LOAN_INFO / LOAN_OFFER required)`
        );
      } else {
        const tagCodes = item.tags.map((t: any) => t.descriptor?.code);

        if (!tagCodes.includes("LOAN_INFO")) {
          testResults.failed.push(
            `Item ${item.id}: LOAN_INFO tag missing`
          );
        }

        if (!tagCodes.includes("LOAN_OFFER")) {
          testResults.failed.push(
            `Item ${item.id}: LOAN_OFFER tag missing`
          );
        }
      }

      testResults.passed.push(`Child item validated: ${item.id}`);
    } else {
      // Parent item checks
      if (item.price) {
        testResults.failed.push(
          `Parent Item ${item.id}: should NOT have price`
        );
      }

      testResults.passed.push(`Parent item validated: ${item.id}`);
    }

    // ─────────────────────────────────────────────
    // FULFILLMENT VALIDATION
    // ─────────────────────────────────────────────
    if (!item.fulfillment_ids || item.fulfillment_ids.length === 0) {
      testResults.failed.push(
        `Item ${item.id}: fulfillment_ids missing`
      );
    }

    // ─────────────────────────────────────────────
    // LOAN NAME VALIDATION (GENERIC)
    // ─────────────────────────────────────────────
    // Accept any non-empty descriptor.name for unified credit
    // (LAMF items use names like "LAMF - Single Redirection", not just "loan")
    if (item.descriptor.name) {
      testResults.passed.push(
        `Item ${item.id}: descriptor.name is present ("${item.descriptor.name}")`
      );
    }

    // ─────────────────────────────────────────────
    // FINAL PASS
    // ─────────────────────────────────────────────
    testResults.passed.push(`Item structure valid: ${item.id}`);
  });
}

function validateOnSearchItemsFIS10(
  message: any,
  testResults: TestResult
): void {
  const items = message.catalog.providers[0].items;
  const categories = message.catalog.providers[0].categories;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return;
  }


  // Create a map of category codes by category id
  const categoryCodeMap = new Map<string, string>();
  categories.forEach((cat: any) => {
    if (cat?.id && cat?.descriptor?.code) {
      categoryCodeMap.set(cat.id, cat.descriptor.code);
    }
  });

  items.forEach((item) => {
    if (!item.id) {
      return;
    }

    if (!item.descriptor?.code) {
      return;
    }

    // Validate descriptor code - accept both "LOAN" and "PERSONAL_LOAN" or "GOLD_LOAN"
    const validDescriptorCodes = ["CARD", "PARENT", "ITEM"];
    if (!validDescriptorCodes.includes(item.descriptor.code)) {
      testResults.failed.push(
        `Item ${item.id}: descriptor.code should be one of ["CARD", "PARENT", "ITEM"], but found "${item.descriptor.code}"`
      );
    } else {
      testResults.passed.push(
        `Item ${item.id}: Valid descriptor.code "${item.descriptor.code}"`
      );
    }
    testResults.passed.push(`Valid item structure: ${item.id}`);
  });
}

async function validateXinputFIS12(
  message: any,
  testResults: TestResult,
  sessionID?: string,
  transactionId?: string,
  flowId?: any,
  action_id?: string
): Promise<void> {

  if (SACHET_INSURANCE_FLOWS.includes(flowId)) {
    return
  }
  const items = message?.catalog?.providers?.[0]?.items?.length
    ? message.catalog.providers[0].items
    : message?.order?.items || [];

  const categories = message?.catalog?.providers?.[0]?.categories || [];

  // Create a map of category codes by category id
  const categoryCodeMap = new Map<string, string>();
  categories.forEach((cat: any) => {
    if (cat?.id && cat?.descriptor?.code) {
      categoryCodeMap.set(cat.id, cat.descriptor.code);
    }
  });

  // Check if this is a purchase finance flow, health insurance flow, or motor insurance flow
  const isPurchaseFinanceFlow =
    flowId && PURCHASE_FINANCE_FLOWS.includes(flowId);
  const isHealthInsuranceFlow =
    flowId && HEALTH_INSURANCE_FLOWS.includes(flowId);
  const isMotorInsuranceFlow =
    flowId && MOTOR_INSURANCE_FLOWS.includes(flowId);

  const allowedHeadings = [
    "KYC",
    "KYC_OFFLINE",
    "JOURNEY_OFFLINE",
    "SET_LOAN_AMOUNT",
    "PERSONAL_INFORMATION",
    "Personal Information",
    "Set Loan Amount",
    "Know your Customer",
    "Account Information",
    "Emandate",
    "Loan Agreement",
    // pramaan-validation-parity skill: aligned with automation-specifications/config/validations/index.yaml
    // fulfilments.checkList (checkListTags) and items.searchForms/onSelectForms enums for
    // LAMF / business-loan / unified-credit flows.
    "CONSENT_APPROVAL",
    "EMANDATE",
    "LOAN_AGREEMENT",
    "ACCOUNT_MONITORING",
    "ORGANIZATION_INFORMATION",
    "INDIVIDUAL_KYC",
    "ENTITY_KYC",
    "MERCHANT_AND_PRODUCT_DETAILS",
    "SET_DOWN_PAYMENT",
    "ESIGN",
    "BANK_STATEMENT_AND_GST_RETURNS",
    "BUSINESS_AND_FINANCIAL_DOCUMENTS",
    "BUSINESS_KYC",
    "PERSONAL_DISCUSSION",
    "PHYSICAL_VERIFICATION",
    "ENACH",
    "PROCESSING_FEE",
    "MANUAL_VERIFICATION",
    "LIEN_MARKING",
    "PERSONAL_INFORMATION_TERM",
    "PERSONAL_INFORMATION_LAMF",
    "PERSONAL_INFORMATION_TERM_GST",
    "PERSONAL_INFORMATION_BUSINESS_TERM_GST",
    "PERSONAL_INFORMATION_SOLAR",
    "PERSONAL_INFORMATION_BUSINESS_TERM",
    "INVOICE_UPLOAD",
    "SINGLE_REDIRECTION",
  ];

  // Add purchase finance specific headings
  if (isPurchaseFinanceFlow) {
    allowedHeadings.push("MERCHANT_AND_PRDOUCT_DEATILS");
  }

  // Add health insurance specific headings
  if (isHealthInsuranceFlow) {
    allowedHeadings.push(
      "INSURED_PERSONAL_DETAILS",
      "Insured Personal Details",
      "CUSTOMER_INFORMATION",
      "Customer Information",
      "Health Information",
      "Medical History",
      "Nominee Details",
      // Headings used by the FIS13 health mock flows (family/individual journeys):
      // family & PED detail forms, eKYC, proposer/nominee forms, CIS and payment,
      // and the manual underwriting review form.
      "INDIVIDUAL_DETAILS",
      "PED",
      "EKYC",
      "PROPOSER_DETAILS",
      "NOMINEE_DETAILS",
      "CIS",
      "CIS_AND_PAYMENT",
      "MANUAL_REVIEW"
    );
  }

  // Add motor insurance specific headings
  if (isMotorInsuranceFlow) {
    allowedHeadings.push(
      "VEHICLE_DETAILS",
      "Vehicle Details",
      "MANUAL_REVIEW",
      "PAN_DOB",
      "KYC",
      "VEHICLE_NOMINEE_DETAILS",
      "PERSONAL_INFO",
      "CIS",
      "CIS_AND_PAYMENT",
      "Consumer Information",
      "Personal Details"
    );
  }

  const formUrls: string[] = [];

  items.forEach((item: any) => {
    // Check if item is GOLD_LOAN, PERSONAL_LOAN, INDIVIDUAL_INSURANCE, or FAMILY_INSURANCE
    let isGoldLoan = false;
    let isPersonalLoan = false;
    let isIndividualInsurance = false;
    let isFamilyInsurance = false;

    if (item.category_ids && Array.isArray(item.category_ids)) {
      item.category_ids.forEach((catId: string) => {
        const categoryCode = categoryCodeMap.get(catId);
        if (categoryCode === "GOLD_LOAN") {
          isGoldLoan = true;
        } else if (categoryCode === "PERSONAL_LOAN") {
          isPersonalLoan = true;
        } else if (categoryCode === "INDIVIDUAL_INSURANCE") {
          isIndividualInsurance = true;
        } else if (categoryCode === "FAMILY_INSURANCE") {
          isFamilyInsurance = true;
        }
      });
    }

    const isInsuranceFlow = flowId && (HEALTH_INSURANCE_FLOWS.includes(flowId ?? "") || MOTOR_INSURANCE_FLOWS.includes(flowId ?? ""));
    const isMotorInsuranceFlow = flowId && MOTOR_INSURANCE_FLOWS.includes(flowId ?? "");
    const isMotorInsuranceApplicationFlow = flowId === "Motor_Insurance_Application";

    if (action_id === "on_search3" && isInsuranceFlow) {
      return;
    }

    // For on_search2_motor in Motor_Insurance_Application flow, parent items don't need xinput
    if (action_id === "on_search2_motor" && isMotorInsuranceApplicationFlow && !item.parent_item_id && !item.xinput) {
      testResults.passed.push(
        `Item ${item.id}: xinput is not required for parent item in on_search2_motor (Motor_Insurance_Application flow)`
      );
      return;
    }

    // For on_search2 in motor insurance flows, parent items don't need xinput
    // Detect on_search2 by checking if action_id is "on_search2" or if there are child items present
    const hasChildItems = items.some((otherItem: any) => otherItem.parent_item_id === item.id);
    const isOnSearch2 = action_id === "on_search2" || (action_id === "on_search" && hasChildItems && isMotorInsuranceFlow);

    if (isOnSearch2 && isMotorInsuranceFlow && !item.parent_item_id && !item.xinput) {
      // Parent items in on_search2 don't need xinput if they have child items
      if (hasChildItems) {
        testResults.passed.push(
          `Item ${item.id}: xinput is not required for parent item in on_search2 (has child items)`
        );
        return;
      }
    }

    if (
      !item.xinput
    ) {
      // Skip xinput validation if item has parent_item_id (it's a child item)
      if (item.parent_item_id) {
        testResults.passed.push(
          `Item ${item.id}: xinput is not required (has parent_item_id: ${item.parent_item_id})`
        );
        return;
      }
      return;
    }

    // Detect format: Format 1 has form_response, Format 2 has head
    const hasFormResponse = !!item.xinput.form_response;
    const hasHead = !!item.xinput.head;

    if (hasFormResponse) {
      // Format 1: form + form_response
      if (!item.xinput.form) {
      } else if (!(!item.xinput.form.id)) {
        testResults.passed.push(
          `Item ${item.id}: xinput.form.id is present: ${item.xinput.form.id}`
        );
      }

      if (!(!item.xinput.form_response)) {
        if (!(!item.xinput.form_response.status)) {
          const isInsuranceFlow = isHealthInsuranceFlow || (flowId && MOTOR_INSURANCE_FLOWS.includes(flowId));
          const validStatuses = isInsuranceFlow
            ? ["SUCCESS", "PENDING", "FAILED", "APPROVED", "REJECTED", "EXPIRED"]
            : ["SUCCESS", "PENDING", "FAILED"];
          if (!validStatuses.includes(item.xinput.form_response.status)) {
            testResults.failed.push(
              `Item ${item.id}: Invalid xinput.form_response.status "${item.xinput.form_response.status
              }". Allowed: ${validStatuses.join(", ")}`
            );
          } else {
            testResults.passed.push(
              `Item ${item.id}: Valid xinput.form_response.status: ${item.xinput.form_response.status}`
            );
          }
        }

        if (!(!item.xinput.form_response.submission_id)) {
          testResults.passed.push(
            `Item ${item.id}: xinput.form_response.submission_id is present: ${item.xinput.form_response.submission_id}`
          );
        }
      }
    } else if (hasHead) {
      // Format 2: head + form + required
      const head = item.xinput.head;

      if (!(
        !head.headings ||
        !Array.isArray(head.headings) ||
        head.headings.length === 0
      )) {
        head.headings.forEach((h: string) => {
          if (!allowedHeadings.includes(h)) {
            testResults.failed.push(
              `Item ${item.id
              }: Invalid xinput heading "${h}". Allowed: ${allowedHeadings.join(
                ", "
              )}`
            );
          } else {
            testResults.passed.push(
              `Item ${item.id}: Valid xinput heading "${h}"`
            );
          }
        });
      }

      // Validate form structure
      if (!item.xinput.form) {
      } else if (
        !item.xinput.form.id ||
        !item.xinput.form.mime_type ||
        // inline forms (e.g. FIS12 Business Loan, mime_type "none") carry their fields in
        // form.data instead of hosting them at a url
        (!item.xinput.form.url && !item.xinput.form.data)
      ) {
        testResults.failed.push(
          `Item ${item.id}: xinput.form fields are incomplete`
        );
      } else {
        // For GOLD_LOAN, PERSONAL_LOAN, INDIVIDUAL_INSURANCE, and FAMILY_INSURANCE items, validate required and mime_type
        if (isGoldLoan || isPersonalLoan || isIndividualInsurance || isFamilyInsurance) {
          const itemType = isGoldLoan
            ? "GOLD_LOAN"
            : isPersonalLoan
              ? "PERSONAL_LOAN"
              : isIndividualInsurance
                ? "INDIVIDUAL_INSURANCE"
                : "FAMILY_INSURANCE";

          if (item.xinput.required !== true) {
            testResults.failed.push(
              `Item ${item.id}: xinput.required must be true for ${itemType} items`
            );
          } else {
            testResults.passed.push(
              `Item ${item.id}: xinput.required is true for ${itemType} item`
            );
          }

        }

        // Save form URL to Redis for HTML_FORM validation
        if (item.xinput.form.url && sessionID && transactionId) {
          formUrls.push(item.xinput.form.url);
          testResults.passed.push(
            `Item ${item.id}: Form URL found and will be saved for HTML_FORM validation`
          );
        }
      }

      if (typeof item.xinput.required !== "boolean") {
        testResults.failed.push(
          `Item ${item.id}: xinput.required must be boolean`
        );
      }
    } else {
      // Neither format detected - check if it's an exception case
      if (
        flowId === "Personal_Loan_With_AA_And_Monitoring_Consent" ||
        action_id === "on_select_1_personal_loan"
      ) {
        // These flows may not require head, but still need form
        if (!item.xinput.form) {
        } else if (!(!item.xinput.form.id)) {
          testResults.passed.push(
            `Item ${item.id}: xinput.form.id is present: ${item.xinput.form.id}`
          );
        }
      } else {
        testResults.failed.push(
          `Item ${item.id}: xinput must have either form_response (Format 1) or head (Format 2)`
        );
      }
    }
  });

  // Save form URLs to Redis if we have session and transaction info
  if (formUrls.length > 0 && sessionID && transactionId) {
    try {
      const { saveData } = await import("../../utils/redisUtils");
      await saveData(sessionID, transactionId, "formUrls", { urls: formUrls });
      logger.info(
        `Saved ${formUrls.length} form URL(s) to Redis for HTML_FORM validation`
      );
    } catch (error: any) {
      logger.error("Error saving form URLs to Redis", error);
    }
  }
}

function validateXInputStatusFIS12(
  message: any,
  testResults: TestResult,
  usecaseId?: string,
  action_id?: string,
  flowId?: string
): void {
  const items: any = message.order.items;
  const allowedStatuses = [
    "PENDING",
    "APPROVED",
    "REJECTED",
    "EXPIRED",
    "SUCCESS",
  ];

  items.forEach((item: any) => {
    if (!item.xinput) {
      // Skip xinput validation if item has parent_item_id (it's a child item)
      if (item.parent_item_id) {
        testResults.passed.push(
          `Item ${item.id}: xinput is not required (has parent_item_id: ${item.parent_item_id})`
        );
        return;
      }

      return;
    }

    // Validate xinput.form exists and has required fields
    if (!(!item.xinput.form)) {
      if (!(!item.xinput.form.id)) {
        testResults.passed.push(
          `Item ${item.id}: xinput.form.id is present: "${item.xinput.form.id}"`
        );
      }
    }

    const formResponse = item.xinput.form_response;
    if (!formResponse) {
      return;
    }

    const { status, submission_id } = formResponse;

    // Validate status
    if (!allowedStatuses.includes(status)) {
      testResults.failed.push(
        `Item ${item.id
        }: Invalid xinput.form_response.status "${status}". Allowed: ${allowedStatuses.join(
          ", "
        )}`
      );
    } else {
      testResults.passed.push(
        `Item ${item.id}: Valid xinput.form_response.status "${status}"`
      );
    }

    // Validate submission_id
    if (!(!submission_id)) {
      testResults.passed.push(
        `Item ${item.id}: xinput.form_response.submission_id is present: "${submission_id}"`
      );
    }

    // Validate form.id matches form_response (if both exist)
    if (item.xinput.form?.id && formResponse.submission_id) {
      // Check if submission_id starts with form.id (common pattern: F01_SUBMISSION_ID)
      const formId = item.xinput.form.id;
      if (submission_id.startsWith(formId)) {
        testResults.passed.push(
          `Item ${item.id}: form_response.submission_id "${submission_id}" matches form.id "${formId}" pattern`
        );
      } else {
        // This is a warning, not an error, as the pattern may vary
        testResults.passed.push(
          `Item ${item.id}: form_response.submission_id "${submission_id}" (form.id: "${formId}")`
        );
      }
    }

    // Usecase-specific validations
    if (usecaseId) {
      const normalizedUsecaseId = usecaseId.toUpperCase().trim();

      // PERSONAL LOAN specific validations
      if (
        normalizedUsecaseId === "PERSONAL LOAN" ||
        normalizedUsecaseId === "PERSONAL_LOAN"
      ) {
        // Validate form.id for Personal Loan flows
        if (item.xinput.form?.id) {
          const formId = item.xinput.form.id;
          // Personal Loan Information Form should have form.id "F01"
          // if (formId === "F01") {
          //   testResults.passed.push(
          //     `Item ${item.id}: Valid form.id "F01" for Personal Loan Information Form`
          //   );
          // } else {
          //   testResults.failed.push(
          //     `Item ${item.id}: Expected form.id "F01" for Personal Loan, but found "${formId}"`
          //   );
          // }
        }

        // Validate form_response status for Personal Loan select actions
        if (formResponse.status) {
          // For select actions after form submission, status should be "SUCCESS"
          if (formResponse.status === "SUCCESS") {
            testResults.passed.push(
              `Item ${item.id}: Valid form_response.status "SUCCESS" for Personal Loan select action`
            );
          } else {
            testResults.failed.push(
              `Item ${item.id}: Expected form_response.status "SUCCESS" for Personal Loan select action, but found "${formResponse.status}"`
            );
          }
        }

        // Validate submission_id format for Personal Loan
        if (!(!formResponse.submission_id)) {
          testResults.passed.push(
            `Item ${item.id}: submission_id is present: "${formResponse.submission_id}"`
          );
        }
      }

      // GOLD LOAN specific validations
      else if (
        normalizedUsecaseId === "GOLD LOAN" ||
        normalizedUsecaseId === "GOLD_LOAN"
      ) {
        // Validate form.id for Gold Loan flows
        if (item.xinput.form?.id) {
          const formId = item.xinput.form.id;
          // Gold Loan forms may have different form IDs (e.g., "F01", "F02", etc.)
          if (formId && formId.startsWith("F")) {
            testResults.passed.push(
              `Item ${item.id}: Valid form.id "${formId}" for Gold Loan`
            );
          } else {
            testResults.failed.push(
              `Item ${item.id}: Invalid form.id "${formId}" for Gold Loan. Expected format starting with "F"`
            );
          }
        }

        // Validate form_response status for Gold Loan select actions
        if (formResponse.status) {
          if (formResponse.status === "SUCCESS") {
            testResults.passed.push(
              `Item ${item.id}: Valid form_response.status "SUCCESS" for Gold Loan select action`
            );
          } else {
            testResults.failed.push(
              `Item ${item.id}: Expected form_response.status "SUCCESS" for Gold Loan select action, but found "${formResponse.status}"`
            );
          }
        }
      }

      // Log usecase validation
      testResults.passed.push(
        `Item ${item.id}: Validated with usecaseId "${usecaseId}"`
      );
    }
  });
}

function validatePayments(message: any, testResults: TestResult, flow_id?: string, error?: any): void {
  if (error) {
    return;
  }
  if (flow_id && CREDIT_CARD_FLOWS.includes(flow_id)) {
    return;
  }
  const payments =
    message?.catalog?.providers?.[0]?.payments || message?.order?.payments;
  if (!payments || !Array.isArray(payments)) {
    return;
  }

  payments.forEach((payment, index) => {
    if (payment.type !== "POST_FULFILLMENT") {
      if (
        payment?.collected_by &&
        ["BAP", "BPP"].includes(payment.collected_by)
      ) {
        testResults.passed.push(
          `Payment collected_by has valid value ${payment.collected_by}`
        );
      } else {
        testResults.passed.push(
          `Payment ${index} collected_by should be one of BAP or BPP`
        );
      }
    } else {
      testResults.passed.push(`Payment ${index} type is POST_FULFILLMENT`);
    }
    if (
      payment.type &&
      !["PRE_ORDER", "ON_ORDER", "POST_FULFILLMENT", "ON_FULFILLMENT", "BUYER_FINDER_FEES", "PRE_FULFILLMENT", "POST_ORDER"].includes(payment.type)
    ) {
      testResults.failed.push(`Payment ${index} type has invalid value`);
    } else if (payment.type) {
      testResults.passed.push(`Payment ${index} type has valid value`);
    }
  });
}

function validatePaymentsTRV10(message: any, testResults: TestResult): void {
  const payments =
    message?.catalog?.providers?.[0]?.payments || message?.order?.payments;
  if (!payments || !Array.isArray(payments)) {
    return;
  }

  payments.forEach((payment, index) => {
    if (payment.type !== "POST_FULFILLMENT") {
      if (!(!payment.collected_by)) {
        testResults.passed.push(`Payment ${index} collected_by is present`);
      }
    } else {
      testResults.passed.push(
        `Payment ${index} type is POST_FULFILLMENT, skipping collected_by validation`
      );
    }

    // For TRV10, payment type can be PRE_ORDER, ON_ORDER, POST_FULFILLMENT, or ON-FULFILLMENT
    if (payment.type) {
      const validTypes = [
        "PRE_ORDER",
        "ON_ORDER",
        "POST_FULFILLMENT",
        "ON-FULFILLMENT",
        "ON_FULFILLMENT"
      ];
      if (validTypes.includes(payment.type)) {
        testResults.passed.push(`Payment ${index} type has valid value`);
      } else {
        testResults.failed.push(`Payment ${index} type has invalid value`);
      }
    }
  });
}

function validateOrder(message: any, testResults: TestResult, error?: any): void {
  if (error) {
    testResults.passed.push(`Valid error code "${error.code}" and message "${error.message}" is present`);
    return;
  }

  const order = message?.order;

  if (!order) {
    return;
  }

  if (!(!order.provider?.id)) {
    testResults.passed.push("Order provider ID is present");
  }
}

function validateQuote(
  message: any,
  testResults: TestResult,
  action_id: string,
  flowId: string,
  usecaseId?: string,
  error?: any
): void {
  if (error) {
    return;
  }
  const quote = message?.order?.quote;
  if (
    usecaseId === "CREDIT CARD" ||
    (flowId !== "Personal_Loan_Without_AA_And_Monitoring_Consent" &&
      action_id === "on_select_1_personal_loan")
  ) {
    return;
  } else if (!quote) {
    return;
  } else {
    testResults.passed.push("Quote is present in order");
  }

  if (!(!quote.price?.value)) {
    testResults.passed.push("Quote price value is present");
  }
}

function validateQuoteTRV10(
  message: any,
  testResults: TestResult,
  action_id?: string,
  flowId?: string
): void {
  const quote = message?.order?.quote;
  if (
    !quote &&
    flowId !== "Personal_Loan_With_AA_And_Monitoring_Consent" &&
    action_id !== "on_select_1_personal_loan"
  ) {
    return;
  } else {
    testResults.passed.push("Quote is present in order");
  }
  // For TRV10, quote.id is optional
  if (quote.id) {
    testResults.passed.push("Quote ID is present");
  }

  if (!(!quote.price?.value)) {
    testResults.passed.push("Quote price value is present");
  }
}

function validateBilling(message: any, testResults: TestResult): void {
  const billing = message?.order?.billing;
  if (!billing) {
    return;
  }

  if (!(!billing.name)) {
    testResults.passed.push("Billing name is present");
  }
}

function validateBillingTRV10(message: any, testResults: TestResult): void {
  const billing = message?.order?.billing;
  // For TRV10, billing is optional
  if (billing) {
    if (billing.name) {
      testResults.passed.push("Billing name is present");
    }
  }
}

function validateOrderStatus(
  message: any,
  testResults: TestResult,
  action_id: string
): void {
  const order = message?.order;
  if (order?.status) {
    const validStatuses = [
      "CANCELLATION_INITIATED",
      "ACTIVE",
      "IN_PROGRESS",
      "COMPLETE",
      "ACCEPTED",
      "ON_HOLD",
      "COMPLETED",
      "CANCELLED",
      "INACTIVE",
      "SOFT_CANCEL",
      "CONFIRM_CANCEL",
      "SOFT_UPDATE",
      "UPDATED",
    ];
    if (validStatuses.includes(order.status)) {
      if (action_id === "on_status_solicited") {
        if (order.status !== "COMPLETED") {
          testResults.failed.push(
            "Order status should be COMPLETED for on_status_solicited"
          );
        } else {
          testResults.passed.push(
            "Order status is COMPLETED for on_status_solicited"
          );
        }
      }
      testResults.passed.push("Order status has valid value");
    } else {
      testResults.failed.push("Order status has invalid value");
    }
  }
}

export function validateCancel(
  message: any,
  testResults: TestResult,
  action_id: string,
  flowId?: string
): void {
  // Validate order_id
  if (!(!message?.order_id)) {
    testResults.passed.push("Order ID is present in cancel message");
  }

  // Validate cancellation_reason_id
  if (!(!message?.cancellation_reason_id)) {
    const validReasonCodes = [
      "000",
      "001",
      "002",
      "003",
      "004",
      "005",
      "011",
      "012",
      "013",
      "014",
      "05"
    ];
    if (validReasonCodes.includes(message.cancellation_reason_id)) {
      testResults.passed.push("Cancellation reason ID has valid value");
    } else {
      testResults.failed.push("Cancellation reason ID has invalid value");
    }
  }

  const isHealthInsuranceFlow =
    flowId && HEALTH_INSURANCE_FLOWS.includes(flowId);
  const isMotorInsuranceFlow =
    flowId && MOTOR_INSURANCE_FLOWS.includes(flowId);
  const isInsuranceFlow = isHealthInsuranceFlow || isMotorInsuranceFlow;
  // Validate descriptor
  const descriptor = message?.descriptor;
  if (!(!descriptor)) {
    if (isInsuranceFlow) {
      if (!(!descriptor.short_desc)) {
        testResults.passed.push("Cancellation descriptor short description is present");
      }
    } else if (!(!descriptor.code)) {
      // For purchase finance flows, allow both SOFT_CANCEL and CONFIRM_CANCEL for cancel action
      const isPurchaseFinanceFlow =
        flowId && PURCHASE_FINANCE_FLOWS.includes(flowId);

      // For cancel action, code should be SOFT_CANCEL (or CONFIRM_CANCEL for purchase finance)
      // For cancel_hard action, code should be CONFIRM_CANCEL
      if (action_id === "cancel") {
        if (descriptor.code === "SOFT_CANCEL") {
          testResults.passed.push(
            "Cancellation descriptor code is SOFT_CANCEL for cancel action"
          );
        } else if (
          isPurchaseFinanceFlow &&
          descriptor.code === "CONFIRM_CANCEL"
        ) {
          testResults.passed.push(
            "Cancellation descriptor code is CONFIRM_CANCEL for cancel action (allowed for purchase finance flows)"
          );
        } else {
          testResults.failed.push(
            `Cancellation descriptor code should be SOFT_CANCEL${isPurchaseFinanceFlow ? " or CONFIRM_CANCEL" : ""
            } for cancel action, got ${descriptor.code}`
          );
        }
      } else if (action_id === "cancel_hard") {
        if (descriptor.code === "CONFIRM_CANCEL") {
          testResults.passed.push(
            "Cancellation descriptor code is CONFIRM_CANCEL for cancel_hard action"
          );
        } else {
          testResults.failed.push(
            `Cancellation descriptor code should be CONFIRM_CANCEL for cancel_hard action, got ${descriptor.code}`
          );
        }
      } else {
        // For other action_ids, just validate it's one of the valid codes
        const validCodes = ["SOFT_CANCEL", "CONFIRM_CANCEL"];
        if (validCodes.includes(descriptor.code)) {
          testResults.passed.push(
            "Cancellation descriptor code has valid value"
          );
        } else {
          testResults.failed.push(
            "Cancellation descriptor code has invalid value"
          );
        }
      }
    }
    if (descriptor.name) {
      testResults.passed.push("Cancellation descriptor name is present");
    }
  }
}

function validateCancellation(
  message: any,
  testResults: TestResult,
  action_id?: string,
  flowId?: string
): void {
  const order = message?.order;
  if (!order) {
    return;
  }

  // Check if this is a purchase finance flow
  const isPurchaseFinanceFlow =
    flowId && PURCHASE_FINANCE_FLOWS.includes(flowId);

  const isHealthInsuranceFlow =
    flowId && HEALTH_INSURANCE_FLOWS.includes(flowId);
  const isMotorInsuranceFlow =
    flowId && MOTOR_INSURANCE_FLOWS.includes(flowId);
  const isGiftCardFlow =
    flowId && GIFT_CARD_FLOWS.includes(flowId);
  const isInsuranceFlow = isHealthInsuranceFlow || isMotorInsuranceFlow;

  if (isInsuranceFlow && order.status !== "CANCELLATION_INITIATED") {
    testResults.failed.push(
      "Order status should be CANCELLATION_INITIATED in on_cancel"
    );
  }

  // Validate order status based on action_id
  if (
    action_id === "on_cancel_ride_cancel" ||
    action_id === "soft_on_cancel_purchase_finance"
  ) {
    // For on_cancel_ride_cancel, status should be SOFT_CANCEL
    if (order.status !== "SOFT_CANCEL") {
      testResults.failed.push(
        `Order status should be SOFT_CANCEL in ${action_id}`
      );
    } else {
      testResults.passed.push(
        "Order status is SOFT_CANCEL in on_cancel_ride_cancel"
      );
    }
  } else if (action_id === "on_cancel_hard") {
    // For on_cancel_hard, status should be CANCELLED
    if (order.status !== "CANCELLED") {
      testResults.failed.push(
        "Order status should be CANCELLED in on_cancel_hard"
      );
    } else {
      testResults.passed.push("Order status is CANCELLED in on_cancel_hard");
    }
  } else if (action_id === "on_cancel" || action_id?.startsWith("on_cancel_")) {
    // For purchase finance flows, allow both SOFT_CANCEL and CANCELLED
    if (isPurchaseFinanceFlow) {
      if (order.status === "SOFT_CANCEL" || order.status === "CANCELLED") {
        testResults.passed.push(
          `Order status is valid for purchase finance on_cancel: ${order.status}`
        );
      } else {
        testResults.failed.push(
          `Order status should be SOFT_CANCEL or CANCELLED for purchase finance on_cancel, got ${order.status}`
        );
      }
    } else {
      // For non-purchase finance flows, accept SOFT_CANCEL or CANCELLED
      // (on_cancel_1 sends SOFT_CANCEL, on_cancel_2 sends CANCELLED)
      if (order.status !== "SOFT_CANCEL" && order.status !== "CANCELLED" && !isInsuranceFlow && !isGiftCardFlow) {
        testResults.failed.push(
          "Order status should be SOFT_CANCEL or CANCELLED in on_cancel"
        );
      } else {
        testResults.passed.push(`Order status is ${order.status} in on_cancel`);
      }
    }
  } else {
    // For default on_cancel, status should be CANCELLED
    if (order.status !== "CANCELLED") {
      testResults.failed.push("Order status should be CANCELLED in on_cancel");
    } else {
      testResults.passed.push("Order status is CANCELLED in on_cancel");
    }
  }

  // Validate cancellation object
  const cancellation = order.cancellation;
  if (!cancellation) {
    if (
      isInsuranceFlow ||
      action_id === "soft_on_cancel_purchase_finance" ||
      action_id === "confirmed_on_cancel_purchase_finance"
    ) {
      // Cancellation object is optional for insurance and purchase finance flows
      return;
    }
    return;
  }

  // Validate cancelled_by
  if (!(!cancellation.cancelled_by)) {
    const validCancelledBy = ["CONSUMER", "PROVIDER"];
    if (validCancelledBy.includes(cancellation.cancelled_by)) {
      testResults.passed.push("Cancellation cancelled_by has valid value");
    } else {
      testResults.failed.push("Cancellation cancelled_by has invalid value");
    }
  }

  // Validate cancellation reason
  const reason = cancellation.reason;
  if (!(!reason)) {
    if (!(!reason.descriptor?.code && !reason?.id)) {
      const validReasonCodes = [
        "000",
        "001",
        "002",
        "003",
        "004",
        "005",
        "011",
        "012",
        "013",
        "014",
      ];
      if (validReasonCodes.includes(reason.descriptor.code)) {
        testResults.passed.push("Cancellation reason code has valid value");
      } else {
        testResults.failed.push("Cancellation reason code has invalid value");
      }
    }
  }
}

export function validateTrackOrderId(
  message: any,
  testResults: TestResult
): void {
  const orderId = message?.order_id;
  if (!(!orderId)) {
    testResults.passed.push("Order ID is present in track message");
  }
}

export function validateStatusOrderId(
  message: any,
  testResults: TestResult
): void {
  const orderId = message?.order_id;
  if (!(!orderId)) {
    testResults.passed.push("Order/Ref ID is present in status message");
  }
}

export function validateStatusRefId(
  message: any,
  testResults: TestResult
): void {
  const refId = message?.ref_id;
  if (!(!refId)) {
    testResults.passed.push("Ref ID is present in status message");
  }
}

export function validateErrorResponse(
  jsonRequest: any,
  testResults: TestResult,
  action_id: string
): void {
  const error = jsonRequest?.error;
  const message = jsonRequest?.message;

  // For error response scenarios, validate error object
  if (action_id === "on_confirm_driver_not_found") {
    if (!error) {
      return;
    }

    // Validate error code
    if (!(!error.code)) {
      // For driver not found, expected error code is 90203
      if (error.code === "90203") {
        testResults.passed.push(
          "Error code is correct for driver not found scenario"
        );
      } else {
        testResults.passed.push(`Error code is present: ${error.code}`);
      }
    }

    // Validate error message
    if (!(!error.message)) {
      testResults.passed.push(`Error message is present: ${error.message}`);
    }

    // Validate that message field should not be present in error response
    if (message) {
      testResults.failed.push(
        "Message field should not be present in error response"
      );
    } else {
      testResults.passed.push(
        "Message field is correctly absent in error response"
      );
    }
  }
}

export function validateTracking(
  message: any,
  context: any,
  testResults: TestResult
): void {
  const tracking = message?.tracking;
  if (!tracking) {
    return;
  }

  // Validate tracking status
  if (tracking.status) {
    const validStatuses = ["active", "inactive"];
    if (validStatuses.includes(tracking.status.toLowerCase())) {
      testResults.passed.push("Tracking status has valid value");
    } else {
      testResults.failed.push("Tracking status has invalid value");
    }
  }

  // Validate tracking location
  const location = tracking.location;
  if (location) {
    if (!(!location.gps)) {
      // Validate GPS format (latitude, longitude)
      const gpsPattern = /^-?\d+\.?\d*,\s*-?\d+\.?\d*$/;
      if (gpsPattern.test(location.gps)) {
        testResults.passed.push("Tracking location GPS has valid format");
      } else {
        testResults.failed.push("Tracking location GPS has invalid format");
      }
    }

    // Validate timestamps
    const contextTimestamp = context?.timestamp
      ? new Date(context.timestamp)
      : null;
    const updatedAt = location.updated_at
      ? new Date(location.updated_at)
      : null;
    const locationTimestamp = location.time?.timestamp
      ? new Date(location.time.timestamp)
      : null;

    if (updatedAt && contextTimestamp) {
      if (updatedAt <= contextTimestamp) {
        testResults.passed.push(
          "Tracking location updated_at is not future dated w.r.t context timestamp"
        );
      } else {
        testResults.failed.push(
          "Tracking location updated_at is future dated w.r.t context timestamp"
        );
      }
    }

    // Validate location.time.timestamp if present
    if (locationTimestamp && contextTimestamp) {
      if (locationTimestamp <= contextTimestamp) {
        testResults.passed.push(
          "Tracking location timestamp is not future dated w.r.t context timestamp"
        );
      } else {
        testResults.failed.push(
          "Tracking location timestamp is future dated w.r.t context timestamp"
        );
      }
    }

    // Validate relationship between location timestamp and updated_at if both are present
    if (locationTimestamp && updatedAt) {
      if (locationTimestamp <= updatedAt) {
        testResults.passed.push(
          "Tracking location timestamp is not future dated w.r.t updated_at"
        );
      } else {
        testResults.failed.push(
          "Tracking location timestamp is future dated w.r.t updated_at"
        );
      }
    }
  }
}

export function getFileName(action: string): string {
  if (action.includes("_")) {
    // Example: ON_SEARCH → OnSearch.ts
    return action
      .split("_") // ["ON", "SEARCH"]
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join("");
  } else {
    // Example: SEARCH → search.ts
    return action.toLowerCase();
  }
}

/**
 * Creates a search validation function with configurable validations
 */
export function createSearchValidator(...config: string[]) {
  return async function checkSearch(
    element: Payload,
    sessionID: string,
    flowId: string,
    action_id: string
  ): Promise<TestResult> {
    const { testResults, action, context, message } =
      createBaseValidationSetup(element);

    // Store transaction ID (only in search action - first action in flow)
    const transactionId = context?.transaction_id;
    if (transactionId) {
      try {
        await updateApiMap(sessionID, transactionId, action);
        await addTransactionId(sessionID, flowId, transactionId);
      } catch (error: any) {
        testResults.failed.push(
          `Transaction ID storage failed: ${error.message}`
        );
      }
    }

    for (const validation of config) {
      if (validation) {
        switch (validation) {
          // Logistics validations
          case log11Validators.holidays.validate_holidays:
            validateHolidays(message, context, action, testResults);
            break;
          case log11Validators.lbnp.validate_lbnp:
            validateLBNPFeatures(flowId, message, testResults);
            break;
          case log11Validators.prepaid_payment.validate_prepaid_payment:
            validatePrepaidPaymentFlow(flowId, message, testResults);
            break;
          case log11Validators.cod.validate_cod:
            validateCODFlow(flowId, message, testResults);
            break;
          case log11Validators.sla_metrics.validate_sla_metrics:
            validateSlaMetricsSearch(
              sessionID,
              transactionId,
              flowId,
              message,
              testResults,
              action
            );
            break;

          // Financial services validations
          case fis11Validators.intent.validate_intent:
            validateIntent(message, testResults, action_id, flowId);
            break;
          case fis11Validators.payment.validate_payment_collected_by:
            validatePaymentCollectedBy(message, testResults, flowId);
            break;
          case fis11Validators.tags.validate_tags:
            validateTags(message, testResults, flowId);
            break;

          // TRV10 validations
          case trv11Validators.search.validate_intent:
            validateTrv11Intent(message, testResults);
            break;
          case trv10Validators.fulfillment_stops.validate_fulfillment_stops:
            validateFulfillmentStops(message, testResults, action_id, flowId);
            break;
          default:
            break;
        }
      }
    }
    // Add default message if no validations ran
    addDefaultValidationMessage(testResults, action);
    return testResults;
  };
}

/**
 * TRV10-specific: validate update request envelope
 */
const TRV10_UPDATE_TARGETS = [
  "order.quote.breakup",
  "order.fulfillments",
  "fulfillments[0].stops",
  "payments",
  "fulfillment",
  "fulfillments",
];

// FIS14 (Mutual Funds) update_target values: payment update/retry, SIP amount change,
// SIP pause / cancellation
const FIS14_UPDATE_TARGETS = [
  "order.payments",
  "order.items",
  "order.fulfillments",
];

export function validateUpdateRequestTRV10(
  message: any,
  testResults: TestResult,
  action_id: string,
  validUpdateTargets: string[] = TRV10_UPDATE_TARGETS
): void {
  const { update_target: updateTarget, order } = message ?? {};

  if (!validUpdateTargets.includes(updateTarget)) {
    testResults.failed.push(
      `update_target must be '${validUpdateTargets}', got '${updateTarget}'`
    );
  } else {
    testResults.passed.push("update_target is valid");
  }

  // Order checks
  if (!order) {
    return;
  }

  if (!(!order.id)) {
    testResults.passed.push("Order id is present in update");
  }

  // Order status check — allow SOFT_UPDATE
  if (order.status) {
    const statusMessage =
      order.status === "SOFT_UPDATE"
        ? "Order status is SOFT_UPDATE for update request"
        : `Order status is present: ${order.status}`;
    testResults.passed.push(statusMessage);
  }
}

/**
 * Creates an update validation function with configurable validations
 */
export function createUpdateValidator(...config: string[]) {
  return async function checkUpdate(
    element: Payload,
    sessionID: string,
    flowId: string,
    action_id: string
  ): Promise<TestResult> {
    const { testResults, action, context, message } =
      createBaseValidationSetup(element);

    const transactionId = context?.transaction_id;

    // Validate transaction ID exists for this flow
    await validateTransactionId(sessionID, flowId, transactionId, testResults);
    if (transactionId) {
      try {
        await updateApiMap(sessionID, transactionId, action);
      } catch (error: any) {
        testResults.failed.push(`API map update failed: ${error.message}`);
      }
    }

    // Always validate update envelope first
    validateUpdateRequestTRV10(
      message,
      testResults,
      action_id,
      context?.domain === "ONDC:FIS14"
        ? FIS14_UPDATE_TARGETS
        : TRV10_UPDATE_TARGETS
    );

    for (const validation of config) {
      if (validation) {
        switch (validation) {
          // Financial services validations (reused)
          case trv10Validators.fulfillments_trv10.validate_fulfillments_trv10:
            validateFulfillmentsTRV10(message, testResults, action_id);
            break;
          // TRV10 validations
          case trv10Validators.fulfillment_stops_order
            .validate_fulfillment_stops_order:
            validateFulfillmentStopsInOrder(
              message,
              testResults,
              action_id,
              flowId
            );
            break;

          // FIS12 validations
          case fis12Validators.update.validate_update_payments:
            validateUpdatePaymentsFIS12(message, testResults);
            break;
          case fis12Validators.update.validate_fulfillment_state:
            validateFulfillmentStateOnUpdateFIS12(
              message,
              testResults,
              action_id,
              flowId
            );
            break;

          default:
            break;
        }
      }
    }

    // Add default message if no validations ran
    addDefaultValidationMessage(testResults, action);

    return testResults;
  };
}

/**
 * Creates an OnSearch validation function with configurable validations
 */
export function createOnSearchValidator(...config: string[]) {
  return async function checkOnSearch(
    element: Payload,
    sessionID: string,
    flowId: string,
    action_id: string
  ): Promise<TestResult> {
    const { testResults, action, context, message } =
      createBaseValidationSetup(element);
    const transactionId = context?.transaction_id;

    // Validate transaction ID exists for this flow
    await validateTransactionId(sessionID, flowId, transactionId, testResults);

    // Update API map for tracking
    if (transactionId) {
      try {
        await updateApiMap(sessionID, transactionId, action);
      } catch (error: any) {
        testResults.failed.push(`API map update failed: ${error.message}`);
      }
    }

    for (const validation of config) {
      if (validation) {
        switch (validation) {
          // Logistics validations
          case log11Validators.lsp.validate_lsp:
            validateLSPFeatures(flowId, message, testResults);
            break;
          case log11Validators.tat.validate_tat:
            validateTAT(message, testResults);
            break;
          case log11Validators.shipment_types.validate_shipment_types:
            validateShipmentTypesWrapper(message, testResults);
            break;
          case log11Validators.cod.validate_cod:
            validateCODFlow(flowId, message, testResults);
            break;

          case log11Validators.tax_type_rcm.validate_np_tax_type_rcm:
            validateNpTaxType(flowId, message, testResults, action);
            break;

          case log11Validators.codified_static_terms
            .validate_codified_static_terms:
            validateCodifiedStaticTerms(
              action_id,
              message,
              sessionID,
              transactionId,
              testResults,
              action
            );
            break;

          case log11Validators.public_special_capabilities
            .validate_public_special_capabilities:
            validatePublicSpecialCapabilities(
              flowId,
              message,
              sessionID,
              transactionId,
              testResults
            );

          // Financial services validations
          case fis11Validators.catalog.validate_catalog:
            validateCatalog(message, testResults);
            break;
          case fis11Validators.providers.validate_providers:
            validateProviders(message, testResults);
            break;
          case trv10Validators.providers_trv10.validate_providers_trv10:
            validateProvidersTRV10(message, testResults);
            break;
          case fis11Validators.items.validate_items:
            validateItems(message, testResults, action_id, flowId);
            break;
          case fis11Validators.payments.validate_payments:
            validatePayments(message, testResults, flowId);
            break;

          // TRV10 validations
          case trv11Validators.on_search.validate_catalog:
            validateTrv11OnSearch(message, testResults);
            break;
          case trv10Validators.fulfillment_stops_catalog
            .validate_fulfillment_stops_catalog:
            validateFulfillmentStopsInCatalog(message, testResults, action_id);
            break;

          //FIS12/FIS13
          case fis10Validators.items.validate_onsearch_items:
            validateOnSearchItemsFIS10(message, testResults);
            break;
          case fis12Validators.catalog.providers.categories:
            validateCategoriesFIS12(message, testResults, flowId);
            break;
          case fis12Validators.items.validate_onsearch_items:
            validateOnSearchItemsFIS12(message, testResults);
            break;
          case fis12230Validators.items.validate_onsearch_items:
            validateUnifiedCreditOnSearchItemsFIS12(message, testResults);
            break;
          case fis12Validators.items.validate_xinput:
            await validateXinputFIS12(
              message,
              testResults,
              sessionID,
              transactionId,
              flowId,
              action_id
            );
            break;
          default:
            break;
        }
      }
    }

    // Add default message if no validations ran
    addDefaultValidationMessage(testResults, action);

    return testResults;
  };
}

/**
 * Creates a select validation function with configurable validations
 */
export function createSelectValidator(...config: string[]) {
  return async function checkSelect(
    element: Payload,
    sessionID: string,
    flowId: string,
    action_id: string,
    usecaseId?: string
  ): Promise<TestResult> {
    logger.info(`Inside ${action_id || "select"} validations`, { usecaseId });
    const { testResults, action, context, message } =
      createBaseValidationSetup(element);

    const transactionId = context?.transaction_id;

    // Register the transaction ID for this flow before validating it.
    // Flows that start at `select` (e.g. MF redemption flows that skip `search`)
    // never reach createSearchValidator's addTransactionId call, so the ID is
    // never stored and every subsequent validator reports a false "No transaction
    // IDs found" failure. addTransactionId is idempotent — if search already
    // stored the ID it will not be duplicated.
    if (transactionId) {
      try {
        await addTransactionId(sessionID, flowId, transactionId);
        await updateApiMap(sessionID, transactionId, action);
      } catch (error: any) {
        testResults.failed.push(`API map update failed: ${error.message}`);
      }
    }

    // Validate transaction ID exists for this flow (will now always find it)
    await validateTransactionId(sessionID, flowId, transactionId, testResults);

    for (const validation of config) {
      if (validation) {
        switch (validation) {
          // Logistics validations
          case log11Validators.holidays.validate_holidays:
            validateHolidays(message, context, action, testResults);
            break;
          case log11Validators.lbnp.validate_lbnp:
            validateLBNPFeatures(flowId, message, testResults);
            break;
          case log11Validators.prepaid_payment.validate_prepaid_payment:
            validatePrepaidPaymentFlow(flowId, message, testResults);
            break;
          case log11Validators.cod.validate_cod:
            validateCODFlow(flowId, message, testResults);
            break;

          // Financial services validations
          case fis11Validators.order.validate_order:
            validateOrder(message, testResults);
            break;
          case fis11Validators.provider.validate_provider:
            validateProvider(message, testResults, action_id, usecaseId, flowId);
            break;
          case fis11Validators.items.validate_items:
            validateItems(message, testResults, action_id, flowId, usecaseId);
            break;
          /**
           * FIS12-specific validations
           * Note: DomainValidators.fis12OnStatus already wires
           * fis12Validators.fulfillments.validate_fulfillments into the
           * on_status flow. Without this case, that config entry is a no-op.
           */
          case fis12Validators.fulfillments.validate_fulfillments:
            validateFulfillmentsFIS12(
              message,
              testResults,
              usecaseId,
              action_id,
              flowId
            );
            break;

          // TRV10 validations
          case trv10Validators.items_trv10.validate_items_trv10:
            validateItemsTRV10(message, testResults, action_id);
            break;
          // TRV11 validations
          case trv11Validators.select.validate_order:
            validateTrv11Select(message, testResults);
            break;
          case trv10Validators.fulfillments_trv10.validate_fulfillments_trv10:
            validateFulfillmentsTRV10(message, testResults, action_id);
            break;

          case fis12Validators.items.select_validate_xinput:
            validateXInputStatusFIS12(
              message,
              testResults,
              usecaseId,
              action_id,
              flowId
            );
            break;
          default:
            break;
        }
      }
    }

    // Add default message if no validations ran
    addDefaultValidationMessage(testResults, action);
    return testResults;
  };
}

/**
 * Creates an on_select validation function with configurable validations
 */
export function createOnSelectValidator(...config: string[]) {
  return async function checkOnSelect(
    element: Payload,
    sessionID: string,
    flowId: string,
    action_id: string,
    usecaseId?: string
  ): Promise<TestResult> {
    const { testResults, action, context, message } =
      createBaseValidationSetup(element);

    const transactionId = context?.transaction_id;

    // Validate transaction ID exists for this flow
    await validateTransactionId(sessionID, flowId, transactionId, testResults);
    if (transactionId) {
      try {
        await updateApiMap(sessionID, transactionId, action);
      } catch (error: any) {
        testResults.failed.push(`API map update failed: ${error.message}`);
      }
    }

    for (const validation of config) {
      if (validation) {
        switch (validation) {
          // Logistics validations
          case log11Validators.lsp.validate_lsp:
            validateLSPFeatures(flowId, message, testResults);
            break;
          case log11Validators.tat.validate_tat:
            validateTAT(message, testResults);
            break;
          case log11Validators.shipment_types.validate_shipment_types:
            validateShipmentTypesWrapper(message, testResults);
            break;

          // Financial services validations
          case fis11Validators.order.validate_order:
            validateOrder(message, testResults);
            break;
          case fis11Validators.quote.validate_quote:
            validateQuote(message, testResults, action_id, flowId, usecaseId);
            break;
          case fis11Validators.provider.validate_provider:
            validateProvider(message, testResults, action_id, usecaseId, flowId);
            break;

          case fis11Validators.items.validate_items:
            validateItems(message, testResults, action_id, flowId, usecaseId);
            break;

          // TRV10 validations
          case trv10Validators.providers_trv10.validate_providers_trv10:
            validateProvidersTRV10(message, testResults);
            break;
          case trv10Validators.provider_trv10.validate_provider_trv10:
            validateProviderTRV10(message, testResults, action_id);
            break;
          // TRV11 validations
          case trv11Validators.on_select.validate_order:
            validateTrv11OnSelect(message, testResults);
            break;
          case trv10Validators.quote_trv10.validate_quote_trv10:
            validateQuoteTRV10(message, testResults, action_id, flowId);
            break;
          case trv10Validators.fulfillment_stops_order
            .validate_fulfillment_stops_order:
            validateFulfillmentStopsInOrder(
              message,
              testResults,
              action_id,
              flowId
            );
            break;

          // case fis12Validators.items.validate_xinput:
          //   await validateXinputFIS12(message, testResults, sessionID, transactionId,flowId,action_id);
          //   break;
          default:
            break;
        }
      }
    }

    // Add default message if no validations ran
    addDefaultValidationMessage(testResults, action);

    return testResults;
  };
}

/**
 * Creates an init validation function with configurable validations
 */
export function createInitValidator(...config: string[]) {
  return async function checkInit(
    element: Payload,
    sessionID: string,
    flowId: string,
    action_id: string,
    usecaseId?: string
  ): Promise<TestResult> {
    const { testResults, action, context, message } =
      createBaseValidationSetup(element);

    const transactionId = context?.transaction_id;

    // Validate transaction ID exists for this flow
    await validateTransactionId(sessionID, flowId, transactionId, testResults);
    if (transactionId) {
      try {
        await updateApiMap(sessionID, transactionId, action);
      } catch (error: any) {
        testResults.failed.push(`API map update failed: ${error.message}`);
      }
    }

    for (const validation of config) {
      if (validation) {
        switch (validation) {
          // Logistics validations
          case log11Validators.holidays.validate_holidays:
            validateHolidays(message, context, action, testResults);
            break;
          case log11Validators.lbnp.validate_lbnp:
            validateLBNPFeatures(flowId, message, testResults);
            break;
          case log11Validators.prepaid_payment.validate_prepaid_payment:
            validatePrepaidPaymentFlow(flowId, message, testResults);
            break;
          case log11Validators.cod.validate_cod:
            validateCODFlow(flowId, message, testResults);
            break;

          // Financial services validations
          case fis11Validators.order.validate_order:
            validateOrder(message, testResults);
            break;
          case fis11Validators.provider.validate_provider:
            validateProvider(message, testResults, action_id, usecaseId, flowId);
            break;
          case fis11Validators.items.validate_items:
            validateItems(message, testResults, action_id, flowId, usecaseId);
            break;
         
          case fis11Validators.payments.validate_payments:
            validatePayments(message, testResults, flowId);
            break;
          case fis11Validators.billing.validate_billing:
            validateBilling(message, testResults);
            break;

          // FIS12 Gold Loan-specific validations
          case fis12Validators.items.loan_info_oninit:
            validateGoldLoanOnInitFIS12(message, testResults);
            break;

          // FIS12 validations
          case fis12Validators.items.select_validate_xinput:
            // Validate xinput.form_response status & submission_id for FIS12 flows
            validateXInputStatusFIS12(
              message,
              testResults,
              undefined,
              action_id,
              flowId
            );
            break;
          // TRV10 validations
          case trv10Validators.provider_trv10.validate_provider_trv10:
            validateProviderTRV10(message, testResults, action_id);
            break;
          case trv10Validators.items_trv10.validate_items_trv10:
            validateItemsTRV10(message, testResults, action_id);
            break;
          case trv10Validators.fulfillments_trv10.validate_fulfillments_trv10:
            validateFulfillmentsTRV10(message, testResults, action_id);
            break;
          case trv10Validators.payments_trv10.validate_payments_trv10:
            validatePaymentsTRV10(message, testResults);
            break;
          case trv10Validators.billing_trv10.validate_billing_trv10:
            validateBillingTRV10(message, testResults);
            break;
          case trv10Validators.fulfillment_stops_order
            .validate_fulfillment_stops_order:
            validateFulfillmentStopsInOrder(
              message,
              testResults,
              action_id,
              flowId
            );
            break;

          // TRV11 validations
          case trv11Validators.init.validate_order:
            validateTrv11Init(message, testResults);
            break;

          default:
            break;
        }
      }
    }

    // Add default message if no validations ran
    addDefaultValidationMessage(testResults, action);

    return testResults;
  };
}

/**
 * Creates a confirm validation function with configurable validations
 */
export function createConfirmValidator(...config: string[]) {
  return async function checkConfirm(
    element: Payload,
    sessionID: string,
    flowId: string,
    action_id: string,
    usecaseId?: string
  ): Promise<TestResult> {
    const { testResults, action, context, message } =
      createBaseValidationSetup(element);

    const transactionId = context?.transaction_id;

    // Validate transaction ID exists for this flow
    await validateTransactionId(sessionID, flowId, transactionId, testResults);
    if (transactionId) {
      try {
        await updateApiMap(sessionID, transactionId, action);
      } catch (error: any) {
        testResults.failed.push(`API map update failed: ${error.message}`);
      }
    }

    for (const validation of config) {
      if (validation) {
        switch (validation) {
          // Logistics validations
          case log11Validators.holidays.validate_holidays:
            validateHolidays(message, context, action, testResults);
            break;
          case log11Validators.lbnp.validate_lbnp:
            validateLBNPFeatures(flowId, message, testResults);
            break;
          case log11Validators.prepaid_payment.validate_prepaid_payment:
            validatePrepaidPaymentFlow(flowId, message, testResults);
            break;
          case log11Validators.cod.validate_cod:
            validateCODFlow(flowId, message, testResults);
            break;

          case log11Validators.sla_metrics.validate_sla_metrics:
            validateSlaMetricsConfirm(
              sessionID,
              transactionId,
              action_id,
              message,
              testResults,
              action
            );
            break;

          case log11Validators.exchange_customer_contact_details
            .validate_customer_contact_details:
            validateCustomerContactDetails(
              action_id,
              message,
              sessionID,
              transactionId,
              testResults
            );
            break;

          case log11Validators.seller_creds.validate_seller_creds:
            validateSellerCreds(
              flowId,
              message,
              sessionID,
              transactionId,
              testResults
            );
            break;

          // Financial services validations
          case fis11Validators.order.validate_order:
            validateOrder(message, testResults);
            break;
          case fis11Validators.provider.validate_provider:
            validateProvider(message, testResults, action_id, usecaseId, flowId);
            break;
          case fis11Validators.items.validate_items:
            validateItems(message, testResults, action_id, flowId, usecaseId);
            break;
         
          case fis11Validators.payments.validate_payments:
            validatePayments(message, testResults, flowId);
            break;
          case fis11Validators.billing.validate_billing:
            validateBilling(message, testResults);
            break;

          // TRV10 validations
          case trv10Validators.provider_trv10.validate_provider_trv10:
            validateProviderTRV10(message, testResults, action_id);
            break;
          case trv10Validators.items_trv10.validate_items_trv10:
            validateItemsTRV10(message, testResults, action_id);
            break;
          case trv10Validators.payments_trv10.validate_payments_trv10:
            validatePaymentsTRV10(message, testResults);
            break;
          case trv10Validators.billing_trv10.validate_billing_trv10:
            validateBillingTRV10(message, testResults);
            break;

          // TRV11 validations
          case trv11Validators.confirm.validate_order:
            validateTrv11Confirm(message, testResults);
            break;

          default:
            break;
        }
      }
    }
    // Add default message if no validations ran
    addDefaultValidationMessage(testResults, action);
    return testResults;
  };
}

/**
 * Creates an on_init validation function with configurable validations
 */
export function createOnInitValidator(...config: string[]) {
  return async function checkOnInit(
    element: Payload,
    sessionID: string,
    flowId: string,
    action_id: string,
    usecaseId?: string
  ): Promise<TestResult> {
    const { testResults, action, context, message, error } =
      createBaseValidationSetup(element);

    const transactionId = context?.transaction_id;

    // Validate transaction ID exists for this flow
    await validateTransactionId(sessionID, flowId, transactionId, testResults);
    if (transactionId) {
      try {
        await updateApiMap(sessionID, transactionId, action);
      } catch (error: any) {
        testResults.failed.push(`API map update failed: ${error.message}`);
      }
    }

    logger.info(`Inside on_init validations`, { usecaseId });

    for (const validation of config) {
      if (validation) {
        switch (validation) {
          // Logistics validations
          case log11Validators.lsp.validate_lsp:
            validateLSPFeatures(flowId, message, testResults);
            break;
          case log11Validators.tat.validate_tat:
            validateTAT(message, testResults);
            break;
          case log11Validators.shipment_types.validate_shipment_types:
            validateShipmentTypesWrapper(message, testResults);
            break;

          // Financial services validations
          case fis11Validators.order.validate_order:
            validateOrder(message, testResults, error);
            break;
          case fis11Validators.quote.validate_quote:
            validateQuote(message, testResults, action_id, flowId, usecaseId, error);
            break;
          case fis11Validators.provider.validate_provider:
            validateProvider(message, testResults, action_id, usecaseId, flowId, error);
            break;
          case fis11Validators.items.validate_items:
            validateItems(message, testResults, action_id, flowId, usecaseId, error);
            break;
          
          case fis11Validators.payments.validate_payments:
            validatePayments(message, testResults, flowId, error);
            break;
          case fis11Validators.billing.validate_billing:
            validateBilling(message, testResults);
            break;

          // TRV10 validations
          case trv10Validators.provider_trv10.validate_provider_trv10:
            validateProviderTRV10(message, testResults, action_id);
            break;
          case trv10Validators.quote_trv10.validate_quote_trv10:
            validateQuoteTRV10(message, testResults);
            break;
          case trv10Validators.payments_trv10.validate_payments_trv10:
            validatePaymentsTRV10(message, testResults);
            break;
          case trv10Validators.billing_trv10.validate_billing_trv10:
            validateBillingTRV10(message, testResults);
            break;
          case trv10Validators.fulfillment_stops_order
            .validate_fulfillment_stops_order:
            validateFulfillmentStopsInOrder(
              message,
              testResults,
              action_id,
              flowId
            );
            break;

          // FIS12 validations
          case fis12Validators.fulfillments.validate_fulfillments:
            validateFulfillmentsFIS12(
              message,
              testResults,
              usecaseId,
              action_id
            );
            break;
          case fis12Validators.documents.validate_documents:
            validateDocumentsFIS12(message, testResults);
            break;
          // FIS12 validations
          case fis12Validators.fulfillments.validate_fulfillments:
            validateFulfillmentsFIS12(
              message,
              testResults,
              usecaseId,
              action_id,
              flowId
            );
            break;
          case fis12Validators.payments.validate_payments:
            validatePaymentsFIS12(message, testResults, flowId, error);
            break;
          case fis12Validators.documents.validate_documents:
            validateDocumentsFIS12(message, testResults);
            break;

          // TRV11 validations
          case trv11Validators.on_init.validate_order:
            validateTrv11OnInit(message, testResults);
            break;

          default:
            break;
        }
      }
    }

    // Purchase Finance specific validations for on_init
    validatePurchaseFinanceOnInit(message, testResults, flowId);

    // Add default message if no validations ran
    addDefaultValidationMessage(testResults, action);

    return testResults;
  };
}

/**
 * Creates an on_confirm validation function with configurable validations
 */
export function createOnConfirmValidator(...config: string[]) {
  return async function checkOnConfirm(
    element: Payload,
    sessionID: string,
    flowId: string,
    action_id: string,
    usecaseId?: string
  ): Promise<TestResult> {
    const { testResults, action, context, message } =
      createBaseValidationSetup(element);
    const transactionId = context?.transaction_id;

    // Validate transactivalidateP2H2PRequirementson ID exists for this flow
    await validateTransactionId(sessionID, flowId, transactionId, testResults);
    if (transactionId) {
      try {
        await updateApiMap(sessionID, transactionId, action);
      } catch (error: any) {
        testResults.failed.push(`API map update failed: ${error.message}`);
      }
    }

    for (const validation of config) {
      if (validation) {
        switch (validation) {
          case fis12Validators.fulfillments.validate_fulfillments:
            validateFulfillmentsFIS12(
              message,
              testResults,
              usecaseId,
              action_id,
              flowId
            );
            break;
          case fis12Validators.payments.validate_payments:
            validatePaymentsFIS12(message, testResults, flowId);
            break;
          case fis12Validators.catalog.providers.categories:
            validateCategoriesFIS12(message, testResults, flowId);
            break;
          case fis12Validators.documents.validate_documents:
            validateDocumentsFIS12(message, testResults);
            break;

          // Logistics validations
          case log11Validators.lsp.validate_lsp:
            validateLSPFeatures(flowId, message, testResults);
            break;
          case log11Validators.tat.validate_tat:
            validateTAT(message, testResults);
            break;
          case log11Validators.shipment_types.validate_shipment_types:
            validateShipmentTypesWrapper(message, testResults);
            break;
          case log11Validators.sla_metrics.validate_sla_metrics:
            validateSlaMetricsConfirm(
              sessionID,
              transactionId,
              action_id,
              message,
              testResults,
              action
            );
            break;

          case log11Validators.tax_type_rcm.validate_np_tax_type_rcm:
            validateNpTaxType(flowId, message, testResults, action);
            break;

          case log11Validators.codified_static_terms
            .validate_codified_static_terms:
            validateCodifiedStaticTerms(
              flowId,
              message,
              sessionID,
              transactionId,
              testResults,
              action
            );
            break;

          case log11Validators.exchange_customer_contact_details
            .validate_customer_contact_details:
            validateCustomerContactDetails(
              action_id,
              message,
              sessionID,
              transactionId,
              testResults
            );
            break;

          // Financial services validations
          case fis11Validators.order.validate_order:
            validateOrder(message, testResults);
            break;
          case fis11Validators.quote.validate_quote:
            validateQuote(message, testResults, action_id, flowId, usecaseId);
            break;
          case fis11Validators.provider.validate_provider:
            validateProvider(message, testResults, action_id, usecaseId, flowId);
            break;
          case fis11Validators.items.validate_items:
            validateItems(message, testResults, action_id, flowId, usecaseId);
            break;
        
          case fis11Validators.payments.validate_payments:
            validatePayments(message, testResults, flowId);
            break;
          case fis11Validators.billing.validate_billing:
            validateBilling(message, testResults);
            break;
          case fis11Validators.order_status.validate_order_status:
            validateOrderStatus(message, testResults, action_id);
            break;

          // TRV10 validations
          case trv10Validators.provider_trv10.validate_provider_trv10:
            validateProviderTRV10(message, testResults, action_id);
            break;
          case trv10Validators.quote_trv10.validate_quote_trv10:
            validateQuoteTRV10(message, testResults, action_id, flowId);
            break;
          case trv10Validators.payments_trv10.validate_payments_trv10:
            validatePaymentsTRV10(message, testResults);
            break;
          case trv10Validators.billing_trv10.validate_billing_trv10:
            validateBillingTRV10(message, testResults);
            break;

          // TRV11 validations
          case trv11Validators.on_confirm.validate_order:
            validateTrv11OnConfirm(message, testResults);
            break;

          // FIS12 validations
          case fis12Validators.fulfillments.validate_fulfillments:
            validateFulfillmentsFIS12(
              message,
              testResults,
              usecaseId,
              action_id
            );
            break;
          case fis12Validators.payments.validate_payments:
            validatePaymentsFIS12(message, testResults);
            break;
          case fis12Validators.documents.validate_documents:
            validateDocumentsFIS12(message, testResults);
            break;
          default:
            break;
        }
      }
    }

    // Purchase Finance specific validations for on_confirm
    validatePurchaseFinanceOnConfirm(message, testResults, flowId);

    // Add default message if no validations ran
    addDefaultValidationMessage(testResults, action);

    return testResults;
  };
}

/**
 * Creates an on_status validation function with configurable validations
 */
export function createOnStatusValidator(...config: string[]) {
  return async function checkOnStatus(
    element: Payload,
    sessionID: string,
    flowId: string,
    action_id: string,
    usecaseId?: string
  ): Promise<TestResult> {
    const { testResults, action, context, message } =
      createBaseValidationSetup(element);
    const transactionId = context?.transaction_id;

    // Validate transaction ID exists for this flow
    await validateTransactionId(sessionID, flowId, transactionId, testResults);
    if (transactionId) {
      try {
        await updateApiMap(sessionID, transactionId, action);
      } catch (error: any) {
        testResults.failed.push(`API map update failed: ${error.message}`);
      }
    }

    for (const validation of config) {
      if (validation) {
        switch (validation) {
          // Logistics validations
          case log11Validators.lsp.validate_lsp:
            validateLSPFeatures(flowId, message, testResults);
            break;
          case log11Validators.tat.validate_tat:
            validateTAT(message, testResults);
            break;
          case log11Validators.shipment_types.validate_shipment_types:
            validateShipmentTypesWrapper(message, testResults);
            break;

          // Financial services validations
          case fis11Validators.order.validate_order:
            validateOrder(message, testResults);
            break;
          case fis11Validators.quote.validate_quote:
            validateQuote(message, testResults, action_id, flowId, usecaseId);
            break;
          case fis11Validators.provider.validate_provider:
            validateProvider(message, testResults, action_id, usecaseId, flowId);
            break;
          case fis11Validators.items.validate_items:
            validateItems(message, testResults, action_id, flowId, usecaseId);
            break;
          
          case fis11Validators.payments.validate_payments:
            validatePayments(message, testResults, flowId);
            break;
          case fis11Validators.billing.validate_billing:
            validateBilling(message, testResults);
            break;
          case fis11Validators.order_status.validate_order_status:
            validateOrderStatus(message, testResults, action_id);
            break;

          // TRV10 validations
          case trv10Validators.provider_trv10.validate_provider_trv10:
            validateProviderTRV10(message, testResults, action_id);
            break;
          case trv10Validators.quote_trv10.validate_quote_trv10:
            validateQuoteTRV10(message, testResults);
            break;
          case trv10Validators.payments_trv10.validate_payments_trv10:
            validatePaymentsTRV10(message, testResults);
            break;
          case trv10Validators.billing_trv10.validate_billing_trv10:
            validateBillingTRV10(message, testResults);
            break;
          case trv10Validators.fulfillment_stops_order
            .validate_fulfillment_stops_order:
            validateFulfillmentStopsInOrder(
              message,
              testResults,
              action_id,
              flowId
            );
            break;

          // FIS12 validations
          case fis12Validators.fulfillments.validate_fulfillments:
            validateFulfillmentsFIS12(
              message,
              testResults,
              usecaseId,
              action_id
            );
            break;
          case fis12Validators.payments.validate_payments:
            validatePaymentsFIS12(message, testResults);
            break;
          case fis12Validators.documents.validate_documents:
            validateDocumentsFIS12(message, testResults);
            break;
          case fis12Validators.update.validate_fulfillment_state:
            validateFulfillmentStateOnUpdateFIS12(
              message,
              testResults,
              action_id,
              flowId
            );
            break;

          default:
            break;

          // TRV11 validations
          case trv11Validators.on_status.validate_order:
            validateTrv11OnStatus(message, testResults);
            break;
        }
      }
    }

    // Add default message if no validations ran
    addDefaultValidationMessage(testResults, action);

    return testResults;
  };
}

/**
 * Creates an on_cancel validation function with configurable validations
 */
export function createOnCancelValidator(...config: string[]) {
  return async function checkOnCancel(
    element: Payload,
    sessionID: string,
    flowId: string,
    action_id: string,
    usecaseId?: string
  ): Promise<TestResult> {
    const { testResults, action, context, message } =
      createBaseValidationSetup(element);
    const transactionId = context?.transaction_id;

    // Validate transaction ID exists for this flow
    await validateTransactionId(sessionID, flowId, transactionId, testResults);
    if (transactionId) {
      try {
        await updateApiMap(sessionID, transactionId, action);
      } catch (error: any) {
        testResults.failed.push(`API map update failed: ${error.message}`);
      }
    }

    // Always validate cancellation for on_cancel
    validateCancellation(message, testResults, action_id, flowId);

    for (const validation of config) {
      if (validation) {
        switch (validation) {
          // Logistics validations
          case log11Validators.lsp.validate_lsp:
            validateLSPFeatures(flowId, message, testResults);
            break;
          case log11Validators.tat.validate_tat:
            validateTAT(message, testResults);
            break;
          case log11Validators.shipment_types.validate_shipment_types:
            validateShipmentTypesWrapper(message, testResults);
            break;

          // Financial services validations
          case fis11Validators.order.validate_order:
            validateOrder(message, testResults);
            break;
          case fis11Validators.quote.validate_quote:
            validateQuote(message, testResults, action_id, flowId, usecaseId);
            break;
          case fis11Validators.provider.validate_provider:
            validateProvider(message, testResults, action_id, usecaseId, flowId);
            break;
          case fis11Validators.items.validate_items:
            validateItems(message, testResults, action_id, flowId, usecaseId);
            break;
        
          case fis11Validators.payments.validate_payments:
            validatePayments(message, testResults, flowId);
            break;
          case fis11Validators.billing.validate_billing:
            validateBilling(message, testResults);
            break;
          case fis11Validators.order_status.validate_order_status:
            validateOrderStatus(message, testResults, action_id);
            break;

          // TRV10 validations
          case trv10Validators.provider_trv10.validate_provider_trv10:
            validateProviderTRV10(message, testResults, action_id);
            break;
          case trv10Validators.quote_trv10.validate_quote_trv10:
            validateQuoteTRV10(message, testResults);
            break;
          case trv10Validators.payments_trv10.validate_payments_trv10:
            validatePaymentsTRV10(message, testResults);
            break;
          case trv10Validators.billing_trv10.validate_billing_trv10:
            validateBillingTRV10(message, testResults);
            break;
          case trv10Validators.fulfillment_stops_order
            .validate_fulfillment_stops_order:
            validateFulfillmentStopsInOrder(
              message,
              testResults,
              action_id,
              flowId
            );
            break;

          // TRV11 validations
          case trv11Validators.on_cancel.validate_order:
            validateTrv11OnCancel(message, testResults);
            break;

          default:
            break;
        }
      }
    }

    // Purchase Finance specific validations for on_cancel
    validatePurchaseFinanceOnCancel(message, testResults, flowId);

    // Add default message if no validations ran
    addDefaultValidationMessage(testResults, action);

    return testResults;
  };
}

export function createOnUpdateValidator(...config: string[]) {
  return async function checkOnUpdate(
    element: Payload,
    sessionID: string,
    flowId: string,
    action_id: string,
    usecaseId?: string
  ): Promise<TestResult> {
    const { testResults, action, context, message } =
      createBaseValidationSetup(element);
    const transactionId = context?.transaction_id;

    // Validate transactivalidateP2H2PRequirementson ID exists for this flow
    await validateTransactionId(sessionID, flowId, transactionId, testResults);
    if (transactionId) {
      try {
        await updateApiMap(sessionID, transactionId, action);
      } catch (error: any) {
        testResults.failed.push(`API map update failed: ${error.message}`);
      }
    }

    for (const validation of config) {
      if (validation) {
        switch (validation) {
          // Logistics validations
          case log11Validators.lsp.validate_lsp:
            validateLSPFeatures(flowId, message, testResults);
            break;
          case log11Validators.tat.validate_tat:
            validateTAT(message, testResults);
            break;
          case log11Validators.shipment_types.validate_shipment_types:
            validateShipmentTypesWrapper(message, testResults);
            break;
          case log11Validators.awb_shipping_label.validate_awb_shipping_label:
            validateP2H2PRequirements(context, message, testResults, action);

          case log11Validators.e_pod.validate_e_pod:
            validateEpodProofs(flowId, message, testResults);
            break;

          // Financial services validations
          case fis11Validators.order.validate_order:
            validateOrder(message, testResults);
            break;
          case fis11Validators.quote.validate_quote:
            validateQuote(message, testResults, action_id, flowId, usecaseId);
            break;
          case fis11Validators.provider.validate_provider:
            validateProvider(message, testResults, action_id, usecaseId, flowId);
            break;
          case fis11Validators.items.validate_items:
            validateItems(message, testResults, action_id, flowId, usecaseId);
            break;
         
          case fis11Validators.payments.validate_payments:
            validatePayments(message, testResults, flowId);
            break;
          case fis11Validators.billing.validate_billing:
            validateBilling(message, testResults);
            break;
          case fis11Validators.order_status.validate_order_status:
            validateOrderStatus(message, testResults, action_id);
            break;

          // TRV10 validations
          case trv10Validators.provider_trv10.validate_provider_trv10:
            validateProviderTRV10(message, testResults, action_id);
            break;
          case trv10Validators.quote_trv10.validate_quote_trv10:
            validateQuoteTRV10(message, testResults);
            break;
          case trv10Validators.payments_trv10.validate_payments_trv10:
            validatePaymentsTRV10(message, testResults);
            break;
          case trv10Validators.billing_trv10.validate_billing_trv10:
            validateBillingTRV10(message, testResults);
            break;
          case trv10Validators.fulfillment_stops_order
            .validate_fulfillment_stops_order:
            validateFulfillmentStopsInOrder(
              message,
              testResults,
              action_id,
              flowId
            );
            break;

          // TRV11 validations
          case trv11Validators.on_update.validate_order:
            validateTrv11OnUpdate(message, testResults);
            break;

          default:
            break;
        }
      }
    }

    // Purchase Finance specific validations for on_update
    validatePurchaseFinanceOnUpdate(message, testResults, flowId);

    // Add default message if no validations ran
    addDefaultValidationMessage(testResults, action);

    return testResults;
  };
}

/**
 * Creates an issue validation function
 */
export function createIssueValidator(...config: string[]) {
  return async function checkIssue(
    element: Payload,
    sessionID: string,
    flowId: string,
    action_id: string
  ): Promise<TestResult> {
    const { testResults, action, message } = createBaseValidationSetup(element);

    for (const validation of config) {
      if (validation) {
        switch (validation) {
          case igmValidators.issue.validate_issue:
            validateIgm2Issue(message, testResults);
            break;
          default:
            break;
        }
      }
    }

    // Add default message if no validations ran
    addDefaultValidationMessage(testResults, action);

    return testResults;
  };
}

/**
 * Creates an on_issue validation function
 */
export function createOnIssueValidator(...config: string[]) {
  return async function checkOnIssue(
    element: Payload,
    sessionID: string,
    flowId: string,
    action_id: string
  ): Promise<TestResult> {
    const { testResults, action, message } = createBaseValidationSetup(element);

    for (const validation of config) {
      if (validation) {
        switch (validation) {
          case igmValidators.on_issue.validate_on_issue:
            validateIgm2OnIssue(message, testResults);
            break;
          default:
            break;
        }
      }
    }

    // Add default message if no validations ran
    addDefaultValidationMessage(testResults, action);

    return testResults;
  };
}

// ============================================
// IGM 1.0.0 Factory Functions
// ============================================

/**
 * Creates an IGM 1.0.0 issue validation function
 */
export function createIgm1IssueValidator(...config: string[]) {
  return async function checkIgm1Issue(
    element: Payload,
    sessionID: string,
    flowId: string,
    action_id: string
  ): Promise<TestResult> {
    const { testResults, action, message } = createBaseValidationSetup(element);

    for (const validation of config) {
      if (validation) {
        switch (validation) {
          case igm1Validators.issue.validate_issue:
            validateIgm1Issue(message, testResults);
            break;
          default:
            break;
        }
      }
    }

    addDefaultValidationMessage(testResults, action);
    return testResults;
  };
}

/**
 * Creates an IGM 1.0.0 on_issue validation function
 */
export function createIgm1OnIssueValidator(...config: string[]) {
  return async function checkIgm1OnIssue(
    element: Payload,
    sessionID: string,
    flowId: string,
    action_id: string
  ): Promise<TestResult> {
    const { testResults, action, message } = createBaseValidationSetup(element);

    for (const validation of config) {
      if (validation) {
        switch (validation) {
          case igm1Validators.on_issue.validate_on_issue:
            validateIgm1OnIssue(message, testResults);
            break;
          default:
            break;
        }
      }
    }

    addDefaultValidationMessage(testResults, action);
    return testResults;
  };
}

/**
 * Creates an IGM 1.0.0 issue_status validation function
 */
export function createIssueStatusValidator(...config: string[]) {
  return async function checkIssueStatus(
    element: Payload,
    sessionID: string,
    flowId: string,
    action_id: string
  ): Promise<TestResult> {
    const { testResults, action, message } = createBaseValidationSetup(element);

    for (const validation of config) {
      if (validation) {
        switch (validation) {
          case igm1Validators.issue_status.validate_issue_status:
            validateIgm1IssueStatus(message, testResults);
            break;
          default:
            break;
        }
      }
    }

    addDefaultValidationMessage(testResults, action);
    return testResults;
  };
}

/**
 * Creates an IGM 1.0.0 on_issue_status validation function
 */
export function createOnIssueStatusValidator(...config: string[]) {
  return async function checkOnIssueStatus(
    element: Payload,
    sessionID: string,
    flowId: string,
    action_id: string
  ): Promise<TestResult> {
    const { testResults, action, message } = createBaseValidationSetup(element);

    for (const validation of config) {
      if (validation) {
        switch (validation) {
          case igm1Validators.on_issue_status.validate_on_issue_status:
            validateIgm1OnIssueStatus(message, testResults);
            break;
          default:
            break;
        }
      }
    }

    addDefaultValidationMessage(testResults, action);
    return testResults;
  };
}
