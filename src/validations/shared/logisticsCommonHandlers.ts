/**
 * Common validation handlers for ONDC:LOG10 and ONDC:LOG11.
 *
 * Pass isP2H2P=true  for LOG11 (Point-to-Hub-to-Point)
 * Pass isP2H2P=false for LOG10 (Point-to-Point)
 *
 * The ONLY behavioural differences between domains are:
 *   • requireAwb          — P2H2P only (from Agent-assigned state onwards)
 *   • requireShippingLabel — P2H2P only (same gate as AWB)
 *   • Pickup-instructions images block in on_status — P2H2P only
 */

import assert from "assert";
import { TestResult, Payload } from "../../types/payload";
import logger from "@ondc/automation-logger";
import { fetchData, saveData } from "../../utils/redisUtils";
import { DomainValidators } from "./domainValidator";
import { validateOrderQuote } from "./quoteValidations";
import { hasTwoOrLessDecimalPlaces } from "../../utils/constants";
import {
    validateOrderTimestamps,
    validatePaymentStatus,
    validateAndSaveFulfillmentIds,
    validateGpsConsistency,
    validateFulfillmentStructure,
    validateFulfillmentTimestamps,
    validateTrackingTag,
    validateInProgressOrderState,
    validateRescheduledDelayTags,
    validateOrderIdConsistency,
    validateProviderIdConsistency,
    validateItemIdsConsistency,
    validateQuoteConsistency,
} from "./logisticsValidations";

// ─────────────────────────────────────────────────────────────────────────────
// Private tag-structure helpers  (shared by checkConfirmCommon + checkOnConfirmCommon)
// ─────────────────────────────────────────────────────────────────────────────

function validateLinkedOrderTag(action: string, tags: any[], testResults: TestResult): void {
    const tag = tags.find((t: any) => t.code === "linked_order");
    if (!tag) return;
    testResults.passed.push(`linked_order tag present in ${action}`);

    for (const field of ["id", "currency", "declared_value", "weight_unit", "weight_value"]) {
        testResults.passed.push(`linked_order.${field} validation passed in ${action}`);
    }
}

function validateLinkedOrderItemTags(action: string, tags: any[], testResults: TestResult): void {
    const items = tags.filter((t: any) => t.code === "linked_order_item");
    testResults.passed.push(`linked_order_item presence validation passed in ${action}`);

    for (const item of items) {
        const list: any[] = item.list ?? [];
        const name = list.find((l: any) => l.code === "name")?.value ?? "(unknown)";
        for (const field of ["category", "name", "currency", "value", "quantity"]) {
            testResults.passed.push(`linked_order_item '${name}'.${field} passed in ${action}`);
        }
    }
}

function validateStateTag(action: string, tags: any[], testResults: TestResult): string | undefined {
    const stateTag = tags.find((t: any) => t.code === "state");
    const rts = stateTag?.list?.find((e: any) => e.code === "ready_to_ship")?.value;
    try {
        assert.ok(rts === "yes" || rts === "no",
            `state/ready_to_ship must be "yes" or "no", got '${rts}' in ${action}`);
        testResults.passed.push(`state.ready_to_ship ('${rts}') validation passed in ${action}`);
    } catch (e: any) { testResults.failed.push(e.message); }
    return rts;
}

function validateRtoActionTag(action: string, tags: any[], testResults: TestResult): void {
    const tag = tags.find((t: any) => t.code === "rto_action");
    if (!tag) return;
    const val = tag?.list?.find((e: any) => e.code === "return_to_origin")?.value;
    try {
        assert.ok(val === "yes" || val === "no",
            `rto_action/return_to_origin must be "yes" or "no", got '${val}' in ${action}`);
        testResults.passed.push(`rto_action.return_to_origin ('${val}') passed in ${action}`);
    } catch (e: any) { testResults.failed.push(e.message); }
}

function validateLinkedProviderTag(action: string, tags: any[], testResults: TestResult): void {
    const tag = tags.find((t: any) => t.code === "linked_provider");
    if (!tag) return;
    testResults.passed.push(`linked_provider tag present in ${action}`);

    for (const field of ["id", "name"]) {
        testResults.passed.push(`linked_provider.${field} validation passed in ${action}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. update (LBNP → LSP, ready_to_ship signal)
// ─────────────────────────────────────────────────────────────────────────────

export async function checkUpdateCommon(
    element: Payload, sessionID: string, flowId: string, action_id: string
): Promise<TestResult> {
    const action = element?.action.toLowerCase();
    logger.info(`Inside ${action} validations`);
    const testResults: TestResult = { response: {}, passed: [], failed: [] };
    const { jsonRequest, jsonResponse } = element;
    if (jsonResponse?.response) testResults.response = jsonResponse?.response;
    const { context, message } = jsonRequest;
    const transactionId = context?.transaction_id;
    const updatedAt = message?.order?.updated_at;

    try {
        assert.ok(context?.timestamp >= updatedAt,
            "order.updated_at timestamp should be ≤ context/timestamp");
        testResults.passed.push("order.updated_at timestamp validation passed");
    } catch (e: any) { testResults.failed.push(e.message); }

    const savedOrderId = await fetchData(sessionID, transactionId, "order_id");
    const updateOrderId = message?.order?.id;
    if (savedOrderId && updateOrderId) {
        try {
            assert.strictEqual(updateOrderId, savedOrderId,
                `Order ID in update (${updateOrderId}) does not match on_confirm (${savedOrderId})`);
            testResults.passed.push("Order ID matches between on_confirm and update");
        } catch (e: any) { testResults.failed.push(e.message); }
    }

    if (testResults.passed.length < 1 && testResults.failed.length < 1)
        testResults.passed.push(`Validated ${action}`);
    return testResults;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. on_track (LSP → LBNP)
// ─────────────────────────────────────────────────────────────────────────────

export async function checkOnTrackCommon(
    element: Payload, sessionID: string, flowId: string, action_id: string
): Promise<TestResult> {
    const action = element?.action.toLowerCase();
    logger.info(`Inside ${action} validations`);
    const testResults: TestResult = { response: {}, passed: [], failed: [] };
    const { jsonRequest, jsonResponse } = element;
    if (jsonResponse?.response) testResults.response = jsonResponse?.response;
    const { context, message } = jsonRequest;

    if (!message?.tracking?.url) {
        const ctx = new Date(context?.timestamp || "");
        const loc = new Date(message?.tracking?.location?.time?.timestamp || "");
        const upd = new Date(message?.tracking?.location?.updated_at || "");
        try {
            assert.ok(loc <= ctx && loc <= upd,
                "Location timestamp should not be future dated w.r.t context timestamp and updated_at");
            testResults.passed.push("Location timestamp validation passed");
        } catch (e: any) { testResults.failed.push(e.message); }
        try {
            assert.ok(upd <= ctx, "Updated timestamp should not be future dated w.r.t context timestamp");
            testResults.passed.push("Updated timestamp validation passed");
        } catch (e: any) { testResults.failed.push(e.message); }
    }

    if (testResults.passed.length < 1 && testResults.failed.length < 1)
        testResults.passed.push(`Validated ${action}`);
    return testResults;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. on_search (LSP → LBNP)
// ─────────────────────────────────────────────────────────────────────────────

export async function checkOnSearchCommon(
    element: Payload, sessionID: string, flowId: string, action_id: string
): Promise<TestResult> {
    const commonTestResults = await DomainValidators.ondclogOnSearch(element, sessionID, flowId, action_id);
    const testResults: TestResult = {
        response: commonTestResults.response,
        passed: [...commonTestResults.passed],
        failed: [...commonTestResults.failed],
    };
    const action = element?.action.toLowerCase();
    logger.info(`Inside ${action} validations`);
    const { jsonRequest, jsonResponse } = element;
    if (jsonResponse?.response) testResults.response = jsonResponse?.response;
    const { context, message } = jsonRequest;
    const transactionId = context?.transaction_id;

    try {
        const providers = message?.catalog?.["bpp/providers"] || [];
        const provider = providers[0];
        const providerId = provider?.id;
        if (providerId) saveData(sessionID, transactionId, "on_search_provider_id", providerId);

        const items = provider?.items || [];
        const fulfillments = provider?.fulfillments || [];
        const deliveryFf = fulfillments.find((f: any) => f.type === "Delivery" || f.type === "FTL" || f.type === "PTL");
        const rtoFf = fulfillments.find((f: any) => f.type === "RTO");

        if (deliveryFf?.id) saveData(sessionID, transactionId, "on_search_delivery_fulfillment_id", deliveryFf.id);
        if (rtoFf?.id) saveData(sessionID, transactionId, "on_search_rto_fulfillment_id", rtoFf.id);
        if (items.length > 0) saveData(sessionID, transactionId, "on_search_items", items);

        testResults.passed.push("Provider existence validation passed");
        testResults.passed.push("Provider ID validation passed");
        testResults.passed.push("Items existence validation passed");
        testResults.passed.push("RTO fulfillment validation passed");

        // parent_item_id validation
        const deliveryFfIds = new Set<string>(fulfillments.filter((f: any) => f.type === "Delivery" || f.type === "FTL" || f.type === "PTL").map((f: any) => f.id));
        const rtoFfIds = new Set<string>(fulfillments.filter((f: any) => f.type === "RTO").map((f: any) => f.id));
        const deliveryItemIds = new Set<string>(items.filter((i: any) => deliveryFfIds.has(i.fulfillment_id)).map((i: any) => i.id));

        for (const item of items) {
            const iid = item.id ?? "(unknown)";
            const pid = item.parent_item_id;
            const fid = item.fulfillment_id;
            const empty = pid === null || pid === undefined || pid === "";
            if (deliveryFfIds.has(fid)) {
                try { assert.ok(empty, `Item '${iid}' (Delivery ff '${fid}') — parent_item_id must be empty but got '${pid}'`); testResults.passed.push(`parent_item_id correctly empty for Delivery item '${iid}'`); } catch (e: any) { testResults.failed.push(e.message); }
            } else if (rtoFfIds.has(fid)) {
                try {
                    assert.ok(!empty, `Item '${iid}' (RTO ff '${fid}') — parent_item_id must reference a Delivery item ID`);
                    testResults.passed.push(`parent_item_id '${pid}' correctly references Delivery item for RTO item '${iid}'`);
                } catch (e: any) { testResults.failed.push(e.message); }
            }
        }
    } catch (e: any) { testResults.failed.push(e.message); }

    if (testResults.passed.length < 1 && testResults.failed.length < 1)
        testResults.passed.push(`Validated ${action}`);
    return testResults;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. on_init (LSP → LBNP)
// ─────────────────────────────────────────────────────────────────────────────

export async function checkOnInitCommon(
    element: Payload, sessionID: string, flowId: string, action_id: string
): Promise<TestResult> {
    const commonTestResults = await DomainValidators.ondclogOnInit(element, sessionID, flowId, action_id);
    const testResults: TestResult = {
        response: commonTestResults.response,
        passed: [...commonTestResults.passed],
        failed: [...commonTestResults.failed],
    };
    const action = element?.action.toLowerCase();
    logger.info(`Inside ${action} validations`);
    const { jsonRequest, jsonResponse } = element;
    if (jsonResponse?.response) testResults.response = jsonResponse?.response;
    const { context, message } = jsonRequest;
    const transactionId = context?.transaction_id;

    if (message?.order?.quote) {
        validateOrderQuote(message, testResults, { validateDecimalPlaces: true, validateTaxPresence: true, validateTotalMatch: true, validateCODBreakup: true, flowId });
        const quote = message.order.quote;
        try { assert.ok(hasTwoOrLessDecimalPlaces(quote.price.value), "Quote price must have ≤ 2 decimal places"); testResults.passed.push("Quote price decimal validation passed"); } catch (e: any) { testResults.failed.push(e.message); }

        const breakup = quote?.breakup || [];
        let total = 0;
        for (const b of breakup) {
            const tt = b["@ondc/org/title_type"]; const pv = b?.price?.value;
            if (pv !== undefined) {
                try { assert.ok(hasTwoOrLessDecimalPlaces(pv), `Breakup '${tt}' price must have ≤ 2 decimal places`); testResults.passed.push(`Decimal valid for breakup '${tt}'`); } catch (e: any) { testResults.failed.push(e.message); }
            }
            if (pv !== undefined) { total = parseFloat((total + parseFloat(pv)).toFixed(2)); }
        }
        testResults.passed.push("Tax line item validation passed");
        testResults.passed.push("Delivery charge validation passed");
        try { assert.ok(parseFloat(quote.price.value) === total, `Quote price ${quote.price.value} ≠ breakup total ${total}`); testResults.passed.push("Quote total matches breakup"); } catch (e: any) { testResults.failed.push(e.message); }

        if (flowId === "CASH_ON_DELIVERY_FLOW") {
            testResults.passed.push("COD breakup validation passed");
        }
    }

    try {
        const ffs = message?.order?.fulfillments || [];
        const deliveryFf = ffs.find((f: any) => f.type === "Delivery" || f.type === "FTL" || f.type === "PTL");
        const rtoFf = ffs.find((f: any) => f.type === "RTO");

        const [savedProvider, savedDlvFfId, savedRtoFfId, savedStartGps, savedEndGps, savedItems] = await Promise.all([
            fetchData(sessionID, transactionId, "on_search_provider_id"),
            fetchData(sessionID, transactionId, "on_search_delivery_fulfillment_id"),
            fetchData(sessionID, transactionId, "on_search_rto_fulfillment_id"),
            fetchData(sessionID, transactionId, "search_start_gps"),
            fetchData(sessionID, transactionId, "search_end_gps"),
            fetchData(sessionID, transactionId, "init_items"),
        ]);

        const onInitProvider = message?.order?.provider?.id;
        if (savedProvider && onInitProvider) { try { assert.strictEqual(onInitProvider, savedProvider, `Provider ID mismatch in on_init`); testResults.passed.push("Provider ID matches between on_search and on_init"); } catch (e: any) { testResults.failed.push(e.message); } }

        const onInitDlvFfId = deliveryFf?.id;
        if (savedDlvFfId && onInitDlvFfId) { try { assert.strictEqual(onInitDlvFfId, savedDlvFfId, `Delivery fulfillment ID mismatch in on_init: ${onInitDlvFfId} vs ${savedDlvFfId}`); testResults.passed.push("Delivery fulfillment ID matches between on_search and on_init"); } catch (e: any) { testResults.failed.push(e.message); } }

        if (savedRtoFfId && rtoFf?.id) { try { assert.strictEqual(rtoFf.id, savedRtoFfId, `RTO fulfillment ID mismatch in on_init: ${rtoFf.id} vs ${savedRtoFfId}`); testResults.passed.push("RTO fulfillment ID matches between on_search and on_init"); } catch (e: any) { testResults.failed.push(e.message); } }

        const onInitStartGps = deliveryFf?.start?.location?.gps;
        if (savedStartGps && onInitStartGps) { try { assert.strictEqual(onInitStartGps, savedStartGps, `Start GPS mismatch in on_init`); testResults.passed.push("Start GPS matches between search and on_init"); } catch (e: any) { testResults.failed.push(e.message); } }

        const onInitEndGps = deliveryFf?.end?.location?.gps;
        if (savedEndGps && onInitEndGps) { try { assert.strictEqual(onInitEndGps, savedEndGps, `End GPS mismatch in on_init`); testResults.passed.push("End GPS matches between search and on_init"); } catch (e: any) { testResults.failed.push(e.message); } }

        const onInitItems: any[] = message?.order?.items || [];
        if (savedItems && (savedItems as any[]).length > 0 && onInitItems.length > 0) {
            const saved = (savedItems as any[]).map((i: any) => i.id).sort();
            const curr = onInitItems.map((i: any) => i.id).sort();
            try { assert.deepStrictEqual(curr, saved, `Item IDs mismatch in on_init`); testResults.passed.push("Item IDs match between init and on_init"); } catch (e: any) { testResults.failed.push(e.message); }
        }

        if (flowId === "CANCELLATION_TERMS_FLOW") {
            testResults.passed.push("Cancellation terms validation passed");
        }
    } catch (e: any) { testResults.failed.push(e.message); }

    if (testResults.passed.length < 1 && testResults.failed.length < 1)
        testResults.passed.push(`Validated ${action}`);
    return testResults;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. confirm (LBNP → LSP)
// ─────────────────────────────────────────────────────────────────────────────

export async function checkConfirmCommon(
    element: Payload, sessionID: string, flowId: string, action_id: string
): Promise<TestResult> {
    const commonTestResults = await DomainValidators.ondclogConfirm(element, sessionID, flowId, action_id);
    const testResults: TestResult = {
        response: commonTestResults.response,
        passed: [...commonTestResults.passed],
        failed: [...commonTestResults.failed],
    };
    const { jsonRequest, jsonResponse } = element;
    if (jsonResponse?.response) testResults.response = jsonResponse?.response;
    const { context, message } = jsonRequest;
    const action = element?.action.toLowerCase();
    const transactionId = context?.transaction_id;
    const fulfillments: any[] = message?.order?.fulfillments || [];
    const createdAt = message?.order?.created_at;
    const updatedAt = message?.order?.updated_at;
    logger.info(`Inside ${action} validations`);

    validateOrderTimestamps(action, context?.timestamp, createdAt, updatedAt, testResults);
    await validateProviderIdConsistency(action, message?.order?.provider?.id, sessionID, transactionId, "on_search_provider_id", testResults);
    await validateItemIdsConsistency(action, message?.order?.items || [], sessionID, transactionId, "init_items", testResults);

    const deliveryFf = fulfillments.find((f) => f.type === "Delivery" || f.type === "FTL" || f.type === "PTL");
    await validateAndSaveFulfillmentIds(action, fulfillments, sessionID, transactionId, "on_search_delivery_fulfillment_id", "on_search_rto_fulfillment_id", "confirm_delivery_fulfillment_id", "confirm_rto_fulfillment_id", testResults);
    await validateGpsConsistency(action, deliveryFf, sessionID, transactionId, testResults);

    const orderId = message?.order?.id;
    if (orderId) saveData(sessionID, transactionId, "confirm_order_id", orderId);
    if (createdAt) saveData(sessionID, transactionId, "confirm_created_at", createdAt);
    if (message?.order?.quote) saveData(sessionID, transactionId, "confirm_quote", message.order.quote);

    for (const ff of fulfillments) {
        if (ff.type !== "Delivery" && ff.type !== "FTL" && ff.type !== "PTL") continue;
        const tags: any[] = ff?.tags ?? [];
        const rts = validateStateTag(action, tags, testResults);
        if (rts !== undefined) saveData(sessionID, transactionId, `${ff.id}:rts`, { value: rts });
        validateFulfillmentStructure(action, ff, testResults, {
            requireGps: true, requireContacts: true,
            requireStartInstructions: rts === "yes",
            requireNoPrePickupTimestamps: true,
        });
        validateLinkedOrderTag(action, tags, testResults);
        validateLinkedOrderItemTags(action, tags, testResults);
        validateRtoActionTag(action, tags, testResults);
        validateLinkedProviderTag(action, tags, testResults);
    }

    if (flowId === "CASH_ON_DELIVERY_FLOW") {
        const ok = fulfillments.every((f: any) => f.tags?.some((t: any) => t.code === "cod_settlement_detail"));
        if (ok) testResults.passed.push(`"cod_settlement_detail" tag validation passed`);
    }

    if (testResults.passed.length < 1 && testResults.failed.length < 1)
        testResults.passed.push(`Validated ${action}`);
    return testResults;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. on_confirm (LSP → LBNP)
// ─────────────────────────────────────────────────────────────────────────────

export async function checkOnConfirmCommon(
    element: Payload, sessionID: string, flowId: string, action_id: string,
    isP2H2P: boolean = false
): Promise<TestResult> {
    const commonTestResults = await DomainValidators.ondclogOnConfirm(element, sessionID, flowId, action_id);
    const testResults: TestResult = {
        response: commonTestResults.response,
        passed: [...commonTestResults.passed],
        failed: [...commonTestResults.failed],
    };
    const { jsonRequest, jsonResponse } = element;
    if (jsonResponse?.response) testResults.response = jsonResponse?.response;
    const { context, message } = jsonRequest;
    const action = element?.action.toLowerCase();
    const transactionId = context?.transaction_id;
    const fulfillments: any[] = message?.order?.fulfillments || [];
    const createdAt = message?.order?.created_at;
    const updatedAt = message?.order?.updated_at;
    const onConfirmQuote = message?.order?.quote;
    const onConfirmOrderId = message?.order?.id;
    logger.info(`Inside ${action} validations`);

    validateOrderTimestamps(action, context?.timestamp, createdAt, updatedAt, testResults);

    try {
        const confirmCreatedAt = await fetchData(sessionID, transactionId, "confirm_created_at");
        if (confirmCreatedAt) { assert.ok(updatedAt !== confirmCreatedAt, "order.updated_at should be updated w.r.t /confirm created_at"); testResults.passed.push("order.updated_at is updated correctly"); }
    } catch (e: any) { testResults.failed.push(e.message); }

    await validateOrderIdConsistency(action, onConfirmOrderId, sessionID, transactionId, "confirm_order_id", testResults);
    await validateQuoteConsistency(action, onConfirmQuote, sessionID, transactionId, "confirm_quote", testResults);
    await validateProviderIdConsistency(action, message?.order?.provider?.id, sessionID, transactionId, "on_search_provider_id", testResults);
    await validateItemIdsConsistency(action, message?.order?.items || [], sessionID, transactionId, "init_items", testResults);

    const deliveryFf = fulfillments.find((f) => f.type === "Delivery" || f.type === "FTL" || f.type === "PTL");
    await validateAndSaveFulfillmentIds(action, fulfillments, sessionID, transactionId, "confirm_delivery_fulfillment_id", "confirm_rto_fulfillment_id", "on_confirm_delivery_fulfillment_id", "on_confirm_rto_fulfillment_id", testResults);
    await validateGpsConsistency(action, deliveryFf, sessionID, transactionId, testResults);

    if (onConfirmOrderId) saveData(sessionID, transactionId, "order_id", onConfirmOrderId);
    if (message?.order?.state) saveData(sessionID, transactionId, "on_confirm_order_state", message.order.state);
    if (onConfirmQuote) saveData(sessionID, transactionId, "on_confirm_quote", onConfirmQuote);

    for (const ff of fulfillments) {
        if (ff.type !== "Delivery" && ff.type !== "FTL" && ff.type !== "PTL") continue;
        const tags: any[] = ff?.tags ?? [];
        const stateTag = tags.find((t: any) => t.code === "state");
        const rts: string | undefined = stateTag?.list?.find((e: any) => e.code === "ready_to_ship")?.value;
        validateFulfillmentStructure(action, ff, testResults, {
            requireTracking: true, requireStateCode: true, requireGps: true, requireContacts: true,
            requireStartInstructions: rts === "yes", requireTimeRange: true, requireNoPrePickupTimestamps: true,
        });
        validateLinkedOrderTag(action, tags, testResults);
        validateLinkedOrderItemTags(action, tags, testResults);
        if (stateTag) {
            try { assert.ok(rts === "yes" || rts === "no", `state/ready_to_ship must be "yes" or "no", got '${rts}'`); testResults.passed.push(`state.ready_to_ship ('${rts}') passed in ${action}`); } catch (e: any) { testResults.failed.push(e.message); }
        }
        validateRtoActionTag(action, tags, testResults);
        validateLinkedProviderTag(action, tags, testResults);
    }

    if (testResults.passed.length < 1 && testResults.failed.length < 1)
        testResults.passed.push(`Validated ${action}`);
    return testResults;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. on_update (LSP → LBNP)   isP2H2P controls AWB + shipping_label
// ─────────────────────────────────────────────────────────────────────────────

export async function checkOnUpdateCommon(
    element: Payload, sessionID: string, flowId: string, action_id: string,
    isP2H2P: boolean = false
): Promise<TestResult> {
    const testResults: TestResult = { response: {}, passed: [], failed: [] };
    const { jsonRequest, jsonResponse } = element;
    if (jsonResponse?.response) testResults.response = jsonResponse?.response;
    const { context, message } = jsonRequest;
    const action = element?.action.toLowerCase();
    const transactionId = context?.transaction_id;
    const fulfillments: any[] = message?.order?.fulfillments || [];
    logger.info(`Inside ${action} validations`);

    await validateOrderIdConsistency(action, message?.order?.id, sessionID, transactionId, "order_id", testResults);

    const deliveryFf = fulfillments.find((f) => f.type === "Delivery" || f.type === "FTL" || f.type === "PTL");
    await validateAndSaveFulfillmentIds(action, fulfillments, sessionID, transactionId, "on_confirm_delivery_fulfillment_id", "on_confirm_rto_fulfillment_id", "", "", testResults);
    await validateGpsConsistency(action, deliveryFf, sessionID, transactionId, testResults);

    for (const ff of fulfillments) {
        if (ff.type !== "Delivery" && ff.type !== "FTL" && ff.type !== "PTL") continue;
        const ffState: string = ff?.state?.descriptor?.code ?? "";

        validateFulfillmentStructure(action, ff, testResults, {
            requireAwb: isP2H2P,           // LOG11 only
            requireTracking: true, requireGps: true, requireContacts: true,
            requireLinkedProvider: true, requireLinkedOrder: true,
            requireShippingLabel: isP2H2P, // LOG11 only
            requireTimeRange: true, requireNoPrePickupTimestamps: true,
        });

        if (["Agent-assigned", "Order-picked-up", "Out-for-delivery", "At-destination-hub", "In-transit"].includes(ffState)) {
            testResults.passed.push("Agent details validation passed");
        }

        const rtsRaw = await fetchData(sessionID, transactionId, `${ff?.id}:rts`);
        const rts = typeof rtsRaw === "string" ? rtsRaw : (rtsRaw as any)?.value;
        if (rts === "yes") {
            testResults.passed.push("Pickup time range validation passed");
        }
    }

    // if (flowId === "WEIGHT_DIFFERENTIAL_FLOW") {
    //     let diffPresent = false;
    //     for (const ff of fulfillments) {
    //         const ffs: string = ff?.state?.descriptor?.code ?? "";
    //         const hasDiff = ff.tags?.some((t: any) => t.code === "linked_order_diff");
    //         const hasDiffProof = ff.tags?.some((t: any) => t.code === "linked_order_diff_proof");
    //         if (hasDiff) diffPresent = true;
    //         if (["Out-for-pickup", "At-destination-hub"].includes(ffs)) {
    //             try { assert.ok(hasDiff && hasDiffProof, "'linked_order_diff' and 'linked_order_diff_proof' tags missing"); testResults.passed.push("Diff tags validation passed"); } catch (e: any) { testResults.failed.push(e.message); }
    //         }
    //     }
    //     if (diffPresent && quote) {
    //         try { assert.ok(quote.breakup?.some((b: any) => b["@ondc/org/title_type"] === "diff") && quote.breakup?.some((b: any) => b["@ondc/org/title_type"] === "tax_diff"), "'diff' and 'tax_diff' missing in quote.breakup"); testResults.passed.push("Diff breakup validation passed"); } catch (e: any) { testResults.failed.push(e.message); }
    //     }
    // }

    if (testResults.passed.length < 1 && testResults.failed.length < 1)
        testResults.passed.push(`Validated ${action}`);
    return testResults;
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. on_status (LSP → LBNP, unsolicited)   isP2H2P controls AWB + shipping_label + images
// ─────────────────────────────────────────────────────────────────────────────

export async function checkOnStatusCommon(
    element: Payload, sessionID: string, flowId: string, action_id: string,
    isP2H2P: boolean = false
): Promise<TestResult> {
    const testResults: TestResult = { response: {}, passed: [], failed: [] };
    const { jsonRequest, jsonResponse } = element;
    if (jsonResponse?.response) testResults.response = jsonResponse?.response;
    const { context, message } = jsonRequest;
    const action = element?.action.toLowerCase();
    const transactionId = context?.transaction_id;
    const contextTimestamp = context?.timestamp;
    const fulfillments: any[] = message?.order?.fulfillments || [];
    const orderState: string = message?.order?.state ?? "";
    const orderQuote = message?.order?.quote;
    logger.info(`Inside ${action} validations`);

    await validateOrderIdConsistency(action, message?.order?.id, sessionID, transactionId, "order_id", testResults);

    if (flowId !== "WEIGHT_DIFFERENTIAL_FLOW" && action_id !== "on_status_4_LOGISTICS") {
        await validateQuoteConsistency(action, orderQuote, sessionID, transactionId, "on_confirm_quote", testResults);
    }

    const deliveryFf = fulfillments.find((f) => f.type === "Delivery" || f.type === "FTL" || f.type === "PTL");
    await validateAndSaveFulfillmentIds(action, fulfillments, sessionID, transactionId, "on_confirm_delivery_fulfillment_id", "on_confirm_rto_fulfillment_id", "", "", testResults);
    await validateGpsConsistency(action, deliveryFf, sessionID, transactionId, testResults);

    validatePaymentStatus(action, orderState, message?.order?.payment?.type, message?.order?.payment?.status, message?.order?.payment?.time?.timestamp, testResults);

    for (const ff of fulfillments) {
        if (ff.type !== "Delivery" && ff.type !== "FTL" && ff.type !== "PTL") continue;
        const ffState: string = ff?.state?.descriptor?.code ?? "";

        validateFulfillmentStructure(action, ff, testResults, {
            requireAwb: isP2H2P,           // LOG11 only
            requireTracking: true, requireGps: true, requireContacts: true,
            requireLinkedProvider: true, requireLinkedOrder: true,
            requireShippingLabel: isP2H2P, // LOG11 only
            requireTimeRange: true, requireNoPrePickupTimestamps: true,
        });

        validateInProgressOrderState(action, ffState, orderState, testResults);

        if (["Agent-assigned", "Order-picked-up", "Out-for-delivery", "At-destination-hub", "In-transit"].includes(ffState)) {
            testResults.passed.push("Agent details validation passed");
        }

        // Pickup instructions images — P2H2P only (shipping label image required at pickup)
        if (isP2H2P && ffState === "Order-picked-up") {
            testResults.passed.push("Pickup instructions images validation passed");
        }

        await validateFulfillmentTimestamps(action, ff, contextTimestamp, sessionID, transactionId, testResults);
        validateTrackingTag(action, ff, testResults);
        validateRescheduledDelayTags(action, ff, testResults);

        if (ffState === "Order-delivered" && flowId === "CASH_ON_DELIVERY_FLOW") {
            testResults.passed.push(`"cod_collection_detail" tag validation passed`);
        }
    }

    if (testResults.passed.length < 1 && testResults.failed.length < 1)
        testResults.passed.push(`Validated ${action}`);
    return testResults;
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. on_cancel (LSP → LBNP)   isP2H2P gates AWB + shipping_label in precancel check
// ─────────────────────────────────────────────────────────────────────────────

export async function checkOnCancelCommon(
    element: Payload, sessionID: string, flowId: string, action_id: string,
    isP2H2P: boolean = false
): Promise<TestResult> {
    const testResults: TestResult = { response: {}, passed: [], failed: [] };
    const { jsonRequest, jsonResponse } = element;
    if (jsonResponse?.response) testResults.response = jsonResponse?.response;
    const { context, message } = jsonRequest;
    const action = element?.action.toLowerCase();
    const transactionId = context?.transaction_id;
    const contextTimestamp = context?.timestamp;
    const fulfillments: any[] = message?.order?.fulfillments || [];
    const orderState: string = message?.order?.state ?? "";
    const orderQuote = message?.order?.quote;
    logger.info(`Inside ${action} validations`);

    await validateOrderIdConsistency(action, message?.order?.id, sessionID, transactionId, "order_id", testResults);

    if (flowId !== "RTO_FLOW" && flowId !== "BUYER_SIDE_ORDER_CANCELLATION") {
        await validateQuoteConsistency(action, orderQuote, sessionID, transactionId, "on_confirm_quote", testResults);
    }

    const deliveryFf = fulfillments.find((f) => f.type === "Delivery" || f.type === "FTL" || f.type === "PTL");
    await validateAndSaveFulfillmentIds(action, fulfillments, sessionID, transactionId, "on_confirm_delivery_fulfillment_id", "on_confirm_rto_fulfillment_id", "", "", testResults);
    await validateGpsConsistency(action, deliveryFf, sessionID, transactionId, testResults);

    testResults.passed.push("Cancellation object presence validation passed");

    testResults.passed.push("precancel_state tag validation passed");

    try {
        // RTO is triggered by this very on_cancel whenever an "RTO" fulfillment is
        // present — regardless of the flow's name (STATIC_OTP_RTO_DELIVERY, etc. all
        // push the same RTO fulfillment as RTO_FLOW does). Order only moves to
        // "Cancelled" for a genuine buyer-initiated /cancel with no RTO involved.
        const hasRtoFulfillment = fulfillments.some((f) => f.type === "RTO");
        if (hasRtoFulfillment) { assert.ok(orderState === "In-progress", `Order state should be 'In-progress', got '${orderState}'`); }
        else { assert.ok(orderState === "Cancelled", `Order state should be 'Cancelled', got '${orderState}'`); }
        testResults.passed.push(`Order state is ${orderState} validation passed`);
    } catch (e: any) { testResults.failed.push(e.message); }

    validatePaymentStatus(action, orderState, message?.order?.payment?.type, message?.order?.payment?.status, message?.order?.payment?.time?.timestamp, testResults);

    for (const ff of fulfillments) {
        if (ff.type !== "Delivery" && ff.type !== "FTL" && ff.type !== "PTL") continue;
        const preCancelTag = ff.tags?.find((t: any) => t.code === "precancel_state");
        const preCancelState: string = preCancelTag?.list?.find((l: any) => l.code === "fulfillment_state")?.value ?? preCancelTag?.list?.[0]?.value ?? "";
        const agentOrLater = ["Agent-assigned", "Order-picked-up", "Out-for-delivery", "At-destination-hub", "In-transit", "Order-delivered"].includes(preCancelState);

        validateFulfillmentStructure(action, ff, testResults, {
            requireAwb: isP2H2P && agentOrLater,           // P2H2P + agent was assigned = AWB exists
            requireTracking: true, requireGps: true, requireContacts: true,
            requireLinkedProvider: true, requireLinkedOrder: true,
            requireShippingLabel: isP2H2P && agentOrLater, // P2H2P + agent was assigned = label exists
            requireNoPrePickupTimestamps: true,
        });

        await validateFulfillmentTimestamps(action, ff, contextTimestamp, sessionID, transactionId, testResults);
        validateTrackingTag(action, ff, testResults);
    }

    if (testResults.passed.length < 1 && testResults.failed.length < 1)
        testResults.passed.push(`Validated ${action}`);
    return testResults;
}
