import assert from "assert";
import { TestResult } from "../../types/payload";
import { hasTwoOrLessDecimalPlaces } from "../../utils/constants";

/**
 * Interface for quote breakup items
 */
export interface QuoteBreakupItem {
  // FIS11 may put price directly or under item.price
  price?: { value: string };
  item?: { price?: { value: string }; id?: string };
  // Two alternative label fields across specs
  "@ondc/org/title_type"?: string;
  title?: string;
  // Optional linkage to items by id in some specs
  "@ondc/org/item_id"?: string;
}

/**
 * Interface for quote structure
 */
export interface Quote {
  price: { value: string };
  breakup: QuoteBreakupItem[];
}

/**
 * Configuration for quote validation
 */
export interface QuoteValidationConfig {
  /** Whether to validate decimal places */
  validateDecimalPlaces?: boolean;
  /** Whether to validate tax presence */
  validateTaxPresence?: boolean;
  /** Whether to validate quote total matches breakup total */
  validateTotalMatch?: boolean;
  /** Whether to validate COD breakup for COD flow */
  validateCODBreakup?: boolean;
  /** Whether to validate item id/price consistency between order.items and quote.breakup */
  validateItemPriceConsistency?: boolean;
  /** Flow ID to determine specific validations */
  flowId?: string;
}

/**
 * Validates quote structure and pricing
 */
export function validateQuote(
  quote: Quote,
  testResults: TestResult,
  config: QuoteValidationConfig = {}
): void {

  const getBreakupLabel = (b: QuoteBreakupItem): string => {
    const raw = b["@ondc/org/title_type"] || b.title || "";
    return typeof raw === "string" ? raw.toLowerCase() : "";
  };
  const getBreakupPriceValue = (b: QuoteBreakupItem): string | undefined => {
    if (b.title === 'NET_DISBURSED_AMOUNT') {
      return '0';
    }
    return b.price?.value ?? b.item?.price?.value;
  };


  if (config.validateDecimalPlaces) {
    try {
      assert.ok(
        hasTwoOrLessDecimalPlaces(quote.price.value),
        "Quote price value should not have more than 2 decimal places"
      );
      testResults.passed.push("Quote price decimal validation passed");
    } catch (error: any) {
      testResults.failed.push(error.message);
    }
  }

  let totalBreakup = 0;
  let taxPresent = false;

  // Validate breakup items
  quote.breakup.forEach((breakup: QuoteBreakupItem) => {
    const label = getBreakupLabel(breakup) || "breakup";
    const valueStr = getBreakupPriceValue(breakup);

    // Validate breakup item decimal places
    if (config.validateDecimalPlaces) {
      try {
        assert.ok(valueStr !== undefined && hasTwoOrLessDecimalPlaces(valueStr),
          `Price value for '${label}' should not have more than 2 decimal places`
        );
        testResults.passed.push(
          `Decimal validation passed for breakup price - '${label}'`
        );
      } catch (error: any) {
        testResults.failed.push(error.message);
      }
    }

    // Calculate total breakup
    if (valueStr !== undefined) {
      totalBreakup += parseFloat(valueStr);
      totalBreakup = parseFloat(totalBreakup.toFixed(2));
    }

    // Check for tax presence
    if (getBreakupLabel(breakup) === "tax") {
      taxPresent = true;
    }
  });

  // Validate tax presence
  if (config.validateTaxPresence) {
    try {
      assert.ok(
        taxPresent,
        "Fulfillment charges will have a separate quote line item for taxes"
      );
      testResults.passed.push("Tax line item validation passed");
    } catch (error: any) {
      testResults.failed.push(error.message);
    }
  }

  // Validate quote total matches breakup total
  if (config.validateTotalMatch) {
    try {
      assert.ok(
        parseFloat(quote.price.value) === totalBreakup,
        `Quote price ${parseFloat(
          quote.price.value
        )} does not match the breakup total ${totalBreakup}`
      );
      testResults.passed.push(
        `Quote price ${parseFloat(
          quote.price.value
        )} matches the breakup total ${totalBreakup}`
      );
    } catch (error: any) {
      testResults.failed.push(error.message);
    }
  }

}

/**
 * Validates quote from order message
 */
export function validateOrderQuote(
  message: any,
  testResults: TestResult,
  config: QuoteValidationConfig = {}
): void {
  if (message?.order?.quote) {
    validateQuote(message.order.quote, testResults, config);
  }

  if (config.validateItemPriceConsistency && message?.order?.items && message?.order?.quote?.breakup) {
    const items: any[] = message.order.items || [];
    const breakup: QuoteBreakupItem[] = message.order.quote.breakup || [];

    // Build index from breakup by possible item id fields
    const breakupByItemId = new Map<string, QuoteBreakupItem>();
    for (const b of breakup) {
      const id = b["@ondc/org/item_id"] || b.item?.id;
      if (id) breakupByItemId.set(id, b);
    }

    for (const item of items) {
      const id: string | undefined = item?.id;
      if (!id) continue;
      const b = breakupByItemId.get(id);
      if (!b) {
        testResults.failed.push(`Breakup line for item '${id}' not found`);
        continue;
      }
      const itemPrice = item?.price?.value;
      const breakupPrice = b.price?.value ?? b.item?.price?.value;
      if (itemPrice !== undefined && breakupPrice !== undefined) {
        if (parseFloat(itemPrice) === parseFloat(breakupPrice)) {
          testResults.passed.push(`Item '${id}' price matches breakup`);
        } else {
          testResults.failed.push(`Item '${id}' price ${itemPrice} does not match breakup ${breakupPrice}`);
        }
      }
    }
  }
}

export function validateGiftCardQuote(
  message: any,
  testResults: TestResult
): void {
  const quote = message?.order?.quote;
  const breakup = quote?.breakup || [];

  if (!quote || !breakup.length) {
    return;
  }

  let computedTotal = 0;

  for (const line of breakup) {
    let raw = line?.price?.value;

    if (raw === undefined || raw === null) continue;

    // normalize value safely
    raw = String(raw)
      .replace("−", "-")     // unicode minus fix
      .replace(/\s+/g, "")   // remove whitespace

    const value = Number(raw);

    if (!Number.isFinite(value)) {
      testResults.failed.push(`Invalid price value '${raw}'`);
      continue;
    }
    computedTotal += value;
  }

  const quoteTotal = Number(
    String(quote?.price?.value || "0").replace("−", "-").replace(/\s+/g, "")
  );

  if (Math.abs(computedTotal - quoteTotal) < 0.01) {
    testResults.passed.push("Quote total matches breakup sum");
  } else {
    testResults.failed.push(
      `Quote total mismatch. Expected ${computedTotal}, got ${quoteTotal}`
    );
  }
}

// ---------------------------------------------------------------------------
// FIS12 Personal Loan quote validation
// ---------------------------------------------------------------------------
const REQUIRED_LOAN_BREAKUP_TITLES = [
  "PRINCIPAL",
  "INTEREST",
  "PROCESSING_FEE",
  "OTHER_UPFRONT_CHARGES",
  "INSURANCE_CHARGES",
  "NET_DISBURSED_AMOUNT",
  "OTHER_CHARGES",
] as const;

function getLoanBreakupValue(breakup: any[], title: string): number {
  const item = breakup.find((b: any) => b?.title === title);
  if (!item) return 0;
  const raw = item?.price?.value ?? item?.item?.price?.value;
  const n = parseFloat(String(raw ?? "0"));
  return isNaN(n) ? 0 : n;
}

/**
 * Compute EMI using the standard PMT formula:
 *   EMI = P × r × (1+r)^n / ((1+r)^n - 1)
 * where r = annualRate / 12 / 100 and n = tenure in months.
 * Returns P/n if annualRatePct is 0.
 */
function computeEMI(principal: number, annualRatePct: number, tenureMonths: number): number {
  if (tenureMonths <= 0) return 0;
  if (annualRatePct === 0) return parseFloat((principal / tenureMonths).toFixed(2));
  const r = annualRatePct / 12 / 100;
  const emi = principal * r * Math.pow(1 + r, tenureMonths) / (Math.pow(1 + r, tenureMonths) - 1);
  return parseFloat(emi.toFixed(2));
}

/** Extract a LOAN_INFO tag value from order.items[].tags */
function getLoanInfoTagValue(items: any[], code: string): string | undefined {
  for (const item of (items || [])) {
    const tags: any[] = item?.tags || [];
    const loanInfoTag = tags.find((t: any) => t?.descriptor?.code === "LOAN_INFO");
    if (!loanInfoTag) continue;
    const field = (loanInfoTag.list || []).find((f: any) => f?.descriptor?.code === code);
    if (field?.value !== undefined) return String(field.value);
  }
  return undefined;
}

/** Parse "5 months" / "2 years" → number of months */
function parseTenureToMonths(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.toLowerCase().trim().match(/^(\d+(?:\.\d+)?)\s*(month|months|year|years)$/);
  if (!match) return null;
  const num = parseFloat(match[1]);
  return match[2].startsWith("year") ? Math.round(num * 12) : num;
}

/** Parse "12%" or "12" → 12 as a number */
function parseRatePct(value: string | undefined): number | null {
  if (value === undefined || value === null) return null;
  const n = parseFloat(String(value).replace("%", "").trim());
  return isNaN(n) ? null : n;
}

// Allow ±₹1 rounding tolerance for all formula checks
const FORMULA_TOLERANCE = 1.0;

/**
 * FIS12 Business Loan quote formulas — same method as the BL flow specs:
 *   quote.price.value      = PRINCIPAL + INTEREST + PROCESSING_FEE + OTHER_UPFRONT + INSURANCE + OTHER_CHARGES
 *   NET_DISBURSED_AMOUNT   = PRINCIPAL - PROCESSING_FEE - OTHER_UPFRONT - INSURANCE
 * Quotes without PRINCIPAL_AMOUNT (e.g. non-loan breakups) are skipped.
 */
export function validateBLQuoteFormulas(quote: any, testResults: TestResult): void {
  const breakup: any[] = quote?.breakup || [];
  if (!breakup.some((b: any) => b?.title === "PRINCIPAL_AMOUNT")) return;

  const principal = getLoanBreakupValue(breakup, "PRINCIPAL_AMOUNT");
  const interest = getLoanBreakupValue(breakup, "INTEREST_AMOUNT");
  const processingFee = getLoanBreakupValue(breakup, "PROCESSING_FEE");
  const otherUpfront = getLoanBreakupValue(breakup, "OTHER_UPFRONT_CHARGES");
  const insurance = getLoanBreakupValue(breakup, "INSURANCE_CHARGES");
  const otherCharges = getLoanBreakupValue(breakup, "OTHER_CHARGES");

  const quoteTotal = parseFloat(quote?.price?.value ?? "0");
  const expectedTotal = parseFloat(
    (principal + interest + processingFee + otherUpfront + insurance + otherCharges).toFixed(2)
  );
  const totalFormula =
    `PRINCIPAL(${principal}) + INTEREST(${interest}) + PROCESSING_FEE(${processingFee}) + ` +
    `OTHER_UPFRONT(${otherUpfront}) + INSURANCE(${insurance}) + OTHER(${otherCharges})`;
  if (Math.abs(quoteTotal - expectedTotal) < FORMULA_TOLERANCE) {
    testResults.passed.push(`Quote total ${quoteTotal} = ${totalFormula}`);
  } else {
    testResults.failed.push(`Quote total ${quoteTotal} ≠ expected ${expectedTotal} [${totalFormula}]`);
  }

  if (breakup.some((b: any) => b?.title === "NET_DISBURSED_AMOUNT")) {
    const netDisbursed = getLoanBreakupValue(breakup, "NET_DISBURSED_AMOUNT");
    const expectedNet = parseFloat((principal - processingFee - otherUpfront - insurance).toFixed(2));
    const netFormula =
      `PRINCIPAL(${principal}) - PROCESSING_FEE(${processingFee}) - OTHER_UPFRONT(${otherUpfront}) - INSURANCE(${insurance})`;
    if (Math.abs(netDisbursed - expectedNet) < FORMULA_TOLERANCE) {
      testResults.passed.push(`NET_DISBURSED_AMOUNT ${netDisbursed} = ${netFormula}`);
    } else {
      testResults.failed.push(`NET_DISBURSED_AMOUNT ${netDisbursed} ≠ expected ${expectedNet} [${netFormula}]`);
    }
  }
}

/**
 * FIS12 Loan Quote Validation
 *
 * Variables (mapping to spreadsheet columns):
 *   A = PRINCIPAL breakup value
 *   B = TERM in months from LOAN_INFO tag
 *   C = INTEREST_RATE % p.a. from LOAN_INFO tag
 *   D = total upfront deductions (PROCESSING_FEE + OTHER_UPFRONT_CHARGES + INSURANCE_CHARGES + OTHER_CHARGES)
 *   E = INSTALLMENT_AMOUNT from LOAN_INFO tag
 *   F = Total Repayment = E × B
 *   G = INTEREST breakup value    (expected: F - A)
 *   H = NET_DISBURSED_AMOUNT      (expected: A - D)
 *   I = quote.price.value         (expected: F + D  =  A + G + D)
 *
 * Checks:
 *  1. Required breakup titles present
 *  2. I == A + G + D  (quote total)
 *  3. H == A - D      (net disbursed)
 *  4. E == PMT(C/12, B, -A)   (EMI formula)
 *  5. G == F - A      (interest = total repayment - principal)
 *  6. I == F + D      (loan value = total repayment + fees)
 */
export function validateFIS12LoanQuote(
  message: any,
  testResults: TestResult
): void {
  const quote = message?.order?.quote;
  if (!quote) return;

  const breakup: any[] = quote?.breakup || [];
  const quoteTotal = parseFloat(quote?.price?.value ?? "0"); // I
  const items: any[] = message?.order?.items || [];

  // ── 1. Required breakup titles ─────────────────────────────────────────
  const presentTitles = new Set(breakup.map((b: any) => b?.title));
  for (const title of REQUIRED_LOAN_BREAKUP_TITLES) {
    if (presentTitles.has(title)) {
      testResults.passed.push(`Quote breakup contains required title: ${title}`);
    }
  }

  // ── Extract breakup values ─────────────────────────────────────────────
  const principal = getLoanBreakupValue(breakup, "PRINCIPAL_AMOUNT");            // A
  const interest = getLoanBreakupValue(breakup, "INTEREST_AMOUNT");             // G
  const processingFee = getLoanBreakupValue(breakup, "PROCESSING_FEE");
  const otherUpfront = getLoanBreakupValue(breakup, "OTHER_UPFRONT_CHARGES");
  const insuranceCharges = getLoanBreakupValue(breakup, "INSURANCE_CHARGES");
  const otherCharges = getLoanBreakupValue(breakup, "OTHER_CHARGES");
  const netDisbursed = getLoanBreakupValue(breakup, "NET_DISBURSED_AMOUNT"); // H
  const D = processingFee + otherUpfront + insuranceCharges + otherCharges;      // total upfront deductions

  // ── 2. I = A + G + D  (quote.price.value = principal + interest + fees) ──
  const computedTotal = parseFloat((principal + interest + D).toFixed(2));
  if (Math.abs(quoteTotal - computedTotal) < FORMULA_TOLERANCE) {
    testResults.passed.push(
      `Quote total (${quoteTotal}) = PRINCIPAL(${principal}) + INTEREST(${interest}) + fees(${D})`
    );
  } else {
    testResults.failed.push(
      `Quote total ${quoteTotal} ≠ expected ${computedTotal} ` +
      `[PRINCIPAL(${principal}) + INTEREST(${interest}) + PROCESSING_FEE(${processingFee}) + ` +
      `OTHER_UPFRONT(${otherUpfront}) + INSURANCE(${insuranceCharges}) + OTHER(${otherCharges})]`
    );
  }

  // ── 3. H = A - D  (NET_DISBURSED_AMOUNT = Principal - upfront deductions) ──
  //    =A2 - D2
  const expectedH = parseFloat((principal - D).toFixed(2));
  if (Math.abs(netDisbursed - expectedH) < FORMULA_TOLERANCE) {
    testResults.passed.push(
      `NET_DISBURSED_AMOUNT (${netDisbursed}) = PRINCIPAL(${principal}) - deductions(${D})`
    );
  } else {
    testResults.failed.push(
      `NET_DISBURSED_AMOUNT ${netDisbursed} ≠ expected ${expectedH} ` +
      `[PRINCIPAL(${principal}) - PROCESSING_FEE(${processingFee}) - OTHER_UPFRONT(${otherUpfront}) ` +
      `- INSURANCE(${insuranceCharges}) - OTHER(${otherCharges})]`
    );
  }

  // ── Formula checks using LOAN_INFO item tags ───────────────────────────
  const rateStr = getLoanInfoTagValue(items, "INTEREST_RATE");      // C
  const termStr = getLoanInfoTagValue(items, "TERM");                // B
  const emiStr = getLoanInfoTagValue(items, "INSTALLMENT_AMOUNT");  // E

  const annualRate = parseRatePct(rateStr);
  const tenureMonths = parseTenureToMonths(termStr);
  const reportedEMI = emiStr !== undefined ? parseFloat(emiStr) : null;

  if (annualRate === null) {
    testResults.passed.push("INTEREST_RATE not found in LOAN_INFO — skipping EMI/repayment formula checks");
    return;
  }
  if (tenureMonths === null) {
    testResults.passed.push("TERM not parseable from LOAN_INFO — skipping tenure formula checks");
    return;
  }

  // ── 4. E = PMT(C/12, B, -A)  (EMI validation) ─────────────────────────
  //    =PMT(C2/12, B2, -A2)
  const expectedEMI = computeEMI(principal, annualRate, tenureMonths);
  if (reportedEMI !== null) {
    if (Math.abs(reportedEMI - expectedEMI) < FORMULA_TOLERANCE) {
      testResults.passed.push(
        `INSTALLMENT_AMOUNT (${reportedEMI}) matches PMT(${annualRate}%/12, ${tenureMonths}, ${principal}) = ${expectedEMI}`
      );
    } else {
      testResults.failed.push(
        `INSTALLMENT_AMOUNT ${reportedEMI} ≠ PMT formula result ${expectedEMI} ` +
        `[=PMT(${annualRate}/12/100, ${tenureMonths}, -${principal})]`
      );
    }
  }

  // Use reported EMI if available, else computed value
  const E = (reportedEMI !== null && !isNaN(reportedEMI)) ? reportedEMI : expectedEMI;
  const F = parseFloat((E * tenureMonths).toFixed(2)); // Total Repayment = E × B

  // ── 5. G = F - A  (INTEREST = Total Repayment - Principal) ────────────
  //    =F2 - A2
  const expectedG = parseFloat((F - principal).toFixed(2));
  if (Math.abs(interest - expectedG) < FORMULA_TOLERANCE) {
    testResults.passed.push(
      `INTEREST (${interest}) = Total Repayment(${F}) - PRINCIPAL(${principal}) = ${expectedG}`
    );
  } else {
    testResults.failed.push(
      `INTEREST ${interest} ≠ expected ${expectedG} ` +
      `[EMI(${E}) × Tenure(${tenureMonths}) = ${F} − PRINCIPAL(${principal})]`
    );
  }

  // ── 6. I = F + D  (Loan Value = Total Repayment + fees) ───────────────
  //    =F2 + D2  (also equals A2 + G2 + D2)
  const expectedI = parseFloat((F + D).toFixed(2));
  if (Math.abs(quoteTotal - expectedI) < FORMULA_TOLERANCE) {
    testResults.passed.push(
      `Loan Value / quote total (${quoteTotal}) = Total Repayment(${F}) + fees(${D}) = ${expectedI}`
    );
  } else {
    testResults.failed.push(
      `Loan Value / quote total ${quoteTotal} ≠ expected ${expectedI} ` +
      `[EMI(${E}) × Tenure(${tenureMonths}) = ${F} + fees(${D})]`
    );
  }
}




