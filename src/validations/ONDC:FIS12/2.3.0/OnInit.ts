import { TestResult, Payload } from "../../../types/payload";
import { DomainValidators } from "../../shared/domainValidator";
import { validateOrderQuote } from "../../shared/quoteValidations";
import { saveFromElement } from "../../../utils/specLoader";
import { getActionData } from "../../../services/actionDataService";
import { validateFormIdIfXinputPresent } from "../../shared/formValidations";

export default async function on_init(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string,
  usecaseId?: string
): Promise<TestResult> {
  const result = await DomainValidators.fis12OnInit(element, sessionID, flowId, actionId, usecaseId);

  try {
    const message = element?.jsonRequest?.message;
    // Quote calculation checks are switched off for FIS12 Business Loan for now.
    if (message?.order?.quote && element?.jsonRequest?.context?.domain !== "ONDC:FIS12:BL") {
      validateOrderQuote(message, result, {
        validateDecimalPlaces: true,
        validateTotalMatch: true,
        // For TRV10, item price consistency is optional
        validateItemPriceConsistency: false,
        flowId,
      });
    }

    const txnId = element?.jsonRequest?.context?.transaction_id as string | undefined;
    if (txnId) {
      const initData = await getActionData(sessionID,flowId, txnId, "init");
      // Compare item ids and prices w.r.t INIT request
      const onInitItems: any[] = message?.order?.items || [];
      const initItems: any[] = initData?.items || [];
      const initPriceById = new Map<string, string>();
      for (const it of initItems) if (it?.id && it?.price?.value !== undefined) initPriceById.set(it.id, String(it.price.value));

      const missingFromInit: string[] = [];
      const priceMismatches: Array<{ id: string; init: string; on_init: string }> = [];
      for (const it of onInitItems) {
        const id = it?.id;
        if (!id) continue;
        if (!initPriceById.has(id)) {
          missingFromInit.push(id);
          continue;
        }
        const ini = parseFloat(initPriceById.get(id) as string);
        const onIni = it?.price?.value !== undefined ? parseFloat(String(it.price.value)) : NaN;
        if (!Number.isNaN(ini) && !Number.isNaN(onIni)) {
          if (ini === onIni) result.passed.push(`Item '${id}' price matches INIT`);
          else priceMismatches.push({ id, init: String(ini), on_init: String(onIni) });
        }
      }
      if (priceMismatches.length) result.failed.push("Item price mismatches between INIT and on_init");
      if (missingFromInit.length || priceMismatches.length) {
        (result.response as any) = {
          ...(result.response || {}),
          on_init_vs_init: { missingFromInit, priceMismatches },
        };
      }

      // Validate form ID consistency if xinput is present
      await validateFormIdIfXinputPresent(message, sessionID, flowId, txnId, "on_init", result);
    }
  } catch (_) {}

  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return result;
}