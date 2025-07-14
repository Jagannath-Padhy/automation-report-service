import { ValidationAction } from "../../types/actions";
import { TestResult, Payload } from "../../types/payload";
import { logger } from "../../utils/logger";
import { transformRetailPayload } from "../../utils/retailPayloadTransformer";
import axios from "axios";

const EXTERNAL_API_URL = "https://log-validation.ondc.org/api/validate";
const TIMEOUT_MS = 30000;

export const validate = async (
  element: Payload,
  action: ValidationAction,
  sessionID: string,
  flowId: string,
  domainConfig?: any
): Promise<TestResult> => {
  let testResults: TestResult = { response: {}, passed: [], failed: [] };

  try {
    const domain = element?.jsonRequest?.context?.domain;
    const version = element?.jsonRequest?.context?.version || "1.2.5";
    const messageId = element?.jsonRequest?.context?.message_id;
    const transactionId = element?.jsonRequest?.context?.transaction_id;

    logger.info(`[RETAIL VALIDATOR] Starting validation`, {
      domain,
      version,
      action,
      flowId,
      sessionID,
      messageId,
      transactionId
    });

    // For retail domains, we validate using external API
    if (!domain || !domain.startsWith("ONDC:RET")) {
      logger.error(`[RETAIL VALIDATOR] Invalid domain: ${domain}`);
      testResults.failed.push("Invalid or missing retail domain");
      return testResults;
    }

    // Transform the payload for external validation
    const externalPayload = transformRetailPayload([element], domain, version, flowId);

    logger.info(`[RETAIL VALIDATOR] Payload transformed for external API`, {
      domain,
      version,
      flowId,
      action,
      payloadStructure: {
        hasContext: !!externalPayload.payload[0]?.context,
        hasMessage: !!externalPayload.payload[0]?.message,
        hasResponse: !!externalPayload.payload[0]?.response
      }
    });

    logger.info(`[RETAIL VALIDATOR] Sending request to external API`, {
      url: EXTERNAL_API_URL,
      method: 'POST',
      timeout: TIMEOUT_MS,
      requestPayload: JSON.stringify(externalPayload, null, 2)
    });

    try {
      const response = await axios.post(EXTERNAL_API_URL, externalPayload, {
        timeout: TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
        },
      });

      logger.info(`[RETAIL VALIDATOR] External API response received`, {
        status: response.status,
        hasData: !!response.data,
        dataKeys: response.data ? Object.keys(response.data) : [],
        responseBody: JSON.stringify(response.data, null, 2)
      });

      if (response.status === 200 && response.data) {
        const validationResult = response.data;
        
        // Convert external API response to internal format
        if (validationResult.passed && Array.isArray(validationResult.passed)) {
          testResults.passed.push(...validationResult.passed);
          logger.info(`[RETAIL VALIDATOR] Tests passed: ${validationResult.passed.length}`);
        }
        
        if (validationResult.failed && Array.isArray(validationResult.failed)) {
          testResults.failed.push(...validationResult.failed);
          logger.info(`[RETAIL VALIDATOR] Tests failed: ${validationResult.failed.length}`);
        }
        
        if (validationResult.errors && Array.isArray(validationResult.errors)) {
          testResults.failed.push(...validationResult.errors);
          logger.info(`[RETAIL VALIDATOR] Errors found: ${validationResult.errors.length}`);
        }

        // Store the external response
        testResults.response = validationResult;
        
        logger.info(`[RETAIL VALIDATOR] Validation completed`, {
          domain,
          action,
          flowId,
          totalPassed: testResults.passed.length,
          totalFailed: testResults.failed.length
        });
      } else {
        testResults.failed.push("External API returned invalid response");
      }

    } catch (apiError: any) {
      logger.error(`[RETAIL VALIDATOR] External API error for ${domain}`, {
        message: apiError.message,
        status: apiError.response?.status,
        statusText: apiError.response?.statusText,
        errorResponseBody: apiError.response?.data ? JSON.stringify(apiError.response.data, null, 2) : 'No response body',
        requestUrl: EXTERNAL_API_URL,
        requestPayload: JSON.stringify(externalPayload, null, 2)
      });
      
      if (apiError.code === 'ECONNABORTED') {
        testResults.failed.push("External validation timeout");
      } else if (apiError.response) {
        const errorDetail = apiError.response.data ? JSON.stringify(apiError.response.data) : apiError.response.statusText;
        testResults.failed.push(`External API error: ${apiError.response.status} - ${errorDetail}`);
      } else {
        testResults.failed.push(`External validation failed: ${apiError.message}`);
      }
    }

    return testResults;

  } catch (error: any) {
    logger.error(`Error during retail validation: ${error.message}`);
    return {
      response: {},
      passed: [],
      failed: [`Error during ${action} validation: ${error.message}`],
    };
  }
};