import { TestResult } from "../../../types/payload";

// Order / fulfillment / payment state each workbench step must carry. Source of
// truth: the payloads ONDC-Official/automation-specifications draft-TRV14-2.0.0
// (commit ca523e5f) generates for every flow — each action_id produces exactly
// one combination there. Payment type is left to L1 (its enum is PRE_ORDER only).
export interface Trv14ExpectedState {
  orderStatus?: string;
  fulfillmentState?: string;
  paymentStatus?: string;
}

export const TRV14_STATE_TABLE: Record<string, Trv14ExpectedState> = {
  init: { paymentStatus: "NOT-PAID" },
  on_init: { paymentStatus: "NOT-PAID" },
  "init_bap_ convenience": { paymentStatus: "NOT-PAID" },
  "on_init_bap_ convenience": { paymentStatus: "NOT-PAID" },
  confirm: { paymentStatus: "PAID" },
  "confirm_bap_ convenience": { paymentStatus: "PAID" },
  on_confirm: { orderStatus: "ACTIVE", fulfillmentState: "CONFIRMED", paymentStatus: "PAID" },
  on_confirm_technical_cancellation: { orderStatus: "ACTIVE", fulfillmentState: "CONFIRMED", paymentStatus: "PAID" },
  on_status: { orderStatus: "COMPLETED", fulfillmentState: "COMPLETED", paymentStatus: "PAID" },
  on_status_technical_cancellation: { orderStatus: "ACTIVE", fulfillmentState: "CONFIRMED", paymentStatus: "PAID" },
  on_cancel_soft_user_cancellation: { orderStatus: "SOFT_CANCEL", fulfillmentState: "CONFIRMED", paymentStatus: "PAID" },
  on_cancel_confirm_user_cancellation: { orderStatus: "CANCELLED", fulfillmentState: "CONFIRMED", paymentStatus: "PAID" },
  on_cancel_soft_technical_cancellation: { orderStatus: "SOFT_CANCEL", fulfillmentState: "CONFIRMED", paymentStatus: "PAID" },
  on_cancel_confirm_technical_cancellation: { orderStatus: "CANCELLED", fulfillmentState: "CONFIRMED", paymentStatus: "PAID" },
  on_cancel_unsolicited: { orderStatus: "CANCELLED", fulfillmentState: "CONFIRMED", paymentStatus: "PAID" },
  on_update_soft_partial_cancellation: { orderStatus: "SOFT_CANCEL", fulfillmentState: "CONFIRMED", paymentStatus: "PAID" },
  on_update_confirm_partial_cancellation: { orderStatus: "ACTIVE", fulfillmentState: "CONFIRMED", paymentStatus: "PAID" },
};

/** Checks the payload against the state its workbench step must carry. */
export function checkTrv14State(jsonRequest: any, actionId: string, testResults: TestResult): void {
  const expected = TRV14_STATE_TABLE[actionId];
  if (!expected || jsonRequest?.error) return;
  const order = jsonRequest?.message?.order;
  const action = jsonRequest?.context?.action;

  if (expected.orderStatus) {
    if (order?.status === expected.orderStatus) {
      testResults.passed.push(`${action}: order.status is ${expected.orderStatus}`);
    } else {
      testResults.failed.push(
        `${action} (${actionId}): order.status must be ${expected.orderStatus}, found '${order?.status}'`
      );
    }
  }

  if (expected.fulfillmentState) {
    const states = (order?.fulfillments ?? [])
      .map((f: any) => f?.state?.descriptor?.code)
      .filter((s: any) => s !== undefined);
    if (states.length > 0 && states.every((s: string) => s === expected.fulfillmentState)) {
      testResults.passed.push(`${action}: fulfillments[].state is ${expected.fulfillmentState}`);
    } else {
      testResults.failed.push(
        `${action} (${actionId}): every fulfillments[].state.descriptor.code must be ${expected.fulfillmentState}, found [${states.join(", ")}]`
      );
    }
  }

  if (expected.paymentStatus) {
    const statuses = (order?.payments ?? []).map((p: any) => p?.status);
    if (statuses.length > 0 && statuses.every((s: string) => s === expected.paymentStatus)) {
      testResults.passed.push(`${action}: payments[].status is ${expected.paymentStatus}`);
    } else {
      testResults.failed.push(
        `${action} (${actionId}): every payments[].status must be ${expected.paymentStatus}, found [${statuses.join(", ")}]`
      );
    }
  }
}
