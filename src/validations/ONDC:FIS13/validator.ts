import { getIgmHandler, isFinanceDomain, runIgmAction } from "../shared/igm/igmActionHandler";
import { Payload, TestResult } from "../../types/payload";
import { ackResponseSchema } from "../shared/responseSchemas";
import { checkJsonResponse } from "../shared/schemaValidator";
import { DOMAINS, HEALTH_INSURANCE_FLOWS } from "../../utils/constants";
import { getRuntimeExtension } from "../../utils/getRuntimeExtension";
import { getFileName } from "../shared/validationFactory";
import logger from "@ondc/automation-logger";

const resolveVersion = (element: Payload) =>
  element?.jsonRequest?.context?.version || element?.jsonRequest?.context?.core_version;

/**
 * FIS13-specific validator that bypasses x-validation response processing
 * for Health Insurance flows only.
 *
 * Why: The L2 validators in the report service already cover all business-level
 * checks that the x-validation rules in build.yaml perform for Health Insurance.
 * Running both produces duplicate or conflicting results. This bypass is scoped
 * strictly to Health Insurance flows within FIS13; all other FIS13 flows
 * (Motor Insurance, Sachet Insurance, etc.) continue to use x-validation normally.
 */
export async function validate(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string,
  usecaseId?: string
): Promise<TestResult> {
  const version = resolveVersion(element);

  let testResults: TestResult = { response: {}, passed: [], failed: [] };

  try {
    const { jsonResponse, action_id, action } = element;

    // ── Conditional x-validation bypass ──
    // Skip sync-response schema validation for Health Insurance flows only.
    // All other FIS13 flows retain the original checkJsonResponse behaviour.
    const isHealthInsurance = !!flowId && HEALTH_INSURANCE_FLOWS.includes(flowId);

    if (jsonResponse && !isHealthInsurance) {
      checkJsonResponse(jsonResponse, testResults, ackResponseSchema);
    }

    try {
      const domain = element?.jsonRequest?.context?.domain;
      const ext = getRuntimeExtension();
      const igmHandler = isFinanceDomain(domain) ? getIgmHandler(action) : undefined;
      if (igmHandler) {
        const igmResult = await runIgmAction(igmHandler, element, sessionID, flowId, action_id as string);
        testResults.passed.push(...(igmResult.passed || []));
        testResults.failed.push(...(igmResult.failed || []));
        return testResults;
      }


      let baseName =
        domain && domain.startsWith(DOMAINS.FIS11)
          ? action_id
          : getFileName(action);

      const fileName = `${baseName}.${ext}`;

      if (!fileName || !version) {
        testResults.failed.push(
          `Incorrect version or unsupported action: ${action_id}`
        );
        return testResults;
      }

      const mod: any = await import(
        `../${element.jsonRequest.context.domain}/${version}/${fileName}`
      );

      const exportedFnName = Object.keys(mod).find(
        (k) => typeof (mod as any)[k] === "function"
      );

      const testFunction: Function | undefined = exportedFnName
        ? (mod as any)[exportedFnName]
        : undefined;

      if (!testFunction) {
        testResults.failed.push(
          `No matching test function found for ${action_id}.`
        );
        return testResults;
      }

      // Support both old and new function signatures (with optional usecaseId)
      const testResult: TestResult = testFunction.length >= 5
        ? await testFunction(element, sessionID, flowId, action_id, usecaseId)
        : await testFunction(element, sessionID, flowId, action_id);
      testResults.passed.push(...(testResult.passed || []));
      testResults.failed.push(...(testResult.failed || []));
      if (testResult.response) {
        testResults.response = testResult.response;
      }
    } catch (err: any) {
      testResults.failed.push(`Incorrect version for ${action_id}`);
      logger.error(
        `Error importing version-specific tests: ${err?.stack || err}`
      );
    }

    return testResults;
  } catch (error: any) {
    logger.error(`Error during validation: ${error?.message || error}`);
    return {
      response: {},
      passed: [],
      failed: [`Error during ${element.action_id} test execution`],
    };
  }
}
