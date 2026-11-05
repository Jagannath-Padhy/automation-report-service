import { TestResult, Payload } from "../../../types/payload";
import { DomainValidators } from "../../shared/domainValidator";
import { saveFromElement } from "../../../utils/specLoader";
import { getActionData } from "../../../services/actionDataService";
import { fetchData, saveData } from "../../../utils/redisUtils";
import {
    validateMfContextConsistency,
    validateMfMessageIdMatch,
    validateMfQuoteConsistency,
    validateMfProviderConsistency,
} from "../../shared/mutualFundsL2Validations";

export default async function on_select(
    element: Payload,
    sessionID: string,
    flowId: string,
    actionId: string,
    usecaseId?: string
): Promise<TestResult> {
    const result = await DomainValidators.fis14OnSelect(element, sessionID, flowId, actionId, usecaseId);

    try {
        const ctx = element?.jsonRequest?.context;
        const message = element?.jsonRequest?.message;
        const txnId = ctx?.transaction_id as string | undefined;

        if (txnId) {
            const selectData = await getActionData(sessionID, flowId, txnId, "select");
            // MF-CTX-001: context match
            validateMfContextConsistency(ctx, selectData, result, flowId, "on_select", "select");
            // MF-CTX-002: message_id match
            validateMfMessageIdMatch(ctx, selectData, result, flowId, "on_select", "select");
            // MF-ORD-002: provider consistency
            validateMfProviderConsistency(message, selectData, result, flowId, "on_select", "select");
            // MF-QOT-001: quote price consistent (if on_select has a quote)
            if (message?.order?.quote) {
                const selectOnSearchData = await getActionData(sessionID, flowId, txnId, "on_select");
                validateMfQuoteConsistency(message, selectOnSearchData, result, flowId, "on_select", "prior_on_select");
            }
        }
    } catch (_) { }

    // Save form URLs (order.xinput / items[].xinput) so the HTML_FORM step that
    // follows can find them -- same Redis key the FIS12 validator uses.
    try {
        const txnId = element?.jsonRequest?.context?.transaction_id as string | undefined;
        const order = element?.jsonRequest?.message?.order;
        const urls: string[] = [
            order?.xinput?.form?.url,
            ...(Array.isArray(order?.items) ? order.items.map((i: any) => i?.xinput?.form?.url) : []),
        ].filter((u): u is string => typeof u === "string" && u.length > 0);
        if (txnId && urls.length > 0) {
            const existing = await fetchData(sessionID, txnId, "formUrls");
            const merged = Array.from(new Set([...(existing?.urls ?? []), ...urls]));
            await saveData(sessionID, txnId, "formUrls", { urls: merged });
        }
    } catch (_) { }

    await saveFromElement(element, sessionID, flowId, "jsonRequest");
    return result;
}
