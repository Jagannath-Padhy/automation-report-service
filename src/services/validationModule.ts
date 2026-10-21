import {
  FlowValidationResult,
  WrappedPayload,
  Report,
  Payload,
  TestResult,
} from "../types/payload";
import { loadConfig } from "../utils/configLoader";
import { actions } from "../utils/constants";
import { ValidationAction } from "../types/actions";
import logger from "@ondc/automation-logger";
import { MESSAGES } from "../utils/messages";
import { RedisService } from "@ondc/ondc-automation-cache-lib";
import { checkPayload } from "./checkPayload";

// Type guard to ensure the action is a valid ValidationAction from the predefined actions list
function isValidAction(action: string): action is ValidationAction {
  return actions.includes(action);
}

// Pre-computed action counters for better performance
const INITIAL_ACTION_COUNTERS: Record<ValidationAction, number> = {
  search: 1,
  on_search: 1,
  select: 1,
  on_select: 1,
  init: 1,
  on_init: 1,
  confirm: 1,
  on_confirm: 1,
  cancel: 1,
  on_cancel: 1,
  update: 1,
  on_update: 1,
  on_status: 1,
  status: 1,
  track: 1,
  on_track: 1,
  issue: 1,
  on_issue: 1,
  issue_status: 1,
  on_issue_status: 1,
};

// Interface for session details
export interface SessionDetails {
  domain: string;
  version: string;
  usecaseId?: string;
}

// Interface for domain configuration
interface DomainConfig {
  flows: Record<string, string[]>;
  optional_flows?: string[];
  /**
   * Per-flow `action_id`s that MUST appear for the flow to be valid, keyed by flow id.
   *
   * Opt-in by design: `flows` declares the expected ORDER of actions, and
   * validateActionSequence's lookahead deliberately tolerates skipped steps so that
   * genuinely optional ones (a repeat `search`, mid-flow polling) do not fail a flow. The
   * side effect was that a flow could skip mandatory steps entirely and still report Valid —
   * a COD run that sent 1 of its 6 `on_status` legs was reported Valid with no sequence
   * errors, because the lookahead found `track` further down the sequence and jumped there.
   *
   * This is the narrow fix: a flow listed here additionally has its mandatory `action_id`s
   * checked for PRESENCE. A flow or domain absent from this map behaves exactly as before,
   * so no other domain's reports change.
   */
  mandatory_legs?: Record<string, string[]>;
  /**
   * Per-flow `action_id` of each step, aligned 1:1 with `flows[flowId]`. Only the log-upload
   * report reads it (logsAdapter.assignActionIds) — uploaded logs carry no action_id.
   */
  flow_action_ids?: Record<string, string[]>;
  validationModules?: string;
}

/**
 * Retrieves and parses session details from Redis
 */
async function getSessionDetails(
  sessionID: string
): Promise<SessionDetails | null> {
  try {
    const sessionData = await RedisService.getKey(
      `sessionDetails:${sessionID}`
    );
    return sessionData ? JSON.parse(sessionData) : null;
  } catch (error) {
    logger.error("Failed to retrieve session details", error, { sessionID });
    return null;
  }
}

/**
 * Checks if all mandatory flows are tested
 */
function checkMandatoryFlows(
  testedFlows: string[],
  domainConfig: DomainConfig,
  report: Report
): void {
  if (!Array.isArray(testedFlows)) {
    logger.error("testedFlows is not an array or is undefined", { testedFlows });
    return;
  }

  const allFlows = Object.keys(domainConfig?.flows || {});
  const mandatoryFlows: string[] = [];

  for (const flowId of allFlows) {
    if (!testedFlows.includes(flowId)) {
      // If the updates flow is tested, the basic confirm flow is optional
      if (
        (flowId === "Order to Confirm to Fulfillment (City Code)" ||
          flowId === "Order to Confirm to Fulfillment (City Based)") &&
        testedFlows.includes("Order to Confirm to Fulfillment (Updates in Booking)")
      ) {
        continue;
      }

      const isOptional =
        Array.isArray(domainConfig?.optional_flows) &&
        domainConfig.optional_flows.includes(flowId);

      if (!isOptional) {
        mandatoryFlows.push(flowId);
      }
    }
  }
  if (mandatoryFlows.length > 0) {
    report.finalReport.mandatoryFlows = `${mandatoryFlows.join(
      ", "
    )} is/are mandatory and should be tested.`;
  }
}

/**
 * Which of a flow's mandatory `action_id`s never arrived.
 *
 * Complements validateActionSequence, which checks ORDER and tolerates skipped steps. This
 * checks PRESENCE only, so the two are independent: a flow can have every mandatory leg in
 * the wrong order (a sequence error) or the right order with legs missing (a mandatory-leg
 * error), and each is reported by the rule that is actually about it.
 *
 * Matching is on `action_id` because that is what distinguishes the legs that matter — the
 * six `on_status` legs of an order flow all have `action` `on_status` and are told apart
 * only by `action_id` (`on_status_packed`, `on_status_order_delivered`, …). Falls back to
 * `action` the same way checkPayload.ts does, so a flow whose mandatory legs are plain
 * actions still works.
 */
function findMissingMandatoryLegs(
  payloads: Payload[],
  mandatoryLegs: string[] | undefined
): string[] {
  if (!Array.isArray(mandatoryLegs) || mandatoryLegs.length === 0) return [];
  if (!Array.isArray(payloads)) return mandatoryLegs;

  const seen = new Set(
    payloads
      .map((p) => String(p?.action_id || p?.action || "").toLowerCase())
      .filter(Boolean)
  );

  return mandatoryLegs.filter((leg) => !seen.has(String(leg).toLowerCase()));
}

/**
 * Validates the action sequence for a flow
 * Handles HTML_FORM entries by skipping them in the sequence but maintaining position tracking
 * Now includes payload deduplication to handle duplicate responses from multiple providers
 */
function validateActionSequence(
  payloads: Payload[],
  requiredSequence: string[],
  flowId?: string
): { validSequence: boolean; errors: string[] } {
  const errors: string[] = [];
  let validSequence = true;

  try {
    // Enhanced payload deduplication logic
    const deduplicatedPayloads = payloads.filter((payload, index, array) => {
      const duplicateIndex = array.findIndex(p =>
        p.action?.toLowerCase() === payload.action?.toLowerCase() &&
        p.transactionId === payload.transactionId &&
        Math.abs(new Date(p.createdAt).getTime() - new Date(payload.createdAt).getTime()) < 1000 // Within 1 second
      );

      // Keep the first occurrence of each duplicate
      return duplicateIndex === index;
    });

    // Log duplicate detection results
    if (deduplicatedPayloads.length !== payloads.length) {
      const removedCount = payloads.length - deduplicatedPayloads.length;
      logger.info("Duplicate payloads detected and removed", {
        flowId: flowId || "unknown",
        originalCount: payloads.length,
        deduplicatedCount: deduplicatedPayloads.length,
        removedCount,
        removedPayloads: payloads.filter(p => !deduplicatedPayloads.includes(p)).map(p => ({
          action: p.action,
          transactionId: p.transactionId,
          createdAt: p.createdAt
        }))
      });
    }

    // Use deduplicated payloads for validation
    const validationPayloads = deduplicatedPayloads;
    let payloadIndex = 0; // Index for actual payloads (excluding HTML_FORM)

    // Enhanced debugging logs with deduplication info
    logger.info("Validating action sequence", {
      flowId: flowId || "unknown",
      requiredSequenceLength: requiredSequence.length,
      originalPayloadsLength: payloads.length,
      deduplicatedPayloadsLength: validationPayloads.length,
      requiredSequence: requiredSequence,
      validationPayloadActions: validationPayloads.map((p, idx) => ({
        index: idx,
        action: p?.action?.toLowerCase(),
        transactionId: p?.transactionId,
        createdAt: p?.createdAt
      }))
    });

    for (let i = 0; i < requiredSequence.length; i++) {
      const expectedAction = requiredSequence[i].toLowerCase();

      // Skip HTML_FORM entries in the required sequence - they don't have corresponding payloads
      if (expectedAction === "html_form") {
        logger.info(`Skipping HTML_FORM at sequence position ${i + 1}`);
        // HTML_FORM is expected, so we just skip it and continue
        continue;
      }

      // Skip DYNAMIC_FORM entries in the required sequence - they don't have corresponding payloads
      if (expectedAction === "dynamic_form") {
        logger.info(`Skipping DYNAMIC_FORM at sequence position ${i + 1}`);
        // DYNAMIC_FORM is expected, so we just skip it and continue
        continue;
      }

      // Check if we have enough payloads
      if (payloadIndex >= validationPayloads.length) {
        validSequence = false;
        // Check for Early Success Termination
        // If the flow ended, but the expected action is a user-initiated request (like 'update', 'status', 'track')
        // And the last action was a valid response (like 'on_update', 'on_status', 'on_track')
        // Then we can assume the user chose to stop the flow here.
        if (i > 0) {
          // Walk backwards past DYNAMIC_FORM/HTML_FORM to find the real previous action
          let lastAction = "start";
          for (let j = i - 1; j >= 0; j--) {
            const prev = requiredSequence[j].toLowerCase();
            if (prev !== "html_form" && prev !== "dynamic_form") {
              lastAction = prev;
              break;
            }
          }
          const currentExpectedAction = expectedAction.toLowerCase();

        if (
            (currentExpectedAction === "update" ||
              currentExpectedAction === "status" ||
              currentExpectedAction === "track" ||
              currentExpectedAction === "cancel" ||
              currentExpectedAction === "on_status" ||
              currentExpectedAction === "on_update") &&
            // Allow when previous was an on_ response (e.g. on_confirm → on_status)
            // OR when previous was the matching request (e.g. update → on_update, status → on_status)
            (lastAction.startsWith("on_") ||
              (currentExpectedAction === "on_update" && lastAction === "update") ||
              (currentExpectedAction === "on_status" && lastAction === "status"))
          ) {
            logger.info(`Flow ended early at step ${i + 1} (Expected '${expectedAction}'). Assuming user stopped the interaction.`);
            validSequence = true; // Restore validSequence to true for valid early termination
            break; // Exit loop, considering validation successful so far
          }

          // Allow early termination when a second 'search' is expected after 'on_search'
          // This handles TTL-based flows (e.g. Hotel Booking ttl based) where the second
          // incremental search is optional — if the BAP didn't send it, the flow is still valid.
          if (
            currentExpectedAction === "search" &&
            lastAction === "on_search"
          ) {
            logger.info(`Flow ended early at step ${i + 1} (Expected '${expectedAction}' after 'on_search'). Treating repeat search as optional.`);
            validSequence = true;
            break;
          }
        }

        errors.push(
          `Error: Expected '${expectedAction}' but no more payloads found. Sequence position: ${i + 1}`
        );
        break;
      }

      const actualAction = validationPayloads[payloadIndex]?.action?.toLowerCase();

      // Skip duplicate on_ actions if they don't match expected (e.g. multiple on_search calls)
      if (payloadIndex > 0) {
        const prevPayloadAction = validationPayloads[
          payloadIndex - 1
        ]?.action?.toLowerCase();
        if (
          actualAction === prevPayloadAction &&
          actualAction?.startsWith("on_") &&
          actualAction !== expectedAction
        ) {
          logger.info(
            `Skipping duplicate ${actualAction} at payload index ${payloadIndex} which is not expected here`
          );
          payloadIndex++;
          i--; // Retry the current expectedAction against the next payload
          continue;
        }
      }

      // Skip unsolicited on_status if not expected
      // This handles async status updates during flows (e.g. cancellation)
      if (actualAction === "on_status" && expectedAction !== "on_status") {
        logger.info(
          `Skipping unsolicited ${actualAction} at payload index ${payloadIndex} which is not expected here`
        );
        payloadIndex++;
        i--; // Retry the current expectedAction against the next payload
        continue;
      }

      // Skip unsolicited on_update if not expected
      // This handles async updates in delayed cancellation flows
      if (actualAction === "on_update" && expectedAction !== "on_update") {
        logger.info(
          `Skipping unsolicited ${actualAction} at payload index ${payloadIndex} which is not expected here`
        );
        payloadIndex++;
        i--; // Retry the current expectedAction against the next payload
        continue;
      }

      // Lookahead: Check if actual action matches a future expected action (skipped steps)
      // This handles cases where optional steps are skipped in the flow (e.g. search -> on_search)
      if (actualAction !== expectedAction) {
        let foundFutureMatch = false;
        let futureIndex = -1;
        // Look ahead up to 15 steps
        for (let k = i + 1; k < Math.min(i + 15, requiredSequence.length); k++) {
          const futureAction = requiredSequence[k]?.toLowerCase();
          // Skip checking against HTML_FORM/DYNAMIC_FORM as jump targets
          if (futureAction === "html_form" || futureAction === "dynamic_form") continue;

          if (futureAction === actualAction) {
            foundFutureMatch = true;
            futureIndex = k;
            break;
          }
        }

        if (foundFutureMatch) {
          logger.info(`Skipping expected steps from index ${i} to ${futureIndex - 1} because actual action '${actualAction}' matches sequence at index ${futureIndex}`);
          i = futureIndex - 1; // Advance loop to just before the matching step (loop will increment i)
          continue; // Continue loop to match current payload against new expected action
        }

        // Allow mid-flow status/on_status polling after select/on_select or init/on_init
        if (actualAction === "status" || actualAction === "on_status") {
          logger.info(`Treating '${actualAction}' at payload position ${payloadIndex + 1} as an allowed mid-flow status check (Expected '${expectedAction}')`);
          payloadIndex++;
          i--; // Retry current expected action against the next payload
          continue;
        }
      }

      // If the expected action is on_status but the actual payload is a BAP-initiated
      // 'status' request (e.g. Technical Cancellation flow ordering), skip this payload
      // and retry the same expected action against the next payload.
      if (expectedAction === "on_status" && actualAction === "status") {
        logger.info(`Expected 'on_status' but found 'status' payload; skipping and retrying`);
        payloadIndex++;
        i--; // Retry current expected action (on_status) against next payload
        continue;
      }

      if (actualAction !== expectedAction) {
        // For better error message, check if this is a select/init ambiguity
        let displayExpectedAction = expectedAction;
        if (expectedAction === "select") {
          displayExpectedAction = "select or init";
        }

        validSequence = false;

        // Find the previous non-HTML_FORM/non-DYNAMIC_FORM action for better error message
        let previousAction = "start";
        for (let j = i - 1; j >= 0; j--) {
          const prevAction = requiredSequence[j].toLowerCase();
          if (prevAction !== "html_form" && prevAction !== "dynamic_form") {
            previousAction = prevAction;
            break;
          }
        }

        // Also check if there's an HTML_FORM or DYNAMIC_FORM right before this expected action
        const hasHtmlFormBefore = i > 0 && requiredSequence[i - 1]?.toLowerCase() === "html_form";
        const hasDynamicFormBefore = i > 0 && requiredSequence[i - 1]?.toLowerCase() === "dynamic_form";

        // Check if we're ahead in payloads (missing action scenario)
        // Look ahead to see if the expected action appears later
        let foundLater = false;
        let foundAtPosition = -1;
        for (let k = payloadIndex + 1; k < validationPayloads.length; k++) {
          if (validationPayloads[k]?.action?.toLowerCase() === expectedAction) {
            foundLater = true;
            foundAtPosition = k;
            break;
          }
        }

        // Build context for debugging
        const sequenceContext = requiredSequence.slice(Math.max(0, i - 3), Math.min(i + 4, requiredSequence.length));
        const payloadContext = validationPayloads.slice(Math.max(0, payloadIndex - 2), Math.min(payloadIndex + 3, validationPayloads.length))
          .map((p, idx) => ({
            relativeIndex: idx - Math.max(0, payloadIndex - 2),
            action: p?.action?.toLowerCase(),
            transactionId: p?.transactionId
          }));

        logger.error("Action sequence mismatch - Detailed Debug", {
          sequencePosition: i + 1,
          expectedAction,
          actualAction,
          previousAction,
          payloadIndex,
          hasHtmlFormBefore,
          foundLater,
          foundAtPosition,
          sequenceContext: sequenceContext.map((s, idx) => ({
            pos: Math.max(0, i - 3) + idx,
            action: s,
            isCurrent: Math.max(0, i - 3) + idx === i
          })),
          payloadContext,
          fullRequiredSequence: requiredSequence,
          originalPayloadActions: payloads.map(p => p?.action?.toLowerCase()),
          deduplicatedPayloadActions: validationPayloads.map(p => p?.action?.toLowerCase())
        });

        let errorMessage = `Error: Expected '${displayExpectedAction}' after '${previousAction}'`;
        if (hasHtmlFormBefore) {
          errorMessage += ` (HTML_FORM was skipped)`;
        }
        if (hasDynamicFormBefore) {
          errorMessage += ` (DYNAMIC_FORM was skipped)`;
        }
        if (foundLater) {
          errorMessage += `. Note: '${expectedAction}' action found later at payload position ${foundAtPosition + 1}, suggesting a missing action in the sequence.`;
        }
        errorMessage += `, but found '${actualAction || "undefined"}'.`;

        errors.push(errorMessage);
        break;
      }

      // Move to next payload only if we matched a non-HTML_FORM action
      payloadIndex++;
    }
  } catch (error) {
    logger.error("Error occurred during action sequence validation", error, { requiredSequence });
    validSequence = false;
    errors.push("Error occurred during action sequence validation");
  }

  return { validSequence, errors };
}

/**
 * Processes payloads and validates them using checkPayload
 * Also handles HTML_FORM validations inline when they appear in the sequence
 */
async function processPayloads(
  payloads: Payload[],
  sessionID: string,
  flowId: string,
  domainConfig: DomainConfig,
  requiredSequence?: string[],
  usecaseId?: string,
  // pramaan-validation-parity skill: what this flow's domain/version is supposed to be,
  // independent of any single payload — threaded down to checkPayload's
  // context:domain-exact-match / context:version-exact-match checks.
  expectedDomainVersion?: { domain?: string; version?: string }
): Promise<Record<string, string>> {
  const messages: Record<string, string> = {};
  const actionCounters = { ...INITIAL_ACTION_COUNTERS };
  let payloadIndex = 0; // Track actual payloads
  let htmlFormCounter = 0; // Track HTML_FORM occurrences
  let dynamicFormCounter = 0; // Track DYNAMIC_FORM occurrences
  // pramaan-validation-parity skill: everything actually checked so far in this flow, in
  // processing order — passed to checkPayload so it can run cross-call continuity checks.
  // Built incrementally below, both in the sequence-order branch and the fallback branch.
  const priorPayloadsInFlow: Payload[] = [];

  // If we have a required sequence, process in sequence order
  if (requiredSequence && requiredSequence.length > 0) {
    const transactionId = payloads[0]?.transactionId || payloads[0]?.jsonRequest?.context?.transaction_id;

    for (let seqIndex = 0; seqIndex < requiredSequence.length; seqIndex++) {
      const expectedAction = requiredSequence[seqIndex].toLowerCase();

      // Handle HTML_FORM validation inline
      if (expectedAction === "html_form") {
        htmlFormCounter++;

        try {
          const { validateHTMLForm } = await import("../validations/shared/formValidations");
          const htmlFormTestResults: TestResult = { response: {}, passed: [], failed: [] };

          if (transactionId) {
            await validateHTMLForm(sessionID, transactionId, flowId, htmlFormTestResults);
            messages[`html_form_${htmlFormCounter}`] = JSON.stringify({
              passed: htmlFormTestResults.passed,
              failed: htmlFormTestResults.failed,
            });
          } else {
            htmlFormTestResults.failed.push("Transaction ID not found for HTML_FORM validation");
            messages[`html_form_${htmlFormCounter}`] = JSON.stringify({
              passed: [],
              failed: htmlFormTestResults.failed,
            });
          }
        } catch (error: any) {
          logger.error(`Error validating HTML_FORM ${htmlFormCounter}`, error);
          messages[`html_form_${htmlFormCounter}`] = JSON.stringify({
            passed: [],
            failed: [`HTML_FORM validation error: ${error.message}`],
          });
        }
        continue; // Skip to next sequence item
      }

      // Handle DYNAMIC_FORM validation inline (similar to HTML_FORM)
      if (expectedAction === "dynamic_form") {
        dynamicFormCounter++;

        try {
          // For now, just mark dynamic forms as passed since there's no specific validation
          // This can be extended later if needed
          const dynamicFormTestResults: TestResult = { response: {}, passed: [], failed: [] };
          dynamicFormTestResults.passed.push(`Dynamic form ${dynamicFormCounter} processed successfully`);

          messages[`dynamic_form_${dynamicFormCounter}`] = JSON.stringify({
            passed: dynamicFormTestResults.passed,
            failed: dynamicFormTestResults.failed,
          });
        } catch (error: any) {
          logger.error(`Error processing DYNAMIC_FORM ${dynamicFormCounter}`, error);
          messages[`dynamic_form_${dynamicFormCounter}`] = JSON.stringify({
            passed: [],
            failed: [`DYNAMIC_FORM processing error: ${error.message}`],
          });
        }
        continue; // Skip to next sequence item
      }

      // Process actual payload
      if (payloadIndex >= payloads.length) {
        logger.info(`No more payloads available at sequence position ${seqIndex + 1}`,
          { meta: { flowId, seqIndex: seqIndex + 1 } }
        );
        break;
      }

      const element = payloads[payloadIndex];
      const action = element?.action?.toLowerCase();

      if (!isValidAction(action)) {
        logger.error(`Invalid action: ${action}`, { flowId, action, index: payloadIndex });
        payloadIndex++;
        continue;
      }

      const domain = element?.jsonRequest?.context?.domain;

      try {
        const result = await checkPayload(
          domain,
          element,
          sessionID,
          flowId,
          domainConfig,
          usecaseId,
          priorPayloadsInFlow,
          expectedDomainVersion
        );

        messages[`${action}_${actionCounters[action]}`] = JSON.stringify(result);
        actionCounters[action] += 1;
      } catch (error) {
        logger.error(`Error occurred for action ${action} at index ${payloadIndex}`, error, { flowId, action, index: payloadIndex });
      }
      priorPayloadsInFlow.push(element);

      payloadIndex++;
    }
  } else {
    // Fallback: process payloads without sequence (original behavior)
    for (let i = 0; i < payloads.length; i++) {
      const element = payloads[i];
      const action = element?.action?.toLowerCase();

      if (!isValidAction(action)) {
        logger.error(`Invalid action: ${action}`, { flowId, action, index: i });
        continue;
      }

      const domain = element?.jsonRequest?.context?.domain;

      try {
        const result = await checkPayload(
          domain,
          element,
          sessionID,
          flowId,
          domainConfig,
          usecaseId,
          priorPayloadsInFlow,
          expectedDomainVersion
        );

        messages[`${action}_${actionCounters[action]}`] = JSON.stringify(result);
        actionCounters[action] += 1;
      } catch (error) {
        logger.error(`Error occurred for action ${action} at index ${i}`, error, { flowId, action, index: i });
      }
      priorPayloadsInFlow.push(element);
    }
  }

  return messages;
}

// Main validation module function
export async function validationModule(
  groupedPayloads: Record<string, Payload[]>,
  sessionID: string,
  // Log-upload reports have no live session in Redis, so they pass the details directly.
  sessionDetailsOverride?: SessionDetails
): Promise<Report> {
  logger.info(MESSAGES.services.validationEnter, { sessionID, flowCount: Object.keys(groupedPayloads).length });

  const report: Report = { finalReport: {}, flowErrors: {} };
  const flowsReport: Record<string, FlowValidationResult> = {};
  const testedFlows = Object.keys(groupedPayloads);

  // Get session details and domain configuration
  const sessionDetails = sessionDetailsOverride ?? await getSessionDetails(sessionID);
  // Use optional chaining for usecaseId to avoid property access error
  const domainConfig: DomainConfig = sessionDetails
    ? loadConfig(
      sessionDetails.domain,
      sessionDetails.version,
      (sessionDetails as any).usecaseId // fallback to 'any' for backwards compatibility
    )
    : { flows: {} };

  // Check mandatory flows
  try {
    logger.info(MESSAGES.validations.checkingMandatoryFlows, { testedFlows });

    checkMandatoryFlows(testedFlows, domainConfig, report);

    logger.info(MESSAGES.validations.mandatoryFlowsDone, { testedFlows });
  } catch (error: any) {
    logger.error("Error checking mandatory flows", error, { testedFlows });
  }
  // Process each flow
  for (const flowId in groupedPayloads) {
    const requiredSequence = domainConfig?.flows?.[flowId];
    const payloads = groupedPayloads[flowId];

    logger.info(MESSAGES.validations.actionValidationStart(flowId), { flowId });

    // Step 1: Validate action sequence with deduplication
    let { validSequence, errors } = validateActionSequence(
      payloads,
      requiredSequence || [],
      flowId
    );

    // Step 1b: mandatory legs. Opt-in per flow — see DomainConfig.mandatory_legs. Reported
    // alongside the sequence errors because a missing mandatory leg IS a flow-shape problem,
    // and because the lookahead in validateActionSequence cannot see it.
    const missingLegs = findMissingMandatoryLegs(
      payloads,
      domainConfig?.mandatory_legs?.[flowId]
    );
    if (missingLegs.length > 0) {
      validSequence = false;
      errors = [
        ...errors,
        `Error: flow '${flowId}' is missing ${missingLegs.length} mandatory step(s): ` +
          `${missingLegs.join(", ")}. These must all be exercised for this flow to be valid.`,
      ];
      logger.info("Mandatory legs missing", { flowId, missingLegs });
    }

    logger.info(MESSAGES.validations.actionValidationDone(flowId), { flowId });

    // Step 2: Process payloads (HTML_FORM validations are now handled inline)
    // Try multiple possible keys for usecaseId
    const usecaseId = (sessionDetails as any)?.usecaseId
      || (sessionDetails as any)?.usecase_id
      || (sessionDetails as any)?.useCaseId;
    // pramaan-validation-parity skill: sessionDetails is independently fetched session state
    // (not read from any single payload), so it's a real "expected" value to check payloads
    // against — see contextValidator.ts's ExpectedContext doc comment for why this matters.
    const expectedDomainVersion = sessionDetails
      ? { domain: sessionDetails.domain, version: sessionDetails.version }
      : undefined;

    const messages = await processPayloads(
      payloads,
      sessionID,
      flowId,
      domainConfig,
      requiredSequence,
      usecaseId,
      expectedDomainVersion
    );

    logger.info(MESSAGES.validations.payloadProcessingDone(flowId), { flowId });

    // Step 3: Store validation results
    flowsReport[flowId] = {
      valid_flow: validSequence,
      errors,
      messages,
    };
  }

  report.flowErrors = flowsReport;

  logger.info(MESSAGES.services.validationExit, { sessionID, flowCount: Object.keys(flowsReport).length });

  return report;
}
