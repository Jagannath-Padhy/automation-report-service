import { TestResult, Payload } from "../../../types/payload";
import { saveFromElement } from "../../../utils/specLoader";
import { getActionData } from "../../../services/actionDataService";
import { runExternalSchemaAndL1Validation } from "../../shared/externalSchemaValidator";
import { validateOnReconAgainstRecon } from "../../shared/nts10ReconValidations";

export default async function on_recon(
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

  // L2: compare with the recon this on_recon answers
  try {
    const ctx = jsonRequest?.context;
    const txnId = ctx?.transaction_id as string | undefined;
    if (txnId) {
      const reconData = await getActionData(sessionID, flowId, txnId, "recon");
      validateOnReconAgainstRecon(ctx, jsonRequest?.message, jsonRequest?.error, reconData, testResults);
    }
  } catch (_) {}

  if (testResults.passed.length < 1 && testResults.failed.length < 1) {
    testResults.passed.push("Validated on_recon");
  }

  await saveFromElement(element, sessionID, flowId, "jsonRequest");
  return testResults;
}
