import { TestResult, Payload } from "../../../types/payload";
import { saveFromElement } from "../../../utils/specLoader";
import { getActionData } from "../../../services/actionDataService";
import { runExternalSchemaAndL1Validation } from "../../shared/externalSchemaValidator";
import { validateReconAgainstOnRecon } from "../../shared/nts10ReconValidations";

export default async function recon(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const testResults: TestResult = { response: {}, passed: [], failed: [] };

  const { jsonRequest, jsonResponse } = element;
  if (jsonResponse?.response) testResults.response = jsonResponse?.response;

  // L0 + L1 (schema and x-validations rules)
  await runExternalSchemaAndL1Validation(jsonRequest, testResults);

  // L2: a second recon (after an on_recon) must agree with the on_recon values
  try {
    const ctx = jsonRequest?.context;
    const txnId = ctx?.transaction_id as string | undefined;
    if (txnId) {
      const onReconData = await getActionData(sessionID, flowId, txnId, "on_recon");
      if (onReconData) validateReconAgainstOnRecon(ctx, jsonRequest?.message, onReconData, testResults);
    }
  } catch (_) {}

  if (testResults.passed.length < 1 && testResults.failed.length < 1) {
    testResults.passed.push("Validated recon");
  }

  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return testResults;
}
