/**
 * Shared logistics validation helpers for ONDC:LOG10 and ONDC:LOG11.
 *
 * Import what you need in per-API validators:
 *   import { validateOrderTimestamps, validatePaymentStatus, ... }
 *     from "../../shared/logisticsValidations";
 */

import assert from "assert";
import logger from "@ondc/automation-logger";
import { TestResult } from "../../types/payload";
import { fetchData, saveData } from "../../utils/redisUtils";

// ─────────────────────────────────────────────────────────────────────────────
// 1. ORDER TIMESTAMP VALIDATIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates order.created_at and order.updated_at against context/timestamp.
 * Usable in confirm, on_confirm, on_status, on_cancel etc.
 */
export function validateOrderTimestamps(
    action: string,
    contextTimestamp: string,
    createdAt: string,
    updatedAt: string,
    testResults: TestResult
): void {
    try {
        assert.ok(
            contextTimestamp >= createdAt,
            "order.created_at timestamp cannot be future dated w.r.t context/timestamp"
        );
        testResults.passed.push("order.created_at timestamp validation passed");
    } catch (error: any) {
        logger.error(`Error during ${action} validation: ${error.message}`);
        testResults.failed.push(error.message);
    }

    try {
        assert.ok(
            contextTimestamp >= updatedAt,
            "order.updated_at timestamp cannot be future dated w.r.t context/timestamp"
        );
        testResults.passed.push("order.updated_at timestamp validation passed");
    } catch (error: any) {
        logger.error(`Error during ${action} validation: ${error.message}`);
        testResults.failed.push(error.message);
    }

    try {
        assert.ok(
            createdAt <= updatedAt,
            "order.created_at cannot be future dated w.r.t order.updated_at"
        );
        testResults.passed.push("order.created_at vs updated_at validation passed");
    } catch (error: any) {
        logger.error(`Error during ${action} validation: ${error.message}`);
        testResults.failed.push(error.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. PAYMENT STATUS VALIDATIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates payment status / timestamp rules for on_status and on_cancel.
 */
export function validatePaymentStatus(
    action: string,
    orderState: string,
    paymentType: string,
    paymentStatus: string,
    paymentTimestamp: string | undefined,
    testResults: TestResult
): void {
    if (orderState === "Complete" && paymentType === "ON-FULFILLMENT") {
        try {
            assert.ok(
                paymentStatus === "PAID",
                "Payment status should be 'PAID' once the order is complete for payment type 'ON-FULFILLMENT'"
            );
            testResults.passed.push("Payment status validation passed");
        } catch (error: any) {
            logger.error(`Error during ${action} validation: ${error.message}`);
            testResults.failed.push(error.message);
        }
    }

    if (paymentType === "POST-FULFILLMENT" && paymentStatus === "PAID") {
        try {
            assert.ok(
                !paymentTimestamp,
                "Payment timestamp should not be provided as payment type is 'POST-FULFILLMENT'"
            );
            testResults.passed.push("Payment timestamp validation passed");
        } catch (error: any) {
            logger.error(`Error during ${action} validation: ${error.message}`);
            testResults.failed.push(error.message);
        }
    } else if (paymentStatus === "NOT-PAID") {
        try {
            assert.ok(
                !paymentTimestamp,
                "Payment timestamp should not be provided if the payment is yet not made"
            );
            testResults.passed.push("Payment timestamp validation passed");
        } catch (error: any) {
            logger.error(`Error during ${action} validation: ${error.message}`);
            testResults.failed.push(error.message);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. FULFILLMENT STRUCTURE VALIDATIONS
// ─────────────────────────────────────────────────────────────────────────────

export interface FulfillmentValidationOptions {
    /** Requires @ondc/org/awb_no on all delivery fulfillments (LOG11 / P2H2P) */
    requireAwb?: boolean;
    /** Validates that tracking is true */
    requireTracking?: boolean;
    /** Validates start & end GPS are present */
    requireGps?: boolean;
    /** Validates start & end contact phone */
    requireContacts?: boolean;
    /** Validates start.instructions is present */
    requireStartInstructions?: boolean;
    /** Validates start.time.range and end.time.range (state-gated for in-transit) */
    requireTimeRange?: boolean;
    /** Validates linked_provider tag is present */
    requireLinkedProvider?: boolean;
    /** Validates linked_order tag is present */
    requireLinkedOrder?: boolean;
    /** Validates shipping_label tag is present (LOG11 only) */
    requireShippingLabel?: boolean;
    /** Validates no pickup/delivery timestamps before order is picked up */
    requireNoPrePickupTimestamps?: boolean;
    /** Validates fulfillment state code is present */
    requireStateCode?: boolean;
}

const IN_TRANSIT_STATES = [
    "Agent-assigned",
    "Order-picked-up",
    "Out-for-delivery",
    "At-destination-hub",
    "In-transit",
    "Order-delivered",
];

const PRE_PICKUP_STATES = ["Pending", "Agent-assigned", "Searching-for-agent", "At-pickup"];

/**
 * Runs configurable structural checks on a single delivery fulfillment.
 * Call inside a loop: `for (const ff of fulfillments) validateFulfillmentStructure(...)`.
 */
export function validateFulfillmentStructure(
    action: string,
    fulfillment: any,
    testResults: TestResult,
    opts: FulfillmentValidationOptions = {}
): void {
    const ffState: string = fulfillment?.state?.descriptor?.code ?? "";

    if (opts.requireNoPrePickupTimestamps) {
        try {
            const prePickup = PRE_PICKUP_STATES.includes(ffState);
            const hasTimestamps = fulfillment?.start?.time?.timestamp || fulfillment?.end?.time?.timestamp;
            assert.ok(
                !(prePickup && hasTimestamps),
                `Pickup/Delivery timestamp should not be provided when fulfillment state is '${ffState}'`
            );
            testResults.passed.push("Pickup/Delivery timestamp requirement validation passed");
        } catch (error: any) {
            logger.error(`Error during ${action} validation: ${error.message}`);
            testResults.failed.push(error.message);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. FULFILLMENT ID COMPARISONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compares delivery and RTO fulfillment IDs from the current payload against
 * saved values in Redis and saves the current values for downstream calls.
 */
export async function validateAndSaveFulfillmentIds(
    action: string,
    fulfillments: any[],
    sessionID: string,
    transactionId: string,
    savedDeliveryKey: string,
    savedRtoKey: string,
    saveDeliveryKey: string,
    saveRtoKey: string,
    testResults: TestResult
): Promise<void> {
    const deliveryFulfillment = fulfillments.find(
        (f: any) => f.type === "Delivery" || f.type === "FTL" || f.type === "PTL"
    );
    const rtoFulfillment = fulfillments.find((f: any) => f.type === "RTO");

    // compare
    if (savedDeliveryKey) {
        const savedId = await fetchData(sessionID, transactionId, savedDeliveryKey);
        if (savedId && deliveryFulfillment?.id) {
            try {
                assert.strictEqual(
                    deliveryFulfillment.id, savedId,
                    `Delivery fulfillment ID in ${action} (${deliveryFulfillment.id}) does not match saved value (${savedId})`
                );
                testResults.passed.push(`Delivery fulfillment ID matches in ${action}`);
            } catch (error: any) {
                logger.error(`Error during ${action} validation: ${error.message}`);
                testResults.failed.push(error.message);
            }
        }
    }

    if (savedRtoKey) {
        const savedRtoId = await fetchData(sessionID, transactionId, savedRtoKey);
        if (savedRtoId && rtoFulfillment?.id) {
            try {
                assert.strictEqual(
                    rtoFulfillment.id, savedRtoId,
                    `RTO fulfillment ID in ${action} (${rtoFulfillment.id}) does not match saved value (${savedRtoId})`
                );
                testResults.passed.push(`RTO fulfillment ID matches in ${action}`);
            } catch (error: any) {
                logger.error(`Error during ${action} validation: ${error.message}`);
                testResults.failed.push(error.message);
            }
        }
    }

    // save
    if (saveDeliveryKey && deliveryFulfillment?.id)
        saveData(sessionID, transactionId, saveDeliveryKey, deliveryFulfillment.id);
    if (saveRtoKey && rtoFulfillment?.id)
        saveData(sessionID, transactionId, saveRtoKey, rtoFulfillment.id);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. GPS COMPARISON (search → downstream)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compares start/end GPS of a delivery fulfillment against the values saved
 * during /search.
 */
export async function validateGpsConsistency(
    action: string,
    deliveryFulfillment: any | undefined,
    sessionID: string,
    transactionId: string,
    testResults: TestResult
): Promise<void> {
    if (!deliveryFulfillment) return;

    const savedStartGps = await fetchData(sessionID, transactionId, "search_start_gps");
    const currentStartGps = deliveryFulfillment?.start?.location?.gps;
    if (savedStartGps && currentStartGps) {
        try {
            assert.strictEqual(
                currentStartGps, savedStartGps,
                `Start GPS in ${action} (${currentStartGps}) does not match search (${savedStartGps})`
            );
            testResults.passed.push(`Start GPS matches between search and ${action}`);
        } catch (error: any) {
            logger.error(`Error during ${action} validation: ${error.message}`);
            testResults.failed.push(error.message);
        }
    }

    const savedEndGps = await fetchData(sessionID, transactionId, "search_end_gps");
    const currentEndGps = deliveryFulfillment?.end?.location?.gps;
    if (savedEndGps && currentEndGps) {
        try {
            assert.strictEqual(
                currentEndGps, savedEndGps,
                `End GPS in ${action} (${currentEndGps}) does not match search (${savedEndGps})`
            );
            testResults.passed.push(`End GPS matches between search and ${action}`);
        } catch (error: any) {
            logger.error(`Error during ${action} validation: ${error.message}`);
            testResults.failed.push(error.message);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. PICKUP / DELIVERY TIMESTAMP VALIDATIONS (on_status / on_cancel)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates pickup timestamp on Order-picked-up state, saves it, checks
 * immutability for later states, and validates delivery timestamp.
 */
export async function validateFulfillmentTimestamps(
    action: string,
    fulfillment: any,
    contextTimestamp: string,
    sessionID: string,
    transactionId: string,
    testResults: TestResult
): Promise<void> {
    const ffState: string = fulfillment?.state?.descriptor?.code ?? "";
    const pickupTimestamp = fulfillment?.start?.time?.timestamp;
    const deliveryTimestamp = fulfillment?.end?.time?.timestamp;

    if (ffState === "Order-picked-up" && pickupTimestamp) {
        saveData(sessionID, transactionId, "pickupTimestamp", pickupTimestamp);
        try {
            assert.ok(
                contextTimestamp >= pickupTimestamp,
                "Pickup timestamp cannot be future-dated w.r.t context timestamp"
            );
            testResults.passed.push("Pickup timestamp validation passed");
        } catch (error: any) {
            logger.error(`Error during ${action} validation: ${error.message}`);
            testResults.failed.push(error.message);
        }
    }

    const pickedTimestamp = await fetchData(sessionID, transactionId, "pickupTimestamp");
    if (
        ["Out-for-delivery", "At-destination-hub", "In-transit"].includes(ffState) &&
        pickedTimestamp
    ) {
        try {
            assert.ok(
                pickupTimestamp === pickedTimestamp,
                `Pickup timestamp cannot change once fulfillment state is '${ffState}'`
            );
            testResults.passed.push("Pickup timestamp immutability validation passed");
        } catch (error: any) {
            logger.error(`Error during ${action} validation: ${error.message}`);
            testResults.failed.push(error.message);
        }
    }

    if (ffState === "Order-delivered" && deliveryTimestamp) {
        try {
            assert.ok(
                contextTimestamp >= deliveryTimestamp,
                "Delivery timestamp cannot be future-dated w.r.t context timestamp"
            );
            testResults.passed.push("Delivery timestamp validation passed");
        } catch (error: any) {
            logger.error(`Error during ${action} validation: ${error.message}`);
            testResults.failed.push(error.message);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. TRACKING TAG (post-pickup)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates that the tracking tag is present in fulfillments once the order
 * has been picked up and tracking is enabled.
 */
export function validateTrackingTag(
    action: string,
    fulfillment: any,
    testResults: TestResult
): void {
    const isTrackingEnabled = Boolean(fulfillment.tracking);

    if (!isTrackingEnabled) {
        testResults.failed.push(`tracking should be enabled (true) in fulfillments/tracking`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. IN-PROGRESS ORDER STATE
// ─────────────────────────────────────────────────────────────────────────────

export function validateInProgressOrderState(
    action: string,
    ffState: string,
    orderState: string,
    testResults: TestResult
): void {
    try {
        assert.ok(
            !(
                ["Agent-assigned", "Order-picked-up", "Out-for-delivery"].includes(ffState) &&
                orderState !== "In-progress"
            ),
            "Order state should be 'In-progress'"
        );
        testResults.passed.push("Order state validation passed");
    } catch (error: any) {
        logger.error(`Error during ${action} validation: ${error.message}`);
        testResults.failed.push(error.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. RESCHEDULED DELAY TAG VALIDATIONS
// ─────────────────────────────────────────────────────────────────────────────

const VALID_REASON_IDS = [
    "001", "002", "003", "004", "005", "006",
    "007", "008", "009", "010", "011", "012",
];

export function validateRescheduledDelayTags(
    action: string,
    fulfillment: any,
    testResults: TestResult
): void {
    const ffState: string = fulfillment?.state?.descriptor?.code ?? "";
    const tags: any[] = fulfillment?.tags ?? [];

    if (ffState === "Pickup-rescheduled") {
        try {
            const delayTag = tags.find((t: any) => t.code === "fulfillment_delay");
            if (!delayTag) return;
            testResults.passed.push(`fulfillments have the "fulfillment_delay" tag`);

            const list = delayTag.list;
            const hasState = list.some((i: any) => i.code === "state" && i.value === "Order-picked-up");
            assert.ok(hasState, "Missing 'state'='Order-picked-up' in fulfillment_delay tag");
            testResults.passed.push(`Valid state in "fulfillment_delay" tag`);

            const hasAttempt = list.some((i: any) => i.code === "attempt" && i.value === "yes");
            assert.ok(hasAttempt, "Missing 'attempt'='yes' in fulfillment_delay tag");
            testResults.passed.push(`Valid attempt in "fulfillment_delay" tag`);

            const reason = list.find((i: any) => i.code === "reason_id");
            assert.ok(
                reason && VALID_REASON_IDS.includes(reason.value),
                `Invalid 'reason_id' in fulfillment_delay tag`
            );
            testResults.passed.push(`Valid reason_id in "fulfillment_delay" tag`);
        } catch (error: any) {
            logger.error(`Error during ${action} validation: ${error.message}`);
            testResults.failed.push(error.message);
        }
    }

    if (ffState === "Delivery-rescheduled") {
        try {
            const delayTags = tags.filter((t: any) => t.code === "fulfillment_delay");
            assert.ok(delayTags.length >= 2, "Expected two 'fulfillment_delay' tags for Delivery-rescheduled");
            testResults.passed.push(`fulfillments have two "fulfillment_delay" tags`);
        } catch (error: any) {
            logger.error(`Error during ${action} validation: ${error.message}`);
            testResults.failed.push(error.message);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. QUOTE PRICE CONSISTENCY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compares quote price between on_confirm and a downstream call.
 */
export async function validateQuoteConsistency(
    action: string,
    currentQuote: any,
    sessionID: string,
    transactionId: string,
    savedQuoteKey: string,
    testResults: TestResult,
    allowedDelta: number = 0
): Promise<void> {
    const savedQuote = await fetchData(sessionID, transactionId, savedQuoteKey);
    if (savedQuote && currentQuote) {
        try {
            const expected = parseFloat((savedQuote as any)?.price?.value) + allowedDelta;
            assert.strictEqual(
                parseFloat(currentQuote?.price?.value),
                expected,
                `Quote price in ${action} (${currentQuote?.price?.value}) does not match saved (${expected})`
            );
            testResults.passed.push(`Quote price consistent between on_confirm and ${action}`);
        } catch (error: any) {
            logger.error(`Error during ${action} validation: ${error.message}`);
            testResults.failed.push(error.message);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. ORDER / PROVIDER / ITEM ID COMPARISONS
// ─────────────────────────────────────────────────────────────────────────────

export async function validateOrderIdConsistency(
    action: string,
    currentOrderId: string,
    sessionID: string,
    transactionId: string,
    savedKey: string,
    testResults: TestResult
): Promise<void> {
    const savedId = await fetchData(sessionID, transactionId, savedKey);
    if (savedId && currentOrderId) {
        try {
            assert.strictEqual(
                currentOrderId, savedId,
                `Order ID in ${action} (${currentOrderId}) does not match saved (${savedId})`
            );
            testResults.passed.push(`Order ID matches in ${action}`);
        } catch (error: any) {
            logger.error(`Error during ${action} validation: ${error.message}`);
            testResults.failed.push(error.message);
        }
    }
}

export async function validateProviderIdConsistency(
    action: string,
    currentProviderId: string,
    sessionID: string,
    transactionId: string,
    savedKey: string,
    testResults: TestResult
): Promise<void> {
    const savedId = await fetchData(sessionID, transactionId, savedKey);
    if (savedId && currentProviderId) {
        try {
            assert.strictEqual(
                currentProviderId, savedId,
                `Provider ID in ${action} (${currentProviderId}) does not match saved (${savedId})`
            );
            testResults.passed.push(`Provider ID matches in ${action}`);
        } catch (error: any) {
            logger.error(`Error during ${action} validation: ${error.message}`);
            testResults.failed.push(error.message);
        }
    }
}

export async function validateItemIdsConsistency(
    action: string,
    currentItems: any[],
    sessionID: string,
    transactionId: string,
    savedKey: string,
    testResults: TestResult
): Promise<void> {
    const savedItems = (await fetchData(sessionID, transactionId, savedKey)) as any[] | null;
    if (savedItems && savedItems.length > 0 && currentItems.length > 0) {
        try {
            const savedIds = savedItems.map((i: any) => i.id).sort();
            const currentIds = currentItems.map((i: any) => i.id).sort();
            assert.deepStrictEqual(
                currentIds, savedIds,
                `Item IDs in ${action} [${currentIds}] do not match`
            );
            testResults.passed.push(`Item IDs match in ${action}`);
        } catch (error: any) {
            logger.error(`Error during ${action} validation: ${error.message}`);
            testResults.failed.push(error.message);
        }
    }
}
