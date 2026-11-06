import { Payload } from "../types/payload";
import { sortPayloadsByCreatedAt } from "./groupUtils";

/**
 * Adapts a downloaded workbench logs file into the `Payload[]` shape the report pipeline
 * reads from the DB, so validationModule can run on it unchanged.
 *
 * File shape: an array of `{ req, res, signature }` — `req` is the full request (with
 * `context`), `res` is `{ response: { context, message: { ack } } }` (the DB `jsonResponse`
 * shape). The `{ request, response }` shape produced by mapPayloadsToLogFormat is accepted too.
 */

export interface LogEntry {
  req: Record<string, any>;
  res?: Record<string, any>;
  action_id?: string;
}

export class LogsInputError extends Error {}

export function parseLogsFile(raw: unknown): LogEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new LogsInputError("Logs file must be a non-empty JSON array of { req, res } entries.");
  }

  const entries: LogEntry[] = raw.map((item: any, index: number) => {
    const req = item?.req ?? item?.request;
    if (!req?.context?.action) {
      throw new LogsInputError(`Log entry ${index + 1} has no req.context.action.`);
    }
    // mapPayloadsToLogFormat strips the `{ response }` wrapper; restore it so both shapes match.
    const res = item?.res ?? (item?.response ? { response: item.response } : undefined);
    return { req, res, action_id: item?.action_id || undefined };
  });

  const txnIds = [...new Set(entries.map((e) => e.req.context.transaction_id))];
  if (txnIds.length !== 1) {
    throw new LogsInputError(
      `Logs file must contain exactly one transaction, found ${txnIds.length}: ${txnIds.join(", ")}.`
    );
  }

  return entries;
}

export function detectDomainVersion(entries: LogEntry[]): { domain: string; version: string } {
  const context = entries[0].req.context;
  return { domain: context.domain, version: context.version ?? context.core_version };
}

export function logsToPayloads(entries: LogEntry[], flowId: string): Payload[] {
  const payloads: Payload[] = entries.map((entry, index) => {
    const context = entry.req.context;
    return {
      id: index + 1,
      messageId: context.message_id,
      transactionId: context.transaction_id,
      flowId,
      action: context.action,
      action_id: entry.action_id ?? null,
      bppId: context.bpp_id ?? null,
      bapId: context.bap_id,
      payloadId: `${context.transaction_id}:${index}`,
      jsonRequest: entry.req,
      jsonResponse: entry.res ?? {},
      httpStatus: 200,
      createdAt: context.timestamp,
      updatedAt: context.timestamp,
      sessionDetails: {},
    };
  });
  return sortPayloadsByCreatedAt({ [flowId]: payloads })[flowId];
}

/**
 * Fills in `action_id` by aligning payloads (in order) with the flow's configured steps:
 * each payload takes the first not-yet-used step at or after the cursor whose action
 * matches. Forward-only, so repeated actions (the six on_status legs) map in order.
 * A payload that already has an action_id keeps it; one with no matching step (or a flow
 * with no configured action_ids) falls back to its action, as checkPayload does.
 */
export function assignActionIds(
  payloads: Payload[],
  sequence: string[] = [],
  actionIds?: string[]
): Payload[] {
  let cursor = 0;
  for (const payload of payloads) {
    const action = payload.action?.toLowerCase();
    let matched: string | undefined;
    if (actionIds) {
      for (let k = cursor; k < sequence.length; k++) {
        if (sequence[k]?.toLowerCase() === action) {
          matched = actionIds[k];
          cursor = k + 1;
          break;
        }
      }
    }
    if (!payload.action_id) payload.action_id = matched ?? payload.action;
  }
  return payloads;
}
