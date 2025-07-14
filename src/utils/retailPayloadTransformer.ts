import { Payload } from "../types/payload";
import { logger } from "../utils/logger";

export interface RetailExternalPayload {
  domain: string;
  version: string;
  flow: string;
  payload: any[];
}

export function transformRetailPayload(
  payloads: Payload[],
  domain: string,
  version: string,
  flow: string
): RetailExternalPayload {
  logger.info(`[PAYLOAD TRANSFORMER] Starting transformation`, {
    payloadCount: payloads.length,
    domain,
    version,
    flow,
    inputPayloads: payloads.map(p => ({
      action: p.action,
      hasJsonRequest: !!p.jsonRequest,
      hasJsonResponse: !!p.jsonResponse,
      contextDomain: p.jsonRequest?.context?.domain,
      contextAction: p.jsonRequest?.context?.action
    }))
  });

  const transformedPayloads = payloads.map((payload, index) => {
    const transformed = {
      context: payload.jsonRequest?.context || {},
      message: payload.jsonRequest?.message || {},
      response: payload.jsonResponse || {}
    };
    
    logger.info(`[PAYLOAD TRANSFORMER] Payload ${index + 1} transformed`, {
      originalAction: payload.action,
      hasContext: !!transformed.context,
      hasMessage: !!transformed.message,
      hasResponse: !!transformed.response,
      contextAction: transformed.context?.action,
      contextDomain: transformed.context?.domain
    });
    
    return transformed;
  });

  const result = {
    domain,
    version,
    flow,
    payload: transformedPayloads
  };

  logger.info(`[PAYLOAD TRANSFORMER] Transformation completed`, {
    resultStructure: {
      domain: result.domain,
      version: result.version,
      flow: result.flow,
      payloadCount: result.payload.length
    },
    finalPayload: JSON.stringify(result, null, 2)
  });

  return result;
}