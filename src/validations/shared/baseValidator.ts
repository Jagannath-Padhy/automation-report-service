import { getIgmHandler, isFinanceDomain, runIgmAction } from "./igm/igmActionHandler";
import { ValidationAction } from "../../types/actions";
import { TestResult, Payload } from "../../types/payload";
import { DOMAINS, RET_DOMAIN_PREFIX } from "../../utils/constants";
import { getRuntimeExtension } from "../../utils/getRuntimeExtension";
import { getFileName } from "./validationFactory";
import { existsSync } from "fs";
import path from "path";

import logger from "@ondc/automation-logger";
type CheckJsonResponseFn = (jsonResponse: any, testResults: TestResult, action_id?: string, flowId?: string) => void;

type VersionResolver = (element: Payload) => string | undefined;

/**
 * Factory to create a domain validator with shared logic.
 * - Uses dynamic imports per action and version: `./${version}/${ActionFile}`
 * - Aggregates results and applies response schema validation if response present
 */
export function createDomainValidator(
  resolveVersion: VersionResolver,
  checkJsonResponse: CheckJsonResponseFn
) {
  return async function validate(
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
      if (jsonResponse) {
        // Pass action_id and flowId so domain validators can conditionally adjust schema.
        // action_id may be null (Payload type), coerce to undefined for type safety.
        checkJsonResponse(jsonResponse, testResults, action_id ?? undefined, flowId);
      }
      logger.info("jsonResponse=>>>>>>>>", JSON.stringify(jsonResponse))
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
            `'${action_id}' was not checked: its context carries no version/core_version, so the matching validations could not be chosen`
          );
          return testResults;
        }

        // Most RET1X action files are identical thin wrappers around a
        // shared, domain-agnostic business-logic function (confirmed
        // 2026-10-23: 162 of 163 RET1X dispatch files are byte-for-byte the
        // same, the one real exception being RET11's on_search) — mirroring
        // log-validation-utility's own structure (utils/Retail, not one
        // folder per domain), which has no per-domain split at all except a
        // single RET11_onSearch exception. RET10's folder plays that same
        // "one shared structure" role here: for every other RET1X domain,
        // the domain-specific path is tried first (so a genuine override
        // like RET11's on_search still works), falling back to
        // ONDC:RET10/<version>/<fileName> when no domain-specific file
        // exists. Non-Retail domains (TRV/FIS/LOG) are untouched by this —
        // they have genuinely distinct per-domain logic, not duplicates.
        const isRetDomain = domain?.startsWith(RET_DOMAIN_PREFIX);
        const domainSpecificPath = path.resolve(
          __dirname,
          `../${element.jsonRequest.context.domain}/${version}/${fileName}`
        );
        const importSpecifier =
          !isRetDomain || existsSync(domainSpecificPath)
            ? `../${element.jsonRequest.context.domain}/${version}/${fileName}`
            : `../${DOMAINS.RET10}/${version}/${fileName}`;

        const mod: any = await import(importSpecifier);

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
        // Pass usecaseId if the function accepts it (function.length >= 5 means it has 5+ parameters)
        const testResult: TestResult = testFunction.length >= 5
          ? await testFunction(element, sessionID, flowId, action_id, usecaseId)
          : await testFunction(element, sessionID, flowId, action_id);
        testResults.passed.push(...(testResult.passed || []));
        testResults.failed.push(...(testResult.failed || []));
        if (testResult.response) {
          testResults.response = testResult.response;
        }
      } catch (err: any) {
        const domain = element?.jsonRequest?.context?.domain;
        // Only a missing validator file for this action/version means "nothing to run"; any
        // other error is the validator itself failing and is reported as such.
        const noValidator =
          (err?.code === "MODULE_NOT_FOUND" || err?.code === "ERR_MODULE_NOT_FOUND") &&
          String(err?.message).includes(`${domain}/${version}/`);
        testResults.failed.push(
          noValidator
            ? `'${action_id}' was not checked: no validations are available for ${action} in ${domain} ${version}`
            : `Validation of '${action_id}' could not complete: ${err?.message || err}`
        );
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
  };
}
