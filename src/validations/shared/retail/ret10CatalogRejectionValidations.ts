/**
 * Ported from log-validation-utility/utils/Retail/Catalog_Rejection/catalogRejection.ts.
 *
 * catalog_rejection is a non-standard pseudo-action (not one of Beckn's 20
 * canonical actions) that some mock-driven flows use to let the BAP report
 * why it rejected a BPP's catalog. There is no generated L0/L1 schema for it
 * at API_SERVICE (it isn't one of the real protocol actions), so unlike
 * every other action in this domain, this file does NOT call
 * runExternalSchemaAndL1Validation — there's nothing there for it to hit.
 *
 * Dropped from the original: the domain-matches-DAO cross-check (this
 * service's context validators already catch a wrong domain earlier in the
 * pipeline) and the flow=='9'/context.city==='*' incremental-search-only
 * rule (that's a different flow's concern, not Catalog_Rejection_Flow's).
 */
import { Payload, TestResult } from "../../../types/payload";
import { createBaseValidationSetup, tagLayer } from "../commonValidations";
import { CATALOG_REJECTION_ERRORS } from "./catalogRejectionErrors";

export async function validateRet10CatalogRejection(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const { testResults, jsonRequest, context } = createBaseValidationSetup(element);
  const errors = jsonRequest?.message?.errors;

  tagLayer(testResults, "L3", () => {
    if (!context) {
      testResults.failed.push("catalog_rejection: /context is missing");
    } else {
      testResults.passed.push("catalog_rejection: /context is present");
    }

    if (!Array.isArray(errors) || errors.length === 0) {
      testResults.failed.push(
        "catalog_rejection: /message/errors is missing or empty — at least one rejection reason is required"
      );
      return;
    }
    testResults.passed.push(
      `catalog_rejection: /message/errors contains ${errors.length} rejection reason(s)`
    );

    errors.forEach((error: { code?: string; type?: string }, index: number) => {
      const code = error?.code;
      const expected = code ? CATALOG_REJECTION_ERRORS[code] : undefined;

      if (!code) {
        testResults.failed.push(`catalog_rejection: errors[${index}]/code is missing`);
        return;
      }
      if (!expected) {
        testResults.failed.push(
          `catalog_rejection: errors[${index}]/code "${code}" is not a recognized catalog-rejection error code`
        );
        return;
      }
      if (error.type !== expected.type) {
        testResults.failed.push(
          `catalog_rejection: errors[${index}]/type "${error.type}" does not match the expected type "${expected.type}" for code "${code}"`
        );
      } else {
        testResults.passed.push(
          `catalog_rejection: errors[${index}]/type "${error.type}" is correct for code "${code}"`
        );
      }
    });
  });

  return testResults;
}
