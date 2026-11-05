import { Payload, TestResult } from "../../../types/payload";
import issue from "../../ONDC:FIS13/2.0.0/issue";
import on_issue from "../../ONDC:FIS13/2.0.0/OnIssue";
import issue_status from "../../ONDC:FIS13/2.0.0/IssueStatus";
import on_issue_status from "../../ONDC:FIS13/2.0.0/OnIssueStatus";

const IGM_HANDLERS: Record<string, Function> = {
  issue,
  on_issue,
  issue_status,
  on_issue_status,
};

/**
 * IGM payloads carry the IGM version (1.0.0 / 2.0.0) in context, not the domain
 * version, so they can't be routed to `<domain>/<version>/<action>` files. Finance
 * domains use this shared handler instead.
 */
export function getIgmHandler(action: string | undefined): Function | undefined {
  return action ? IGM_HANDLERS[action.toLowerCase()] : undefined;
}

export function isFinanceDomain(domain: string | undefined): boolean {
  return !!domain && domain.startsWith("ONDC:FIS");
}

export async function runIgmAction(
  handler: Function,
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  return handler(element, sessionID, flowId, actionId);
}
