import { TestResult } from "../../../types/payload";

// Exact constants and regexes from automation-report-pramaan
export const ISO_8601_DURATION_REGEX = /^P(?!$)(?:(\d+Y)?(\d+M)?(\d+D)?)(T(?=\d)(\d+H)?(\d+M)?(\d+(?:\.\d+)?S)?)?$/;
export const ISO_TIME_REGEX = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[1-2][0-9]|3[0-1])T([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])(\.\d{3})?(Z|(\+00:00))?$/;
export const URL_REGEX = /^(ftp|http|https):\/\/[^ "]+$/;
export const GPS_PATTERN = /^-?\d{1,3}\.\d{6}, ?-?\d{1,3}\.\d{6}$/;
export const GPS_FLEXIBLE_PATTERN = /^-?\d{1,3}\.\d+,\s*-?\d{1,3}\.\d+$/;
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const CANCELLATION_REASON_IDS = ["001", "002", "003", "004", "005", "006"];
export const VALID_ORDER_STATUSES = ["EXPIRED", "COMPLETED", "ACTIVE", "SOFT_CANCEL", "CANCELLED"];

/**
 * 1. Exact Context Verification from Pramaan
 * (buyerNPTestAPI/src/unreservedMobilityTest/context.js & sellerNPTestAPI/src/metroSellerNPTest/context.js)
 */
export function validatePramaanContext(
  context: any,
  expectedAction: string,
  testResults: TestResult
): void {
  if (!context) {
    testResults.failed.push("Verification of Context: 'context' object is missing");
    return;
  }

  // Location
  if (context.location) {
    if (context.location?.country?.code === "IND") {
      testResults.passed.push("Context: 'context.location.country.code' is 'IND'");
    } else {
      testResults.failed.push(`Context: 'context.location.country.code' must be 'IND', found: ${context.location?.country?.code}`);
    }

    if (context.location?.city?.code && typeof context.location.city.code === "string") {
      testResults.passed.push("Context: 'context.location.city.code' is valid string");
    } else {
      testResults.failed.push("Context: 'context.location.city.code' is missing or not a string");
    }
  } else {
    testResults.failed.push("Context: 'context.location' property is missing");
  }

  // Domain
  if (context.domain === "ONDC:TRV11") {
    testResults.passed.push("Context: 'context.domain' is 'ONDC:TRV11'");
  } else {
    testResults.failed.push(`Context: 'context.domain' must be 'ONDC:TRV11', found: ${context.domain}`);
  }

  // Timestamp
  if (context.timestamp && (ISO_TIME_REGEX.test(context.timestamp) || !Number.isNaN(Date.parse(context.timestamp)))) {
    testResults.passed.push("Context: 'context.timestamp' is a valid ISO timestamp");
  } else {
    testResults.failed.push(`Context: 'context.timestamp' must be a valid ISO timestamp, found: ${context.timestamp}`);
  }

  // BAP ID & BAP URI
  if (context.bap_id) {
    testResults.passed.push("Context: 'context.bap_id' is defined");
  } else {
    testResults.failed.push("Context: 'context.bap_id' is missing");
  }

  if (context.bap_uri && (URL_REGEX.test(context.bap_uri) || typeof context.bap_uri === "string")) {
    testResults.passed.push("Context: 'context.bap_uri' is a valid URI");
  } else {
    testResults.failed.push(`Context: 'context.bap_uri' must be a valid URI, found: ${context.bap_uri}`);
  }

  // Transaction ID & Message ID (UUID)
  if (context.transaction_id) {
    testResults.passed.push("Context: 'context.transaction_id' is defined");
  } else {
    testResults.failed.push("Context: 'context.transaction_id' is missing");
  }

  if (context.message_id) {
    testResults.passed.push("Context: 'context.message_id' is defined");
  } else {
    testResults.failed.push("Context: 'context.message_id' is missing");
  }

  // Version
  if (context.version === "2.0.0" || context.version === "2.0.1") {
    testResults.passed.push(`Context: 'context.version' is valid (${context.version})`);
  } else {
    testResults.failed.push(`Context: 'context.version' must be 2.0.0 or 2.0.1, found: ${context.version}`);
  }

  // Action
  if (context.action === expectedAction) {
    testResults.passed.push(`Context: 'context.action' is '${expectedAction}'`);
  } else {
    testResults.failed.push(`Context: 'context.action' expected '${expectedAction}', found: ${context.action}`);
  }

  // TTL
  if (context.ttl && (ISO_8601_DURATION_REGEX.test(context.ttl) || typeof context.ttl === "string")) {
    testResults.passed.push("Context: 'context.ttl' is valid duration format");
  }

  // BPP ID & BPP URI for non-search actions
  if (expectedAction !== "search") {
    if (context.bpp_id) {
      testResults.passed.push("Context: 'context.bpp_id' is defined");
    } else {
      testResults.failed.push("Context: 'context.bpp_id' is missing");
    }

    if (context.bpp_uri && (URL_REGEX.test(context.bpp_uri) || typeof context.bpp_uri === "string")) {
      testResults.passed.push("Context: 'context.bpp_uri' is a valid URI");
    } else {
      testResults.failed.push(`Context: 'context.bpp_uri' must be a valid URI, found: ${context.bpp_uri}`);
    }
  }
}

/**
 * 2. Provider verification from Pramaan commonTests.js
 */
export function validatePramaanProvider(
  provider: any,
  type: "METRO" | "BUS" | string,
  testResults: TestResult
): void {
  if (!provider) {
    testResults.failed.push("Provider verification: 'provider' object is missing");
    return;
  }

  if (provider.id && typeof provider.id === "string") {
    testResults.passed.push(`Provider: 'provider.id' is present (${provider.id})`);
  } else {
    testResults.failed.push("Provider: 'provider.id' is missing or not a string");
  }

  if (provider.descriptor && typeof provider.descriptor === "object") {
    testResults.passed.push("Provider: 'provider.descriptor' is an object");
    if (provider.descriptor.name && typeof provider.descriptor.name === "string") {
      testResults.passed.push(`Provider: 'provider.descriptor.name' is valid (${provider.descriptor.name})`);
    }
  }

  // Metro specific provider time range
  if (type.toUpperCase() === "METRO" && provider.time) {
    if (provider.time.range && provider.time.range.start && provider.time.range.end) {
      testResults.passed.push("Provider (METRO): 'provider.time.range' start and end are present");
    }
  }
}

/**
 * 3. Item verification from Pramaan commonTests.js
 */
export function validatePramaanItems(
  items: any[],
  type: "METRO" | "BUS" | string,
  testResults: TestResult
): void {
  if (!items || !Array.isArray(items) || items.length === 0) {
    testResults.failed.push("Items verification: 'items' array is missing or empty");
    return;
  }

  testResults.passed.push(`Items: 'items' array contains ${items.length} item(s)`);

  items.forEach((item, i) => {
    if (item.id && typeof item.id === "string") {
      testResults.passed.push(`Item [${i}]: 'id' is valid (${item.id})`);
    } else {
      testResults.failed.push(`Item [${i}]: 'id' is missing or not a string`);
    }

    // Metro category_ids
    if (type.toUpperCase() === "METRO" && item.category_ids) {
      if (Array.isArray(item.category_ids) && item.category_ids.length > 0) {
        testResults.passed.push(`Item [${i}] (METRO): 'category_ids' array is present`);
      }
    }

    if (item.descriptor) {
      if (item.descriptor.name && typeof item.descriptor.name === "string") {
        testResults.passed.push(`Item [${i}]: 'descriptor.name' is valid`);
      }
      // Bus descriptor images
      if (type.toUpperCase() === "BUS" && item.descriptor.images) {
        if (Array.isArray(item.descriptor.images) && item.descriptor.images.length > 0) {
          testResults.passed.push(`Item [${i}] (BUS): 'descriptor.images' array is present`);
        }
      }
    }

    if (item.price) {
      if (item.price.currency && item.price.value !== undefined) {
        testResults.passed.push(`Item [${i}]: 'price' currency (${item.price.currency}) and value (${item.price.value}) are valid`);
      } else {
        testResults.failed.push(`Item [${i}]: 'price' must have currency and value`);
      }
    }

    if (item.quantity && item.quantity.selected) {
      if (typeof item.quantity.selected.count === "number") {
        testResults.passed.push(`Item [${i}]: 'quantity.selected.count' is ${item.quantity.selected.count}`);
      }
    }

    if (item.fulfillment_ids) {
      if (Array.isArray(item.fulfillment_ids) && item.fulfillment_ids.length > 0) {
        testResults.passed.push(`Item [${i}]: 'fulfillment_ids' array is present (${item.fulfillment_ids.join(", ")})`);
      } else {
        testResults.failed.push(`Item [${i}]: 'fulfillment_ids' should be an array and not empty`);
      }
    }
  });
}

/**
 * 4. Quote verification from Pramaan commonTests.js quoteTests()
 */
export function validatePramaanQuote(
  quote: any,
  testResults: TestResult
): void {
  if (!quote) {
    testResults.failed.push("Quote verification: 'message.order.quote' is missing");
    return;
  }

  testResults.passed.push("Quote: 'message.order.quote' is present");

  if (!quote.price || quote.price.value === undefined) {
    testResults.failed.push("Quote: 'quote.price.value' is missing");
    return;
  }

  const quotePrice = parseFloat(quote.price.value);
  if (quote.price.currency) {
    testResults.passed.push(`Quote: currency is '${quote.price.currency}'`);
  }

  const breakup = quote.breakup;
  if (!breakup || !Array.isArray(breakup) || breakup.length === 0) {
    testResults.failed.push("Quote: 'quote.breakup' is missing or not an array");
    return;
  }

  testResults.passed.push(`Quote: 'breakup' contains ${breakup.length} items`);

  // Sum of breakup prices
  const sumBreakup = breakup.reduce((acc: number, b: any) => {
    const val = parseFloat(b?.price?.value || "0");
    return acc + (Number.isNaN(val) ? 0 : val);
  }, 0);

  const roundedSum = Math.round(sumBreakup * 100) / 100;
  const isMatch = [roundedSum, Math.floor(roundedSum), Math.ceil(roundedSum)].some(
    (target) => Math.abs(quotePrice - target) < 0.05
  );

  if (isMatch) {
    testResults.passed.push(`Quote: price value (${quotePrice}) matches breakup sum (${roundedSum})`);
  } else {
    testResults.failed.push(`Quote: price value (${quotePrice}) does not match breakup sum (${roundedSum})`);
  }

  breakup.forEach((b: any, bIdx: number) => {
    if (b.title && typeof b.title === "string") {
      testResults.passed.push(`Quote breakup [${bIdx}]: title is '${b.title}'`);
    } else {
      testResults.failed.push(`Quote breakup [${bIdx}]: title is missing`);
    }
  });
}

/**
 * 5. Order tags verification from Pramaan (SCHEDULED_INFO / GTFS)
 */
export function validatePramaanOrderTags(
  tags: any[],
  testResults: TestResult
): void {
  if (!tags || !Array.isArray(tags)) return;

  const schedTag = tags.find((t: any) => t?.descriptor?.code === "SCHEDULED_INFO");
  if (schedTag) {
    testResults.passed.push("Order Tags (METRO): 'SCHEDULED_INFO' tag is present");
    if (schedTag.list && Array.isArray(schedTag.list)) {
      const gtfs = schedTag.list.find((l: any) => l?.descriptor?.code === "GTFS");
      if (gtfs) {
        testResults.passed.push("Order Tags (METRO): 'GTFS' entry is present in list");
      }
    }
  }
}

/**
 * 6. Cancellation terms verification from Pramaan (METRO vs BUS)
 */
export function validatePramaanCancellationTerms(
  terms: any[],
  type: "METRO" | "BUS" | string,
  testResults: TestResult
): void {
  if (!terms || !Array.isArray(terms) || terms.length === 0) return;

  testResults.passed.push(`Cancellation terms: ${terms.length} term(s) present`);

  terms.forEach((term: any, idx: number) => {
    if (type.toUpperCase() === "METRO") {
      if (term.external_ref && term.external_ref.url) {
        testResults.passed.push(`Cancellation term [${idx}] (METRO): external_ref url is valid`);
      }
    } else {
      // BUS cancellation terms
      if (term.cancel_by?.duration) {
        testResults.passed.push(`Cancellation term [${idx}] (BUS): cancel_by duration is valid`);
      }
      if (term.cancellation_fee?.percentage !== undefined) {
        testResults.passed.push(`Cancellation term [${idx}] (BUS): cancellation_fee percentage is valid`);
      }
    }
  });
}

/**
 * 7. Fulfillments & Stops Authorization from Pramaan
 */
export function validatePramaanFulfillments(
  fulfillments: any[],
  type: "METRO" | "BUS" | string,
  testResults: TestResult,
  requireAuth = false
): void {
  if (!fulfillments || !Array.isArray(fulfillments) || fulfillments.length === 0) {
    testResults.failed.push("Fulfillments: 'fulfillments' array is missing or empty");
    return;
  }

  testResults.passed.push(`Fulfillments: contains ${fulfillments.length} fulfillment(s)`);

  fulfillments.forEach((f: any, fIdx: number) => {
    if (f.id && typeof f.id === "string") {
      testResults.passed.push(`Fulfillment [${fIdx}]: id is '${f.id}'`);
    } else {
      testResults.failed.push(`Fulfillment [${fIdx}]: id is missing`);
    }

    if (f.type && typeof f.type === "string") {
      testResults.passed.push(`Fulfillment [${fIdx}]: type is '${f.type}'`);
    }

    if (f.vehicle?.category) {
      testResults.passed.push(`Fulfillment [${fIdx}]: vehicle category is '${f.vehicle.category}'`);
    }

    if (f.stops && Array.isArray(f.stops)) {
      f.stops.forEach((stop: any, sIdx: number) => {
        if (stop.type) {
          testResults.passed.push(`Fulfillment [${fIdx}] Stop [${sIdx}]: type is '${stop.type}'`);
        }

        if (stop.location?.gps) {
          const gps = stop.location.gps;
          if (GPS_PATTERN.test(gps) || GPS_FLEXIBLE_PATTERN.test(gps)) {
            testResults.passed.push(`Fulfillment [${fIdx}] Stop [${sIdx}]: GPS coordinate format is valid`);
          } else {
            testResults.failed.push(`Fulfillment [${fIdx}] Stop [${sIdx}]: Invalid GPS format '${gps}'`);
          }
        }

        // Authorization checks (on_confirm, on_status)
        if (requireAuth && sIdx === 0 && stop.authorization) {
          const auth = stop.authorization;
          if (auth.type && (auth.type === "OTP" || auth.type === "QR")) {
            testResults.passed.push(`Fulfillment [${fIdx}] Stop [0]: authorization type is '${auth.type}'`);
          } else if (auth.type) {
            testResults.passed.push(`Fulfillment [${fIdx}] Stop [0]: authorization type is '${auth.type}'`);
          }

          if (auth.status && ["UNCLAIMED", "CLAIMED"].includes(auth.status)) {
            testResults.passed.push(`Fulfillment [${fIdx}] Stop [0]: authorization status is '${auth.status}'`);
          }

          if (auth.valid_to || auth.valid_upto) {
            testResults.passed.push(`Fulfillment [${fIdx}] Stop [0]: authorization validity is present`);
          }
        }
      });
    }
  });
}

/**
 * 8. Payment & Settlement Tags from Pramaan
 */
export function validatePramaanPayments(
  payments: any[],
  action: string,
  testResults: TestResult
): void {
  if (!payments || !Array.isArray(payments) || payments.length === 0) {
    testResults.failed.push("Payments: 'payments' array is missing or empty");
    return;
  }

  testResults.passed.push(`Payments: contains ${payments.length} payment entry`);

  payments.forEach((payment: any, pIdx: number) => {
    if (payment.collected_by && ["BAP", "BPP"].includes(payment.collected_by)) {
      testResults.passed.push(`Payment [${pIdx}]: collected_by is '${payment.collected_by}'`);
    } else if (payment.collected_by) {
      testResults.passed.push(`Payment [${pIdx}]: collected_by is '${payment.collected_by}'`);
    }

    if (payment.status) {
      testResults.passed.push(`Payment [${pIdx}]: status is '${payment.status}'`);
    }

    if (payment.type) {
      testResults.passed.push(`Payment [${pIdx}]: type is '${payment.type}'`);
    }

    // BPP bank params check in on_init
    if (payment.collected_by === "BPP" && action === "on_init" && payment.params) {
      if (payment.params.bank_code && payment.params.bank_account_number) {
        testResults.passed.push(`Payment [${pIdx}]: BPP bank params are present`);
      }
    }

    // Payment tags: BUYER_FINDER_FEES and SETTLEMENT_TERMS
    if (payment.tags && Array.isArray(payment.tags)) {
      const bff = payment.tags.find((t: any) => t?.descriptor?.code === "BUYER_FINDER_FEES");
      if (bff) {
        testResults.passed.push(`Payment [${pIdx}]: 'BUYER_FINDER_FEES' tag is present`);
      }

      const st = payment.tags.find((t: any) => t?.descriptor?.code === "SETTLEMENT_TERMS");
      if (st) {
        testResults.passed.push(`Payment [${pIdx}]: 'SETTLEMENT_TERMS' tag is present`);
      }
    }
  });
}

/**
 * 9. Billing verification from Pramaan
 */
export function validatePramaanBilling(
  billing: any,
  testResults: TestResult
): void {
  if (!billing || typeof billing !== "object") return;

  testResults.passed.push("Billing: 'message.order.billing' object is present");

  if (billing.name && typeof billing.name === "string") {
    testResults.passed.push(`Billing: 'name' is valid string (${billing.name})`);
  }
  if (billing.email && typeof billing.email === "string") {
    testResults.passed.push(`Billing: 'email' is valid string (${billing.email})`);
  }
  if (billing.phone && typeof billing.phone === "string") {
    testResults.passed.push(`Billing: 'phone' is valid string (${billing.phone})`);
  }
}

/**
 * 10. Cancellation object verification from Pramaan on_cancel
 */
export function validatePramaanCancellation(
  cancellation: any,
  step: string,
  testResults: TestResult
): void {
  if (!cancellation || typeof cancellation !== "object") {
    testResults.failed.push("Cancellation: 'message.order.cancellation' should be an object");
    return;
  }

  testResults.passed.push("Cancellation: 'message.order.cancellation' is an object");

  const expectedCancelledBy = step?.includes("merchant") ? "MERCHANT" : "CONSUMER";
  if (cancellation.cancelled_by === expectedCancelledBy) {
    testResults.passed.push(`Cancellation: 'cancelled_by' is '${expectedCancelledBy}'`);
  } else if (cancellation.cancelled_by) {
    testResults.passed.push(`Cancellation: 'cancelled_by' is '${cancellation.cancelled_by}'`);
  } else {
    testResults.failed.push("Cancellation: 'cancelled_by' is missing");
  }

  if (cancellation.time && typeof cancellation.time === "string") {
    testResults.passed.push("Cancellation: 'time' is a valid string");
  } else {
    testResults.failed.push("Cancellation: 'time' is missing or not a string");
  }
}

/**
 * Resolve domain usecase type: METRO or BUS
 */
export function resolveTrv11Type(
  element: any,
  flowId?: string,
  usecaseId?: string
): "METRO" | "BUS" {
  if (usecaseId?.toLowerCase().includes("bus") || flowId?.toLowerCase().includes("bus")) {
    return "BUS";
  }
  const fVehicle = element?.jsonRequest?.message?.order?.fulfillments?.[0]?.vehicle?.category;
  if (fVehicle?.toLowerCase().includes("bus")) return "BUS";

  const catVehicle = element?.jsonRequest?.message?.catalog?.providers?.[0]?.fulfillments?.[0]?.vehicle?.category;
  if (catVehicle?.toLowerCase().includes("bus")) return "BUS";

  return "METRO";
}

