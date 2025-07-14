import { Payload, WrappedPayload } from "../types/payload";
import { loadConfig } from "../utils/configLoader"; // Importing function to load configuration for validation modules
import { logError, logger, logInfo } from "../utils/logger";

// A function to dynamically load and execute a validation function based on the provided module path and function name
const dynamicValidator = (
  modulePathWithFunc: string, // The full path to the module and function (e.g., 'module#function')
  element: any, // The payload or element to be validated
  action: string, // The action to be validated (e.g., 'search', 'init')
  sessionID: string,
  flowId: string
) => {
  logInfo({
    message: "Entering dynamicValidator function.",
    meta: { modulePathWithFunc, element, action, sessionID, flowId },
  });
  // Splitting the modulePathWithFunc string into module path and function name
  const [modulePath, functionName] = modulePathWithFunc.split("#");

  try {
    // Dynamically require the module using the resolved path
    const validatorModule = require(modulePath);

    // Retrieve the validation function from the module
    const validatorFunc = functionName ? validatorModule[functionName] : null;

    // If the function exists and is valid, invoke it with the element and action
    if (typeof validatorFunc === "function") {
      logInfo({
        message: "Exiting dynamicValidator function.",
        meta: { modulePath, functionName, element, action },
      });
      return validatorFunc(element, action, sessionID, flowId);
    } else {
      // Throw an error if the function is not found within the module
      logError({
        message: `Validator function '${functionName}' not found in '${modulePath}'`,
        meta: { modulePath, functionName },
      });
      throw new Error(
        `Validator function '${functionName}' not found in '${modulePath}'`
      );
    }
  } catch (error) {
    // Log any error encountered while loading the module or executing the function
    // logger.error("Error loading validator:", error);
    logError({
      message: "Error in dynamicValidator function. ",
      error,
      meta: { modulePath, functionName },
    });
    throw error; // Rethrow the error to be handled by the calling function
  }
};

// Main function that checks the message validation based on the domain and action
export const checkMessage = async (
  domain: string, // The domain (e.g., 'search', 'select') to determine the appropriate validation module
  element: Payload, // The payload or element to be validated
  action: string, // The specific action to be validated (e.g., 'init', 'confirm')
  sessionId: string,
  flowId: string,
  domainConfig: any
): Promise<object> => {
  const isRetailDomain = domain?.startsWith("ONDC:RET");
  
  logInfo({
    message: "[CHECK MESSAGE] Starting message validation",
    meta: { 
      domain, 
      action, 
      sessionId, 
      flowId,
      isRetailDomain,
      messageId: element?.jsonRequest?.context?.message_id,
      transactionId: element?.jsonRequest?.context?.transaction_id
    },
  });
  
  // Get the module path and function name based on the version, or fall back to the default configuration
  const modulePathWithFunc = domainConfig?.validationModules;
  
  logInfo({
    message: "[CHECK MESSAGE] Routing to validator",
    meta: { 
      modulePathWithFunc,
      isRetailValidator: modulePathWithFunc?.includes("retail/validator"),
      domain,
      action
    },
  });
  
  // Call the dynamicValidator to load and execute the validation function for the given domain, element, and action
  const result = await dynamicValidator(
    modulePathWithFunc,
    element,
    action,
    sessionId,
    flowId
  );
  
  logInfo({
    message: "[CHECK MESSAGE] Validation completed",
    meta: {
      domain,
      action,
      isRetailDomain,
      hasResult: !!result
    }
  });
  
  return result;
};
