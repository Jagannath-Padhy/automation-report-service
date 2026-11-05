import { TestResult } from "../../../types/payload";

// IGM 2.0.0 Constants
export const VALID_ISSUE_STATUSES = ["OPEN", "PROCESSING", "RESOLVED", "CLOSED"];
// "GREVIENCE" (not the dictionary-correct "GRIEVANCE") is the actual value
// used throughout this project's live stack: the compiled JVAL spec
// (validations/RET1X/*/index.yaml, every domain/version) enumerates
// message.issue.level as exactly ["ISSUE", "GREVIENCE"], and real recorded
// on_issue/issue traffic in this workspace uses "GREVIENCE" and gets ACKed
// by the live API_SERVICE — confirmed a historical typo baked into the
// deployed spec/mock stack, not a typo in the test data. (Note:
// log-validation-utility's own AJV schema for this field says "GRIEVANCE" —
// that source disagrees with what's actually live here.)
export const VALID_ISSUE_LEVELS = ["ISSUE", "GREVIENCE"];
export const VALID_ACTION_CODES = [
  "OPEN", "PROCESSING", "INFO_REQUESTED", "INFO_PROVIDED",
  "RESOLUTION_PROPOSED", "RESOLUTION_ACCEPTED", "RESOLUTION_REJECTED",
  "ESCALATED", "RESOLVED", "CLOSE", "CLOSED"
];
export const VALID_ACTOR_TYPES = [
  "CONSUMER", "INTERFACING_NP", "COUNTERPARTY_NP", "COUNTERPARTY_NP_GRO",
  "CASCADED_COUNTERPARTY_NP", "CASCADED_COUNTERPARTY_NP_GRO"
];
export const VALID_REF_TYPES = ["ORDER", "PROVIDER", "FULFILLMENT", "ITEM", "TRANSACTION"];
export const VALID_RESOLUTION_CODES = ["REFUND", "REPLACEMENT", "PARENT", "NO_ACTION", "COUPON"];

// IGM 1.0.0 Constants
export const VALID_IGM1_CATEGORIES = ["ITEM", "FULFILLMENT"];
export const VALID_IGM1_ITEM_SUBCATEGORIES = [
  "ITM01", "ITM02", "ITM03", "ITM04", "ITM05", "ITM06", "ITM07", "ITM08"
];
export const VALID_IGM1_FULFILLMENT_SUBCATEGORIES = [
  "FLM01", "FLM02", "FLM03", "FLM04", "FLM05", "FLM06", "FLM07", "FLM08"
];
export const VALID_IGM1_STATUSES = ["OPEN", "CLOSED"];
export const VALID_IGM1_ISSUE_TYPES = ["ISSUE", "GRIEVANCE", "DISPUTE"];
export const VALID_IGM1_COMPLAINANT_ACTIONS = ["OPEN", "ESCALATE", "CLOSE"];
export const VALID_IGM1_RESPONDENT_ACTIONS = ["PROCESSING", "CASCADED", "RESOLVED", "NEED-MORE-INFO"];
export const VALID_IGM1_SOURCE_TYPES = ["CONSUMER", "SELLER", "INTERFACING NP"];
export const VALID_IGM1_RESOLUTION_ACTIONS = [
  "REFUND", "REPLACEMENT", "CANCEL", "NO-ACTION", "RECONCILED", "NOT-RECONCILED"
];
export const VALID_IGM1_RESPONDENT_TYPES = [
  "INTERFACING-NP", "TRANSACTION-COUNTERPARTY-NP", "CASCADED-COUNTERPARTY-NP"
];
export const VALID_IGM1_GRO_TYPES = [
  "INTERFACING-NP-GRO", "TRANSACTION-COUNTERPARTY-NP-GRO", "CASCADED-COUNTERPARTY-NP-GRO"
];
