import { TestResult } from "../../../types/payload";
import mandatoryFieldsConfig from "./mandatoryFieldsConfig.json";
import { Trv14FlowProfile } from "./flowProfiles";

const MANDATORY_FIELDS: Record<string, string[]> = mandatoryFieldsConfig.fields;

/**
 * Every value reached by a dotted JSONPath ("$.message.order.items.descriptor"),
 * descending into arrays at any level. Returns [] when any segment is missing.
 */
function collectValues(root: any, path: string): any[] {
  let current: any[] = [root];
  for (const key of path.replace(/^\$\./, "").split(".")) {
    const next: any[] = [];
    for (const node of current) {
      const children = Array.isArray(node) ? node : [node];
      for (const child of children) {
        if (child && typeof child === "object" && key in child) next.push(child[key]);
      }
    }
    current = next.flatMap((v) => (Array.isArray(v) ? v : [v]));
    if (current.length === 0) return [];
  }
  return current;
}

function isFilled(value: any): boolean {
  return value !== undefined && value !== null && value !== "";
}

/**
 * Workbench-mandatory fields that the workbench L1 does not check for presence
 * (mandatoryFields.json). Every element along an array path must carry the field.
 */
export function checkTrv14MandatoryFields(
  jsonRequest: any,
  action: string,
  profile: Trv14FlowProfile,
  testResults: TestResult
): void {
  if (jsonRequest?.error) return;

  if (action === "status") {
    // Technical cancellation: the buyer app never received the order id, so the
    // workbench asks for status by ref_id (= transaction_id) instead of order_id.
    if (profile.postConfirm === "TECH_CANCEL") {
      const refId = jsonRequest?.message?.ref_id;
      const txnId = jsonRequest?.context?.transaction_id;
      if (refId && refId === txnId) {
        testResults.passed.push("status: message.ref_id equals context.transaction_id");
      } else {
        testResults.failed.push(
          `status: message.ref_id must equal context.transaction_id in a technical cancellation flow (got '${refId}')`
        );
      }
    } else if (isFilled(jsonRequest?.message?.order_id)) {
      testResults.passed.push("status: message.order_id is present");
    } else {
      testResults.failed.push("status: message.order_id is mandatory");
    }
    return;
  }

  for (const path of MANDATORY_FIELDS[action] ?? []) {
    const values = collectValues(jsonRequest, path);
    if (values.length > 0 && values.every(isFilled)) {
      testResults.passed.push(`${action}: ${path} is present`);
    } else {
      testResults.failed.push(`${action}: ${path} is mandatory`);
    }
  }
}
