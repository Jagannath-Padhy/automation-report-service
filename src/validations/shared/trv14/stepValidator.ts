import { Payload, TestResult } from "../../../types/payload";
import { createBaseValidationSetup, addDefaultValidationMessage, tagLayer } from "../commonValidations";
import { runExternalSchemaAndL1Validation } from "../externalSchemaValidator";
import { getTrv14FlowProfile } from "./flowProfiles";
import { checkTrv14MandatoryFields } from "./mandatoryFields";
import { checkTrv14State } from "./stateTable";
import { checkTrv14Continuity } from "./continuity";
import { checkTrv14Settlement } from "./settlement";
import { checkTrv14QuoteCurrency } from "./helpers";
import { validateTrv14Search, validateTrv14OnSearch } from "./steps/searchValidations";
import { validateTrv14Select, validateTrv14OnSelect } from "./steps/selectValidations";
import { validateTrv14InitConfirm } from "./steps/initConfirmValidations";
import { validateTrv14Status } from "./steps/statusValidations";
import { validateTrv14CancelUpdate } from "./steps/cancelUpdateValidations";

/**
 * Entry point for every TRV14 2.0.0 action.
 *
 * L0+L1: the workbench's own schema + L1 rules (automation-specifications
 * draft-TRV14-2.0.0), through the same external endpoint RET10 uses.
 * L2: the payload belongs to a known workbench flow and step; workbench-mandatory
 * fields L1 does not check (mandatoryFields.ts); the order/fulfillment/payment
 * state the step must carry (stateTable.ts); message_id pairing, ttl and city
 * continuity (continuity.ts); step business rules (steps/*.ts: search, select,
 * init/confirm, status, cancel/update).
 */
export async function validateTrv14Step(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const { testResults, action, jsonRequest } = createBaseValidationSetup(element);
  await runExternalSchemaAndL1Validation(jsonRequest, testResults);

  const profile = getTrv14FlowProfile(flowId);
  const isKnownStep = !!profile && !!actionId && profile.sequence.includes(actionId);

  tagLayer(testResults, "L2", () => {
    if (!profile) {
      testResults.failed.push(`${action}: flow '${flowId}' is not a TRV14 2.0.0 workbench flow`);
      return;
    }
    if (!isKnownStep) {
      testResults.failed.push(
        `${action}: action_id '${actionId}' is not a step of workbench flow '${flowId}'`
      );
      return;
    }
    testResults.passed.push(`${action}: '${actionId}' is a step of workbench flow '${flowId}'`);
    checkTrv14MandatoryFields(jsonRequest, action, profile, testResults);
    checkTrv14State(jsonRequest, actionId, testResults);
    checkTrv14QuoteCurrency(jsonRequest, testResults);
    // Technical cancellation: the BPP's on_confirm is sent after the TTL on purpose,
    // so a NACK from the BAP is the expected outcome, not a fault.
    if (profile.postConfirm === "TECH_CANCEL" && action === "on_confirm" && element?.jsonResponse?.message?.ack?.status === "NACK") {
      testResults.passed.push(`${action} (${actionId}): NACK expected — the technical-cancellation flow delivers on_confirm after its TTL`);
    }
  });

  if (profile && isKnownStep) {
    const stepResults: TestResult = { response: {}, passed: [], failed: [] };
    await checkTrv14Continuity(element, sessionID, flowId, actionId, profile, stepResults);
    await checkTrv14Settlement(element, sessionID, flowId, actionId, profile, stepResults);
    if (action === "search") await validateTrv14Search(element, sessionID, flowId, profile, stepResults);
    if (action === "on_search") await validateTrv14OnSearch(element, sessionID, flowId, actionId, stepResults);
    if (action === "select") await validateTrv14Select(element, sessionID, flowId, actionId, profile, stepResults);
    if (action === "on_select") await validateTrv14OnSelect(element, sessionID, flowId, actionId, profile, stepResults);
    if (["init", "on_init", "confirm", "on_confirm"].includes(action)) {
      await validateTrv14InitConfirm(element, sessionID, flowId, actionId, profile, stepResults);
    }
    if (action === "status" || action === "on_status") {
      await validateTrv14Status(element, sessionID, flowId, actionId, profile, stepResults);
    }
    if (["cancel", "on_cancel", "update", "on_update"].includes(action)) {
      await validateTrv14CancelUpdate(element, sessionID, flowId, actionId, profile, stepResults);
    }
    tagLayer(testResults, "L2", () => {
      testResults.passed.push(...stepResults.passed);
      testResults.failed.push(...stepResults.failed);
    });
  }

  addDefaultValidationMessage(testResults, action);
  return testResults;
}
