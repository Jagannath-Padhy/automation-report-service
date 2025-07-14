import {
  FlowValidationResult,
  WrappedPayload,
  Report,
  Payload,
} from "../types/payload"; // Importing types for flow validation results and payload structure
import { loadConfig } from "../utils/configLoader"; // Import flow configuration for the sequence of expected actions
import { checkMessage } from "./checkMessage"; // Import the checkMessage function for validating the actions
import { actions } from "../utils/constants"; // Import available actions for validation
import { ValidationAction } from "../types/actions"; // Import the type for valid validation actions
import { logError, logger, logInfo } from "../utils/logger";
import { RedisService } from "ondc-automation-cache-lib";

// Type guard to ensure the action is a valid ValidationAction from the predefined actions list
function isValidAction(action: string): action is ValidationAction {
  return actions.includes(action);
}

// Validation Module for processing grouped payloads and validating their sequence and actions
export async function validationModule(
  groupedPayloads: {
    [flowId: string]: Payload[]; // Grouping payloads by flowId
  },
  sessionID: string
): Promise<Report> {
  // Return type that contains validation results per flowId
  logInfo
    ({
      message: "Entering validationModule function.",
      meta: { sessionID, groupedPayloads },
    });
  let sessionDetails: any = await RedisService.getKey(
    `sessionDetails:${sessionID}`
  );
  sessionDetails = JSON.parse(sessionDetails);

  logInfo({
    message: "Session details retrieved",
    meta: { 
      sessionID, 
      domain: sessionDetails?.domain,
      version: sessionDetails?.version,
      isRetailDomain: sessionDetails?.domain?.startsWith("ONDC:RET")
    }
  });

  let domainConfig: any;
  if (sessionDetails) {
    domainConfig = loadConfig(sessionDetails?.domain, sessionDetails?.version);
    logInfo({
      message: "Domain configuration loaded",
      meta: { 
        domain: sessionDetails?.domain,
        version: sessionDetails?.version,
        configFound: !!domainConfig,
        flowsCount: domainConfig?.flows ? Object.keys(domainConfig.flows).length : 0
      }
    });
  }
  const Report: Report = { finalReport: {}, flowErrors: {} };
  const flowsReport: { [flowId: string]: FlowValidationResult } = {}; // Initialize an object to store the final validation report
  const testedFlows = Object.keys(groupedPayloads);
  const MandatoryFlows: string[] = [];
  try {
    // logger.info(`Checking if all the required flows are tested`);
    logInfo({
      message: "Checking if all the required flows are tested",
      meta: { testedFlows },
    });
    // Function to check if a flow is tested or optional
    function checkFlowExistence(testedFlows: string[]) {
      logInfo({
        message: "Checking flow existence",
        meta: { testedFlows },
      });
      const allFlows = Object.keys(domainConfig?.flows);

      // Iterate through all the flows in domainConfig
      for (let i = 0; i < allFlows.length; i++) {
        // If flow is not in testedFlows, check if it's in optional_flows

        if (!Array.isArray(testedFlows)) {
          // logger.error("testedFlows is not an array or is undefined");
          logError({
            message: "testedFlows is not an array or is undefined",
            meta: { testedFlows },
          });
        }

        if (
          !Array.isArray(domainConfig?.optional_flows) &&
          !testedFlows.includes(allFlows[i])
        ) {
          // logger.error(
          //   "domainConfig.optional_flows is not an array or is undefined"
          // );
          logError({
            message: "domainConfig.optional_flows is not an array or is undefined",
            meta: { domainConfig },
          });
          MandatoryFlows.push(allFlows[i]);
        } else if (!testedFlows.includes(allFlows[i])) {
          if (!domainConfig?.optional_flows.includes(allFlows[i])) {
            // Raise an error if flow is not in optional_flows
            MandatoryFlows.push(allFlows[i]);
          }
        }
      }

      if (MandatoryFlows.length > 0)
        Report.finalReport.mandatoryFlows = `${MandatoryFlows} is/are mandatory and should be tested.`;
    }
    checkFlowExistence(testedFlows);
    logInfo({
      message: "Mandatory flows check completed",
      meta: { testedFlows },
    });
  } catch (error: any) {
    // logger.error(`${error?.message}`);
    logError({
      message: `${error?.message}`,
      error,
    });
  }
  // Iterate through each flowId in the grouped payloads
  for (const flowId in groupedPayloads) {
    const requiredSequence = domainConfig?.flows?.[flowId]; // Retrieve the required sequence of actions from config

    const payloads = groupedPayloads[flowId]; // Get the payloads for the current flowId
    const errors: string[] = []; // Initialize an array to store errors for the flow
    const messages: any = {}; // Initialize an object to store validation messages for each action
    let validSequence = true; // Flag to track whether the sequence of actions is valid
    
    logInfo({
      message: `Starting validation for flow: ${flowId}`,
      meta: { 
        flowId,
        payloadCount: payloads.length,
        expectedSequence: requiredSequence,
        actualActions: payloads.map(p => p.action),
        isRetailDomain: sessionDetails?.domain?.startsWith("ONDC:RET")
      },
    });
    // Step 1: Validate Action Sequence for each flow

    try {
      for (let i = 0; i < requiredSequence.length; i++) {
        let expectedAction = requiredSequence[i]; // Get the expected action from the sequence

        const actualAction = payloads[i]?.action; // Get the actual action from the current payload

        // If the actual action does not match the expected action, mark the sequence as invalid
        if (actualAction?.toLowerCase() !== expectedAction) {
          if (expectedAction === "select") expectedAction = `select or init`;
          validSequence = false;
          errors.push(
            `Error: Expected '${expectedAction}' after '${payloads[
              i - 1
            ]?.action.toLowerCase()}', but found '${
              actualAction?.toLowerCase() || "undefined"
            }'.`
          );
          break; // Exit the loop since the sequence is broken
        }
      }
    } catch (error) {
      // logger.error(error);
      logError({
        message: "Error occurred during action sequence validation",
        error,
        meta: { flowId, requiredSequence },
      });
    }
    logInfo({
      message: `Action sequence validation completed for ${flowId}`,
      meta: { flowId },
      });
    // Define counters for each action to keep track of the number of occurrences in the sequence
    const actionCounters: Record<ValidationAction, number> = {
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
      on_track:1
    };
    logInfo({
      message: `Action counters initialized for ${flowId}`,
      meta: { flowId },
    });
    // Step 2: Process Each Payload Using checkMessage
    for (let i = 0; i < payloads.length; i++) {
      const element = payloads[i]; // Get the current payload from the sequence

      // Convert the action to lowercase and check if it's valid
      const action = element?.action.toLowerCase();

      // Ensure the action is valid before proceeding with validation
      if (isValidAction(action)) {
        const domain = element?.jsonRequest?.context?.domain; // Extract domain from the payload for validation

        try {
          // Validate the message based on the domain, payload, and action
          const result = await checkMessage(
            domain,
            element,
            action,
            sessionID,
            flowId,
            domainConfig
          );

          // Store the result in the messages object, using action and counter as keys
          messages[`${action}_${actionCounters[action]}`] =
            JSON.stringify(result);

          // Increment the action counter for this action
          actionCounters[action] += 1;
        } catch (error) {
          // Handle errors that occur during the async validation operation
          // logger.error(
          //   `Error occurred for action ${action} at index ${i}:`,
          //   error
          // );
          logError({
            message: `Error occurred for action ${action} at index ${i}:`,
            error,
            meta: { flowId, action, index: i },
          });
        }
      }
    }
    logInfo({
      message: `Payload processing completed for ${flowId} using checkMessage`,
      meta: { flowId },
    });
    // Step 3: Compile and Store Validation Report for Current Flow
    flowsReport[flowId] = {
      valid_flow: validSequence, // Whether the flow has a valid sequence of actions
      errors, // List of errors encountered in this flow
      messages, // List of validation messages for each action
    };
  }
  Report.flowErrors = flowsReport;

  // Return the final report containing the validation results for all flows
  logInfo({
    message: "Exiting validationModule function. Validation completed.",
    meta: { sessionID, flowsReport },
  });
  return Report;
}
