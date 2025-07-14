export const actions: String[] = [
  "search",
  "on_search",
  "select",
  "on_select",
  "init",
  "on_init",
  "confirm",
  "on_confirm",
  "cancel",
  "on_cancel",
  "update",
  "on_update",
  "status",
  "on_status",
  "track",
  "on_track",
];

export const MANDATORY_FLOWS: String[] = [
  "STATION_CODE_FLOW",
  "TECHNICAL_CANCELLATION_FLOW",
];

export const BUYER_CANCEL_CODES: String[] = ["001", "002", "003", "004", "005"];

export const SELLER_CANCEL_CODES: String[] = ["011", "012", "013", "014"];
export const ENABLED_DOMAINS: String[] = [
  "ONDC:TRV11",
  "nic2004:60232",
  "ONDC:LOG10",
  "ONDC:LOG11",
  "ONDC:RET10",
  "ONDC:RET11",
  "ONDC:RET12",
  "ONDC:RET13",
  "ONDC:RET14",
];

export const FLOW_MAPPINGS: Record<string, string> = {
  //METRO
  STATION_CODE_FLOW_ORDER: "METRO_STATION_CODE",
  STATION_CODE_FLOW_CATALOG: "METRO_STATION_CODE",
  TECHNICAL_CANCELLATION_FLOW: "METRO_TECHNICAL_CANCEL",
};

export const VALIDATION_URL: Record<string, string> = {
  "ONDC:TRV10": "https://log-validation.ondc.org/api/validate/trv",
  "ONDC:TRV11": "https://log-validation.ondc.org/api/validate/trv",
  "ONDC:RET10": "https://log-validation.ondc.org/api/validate",
  "ONDC:RET11": "https://log-validation.ondc.org/api/validate",
  "ONDC:RET12": "https://log-validation.ondc.org/api/validate",
  "ONDC:RET13": "https://log-validation.ondc.org/api/validate",
  "ONDC:RET14": "https://log-validation.ondc.org/api/validate",
  "ONDC:RET15": "https://log-validation.ondc.org/api/validate",
  "ONDC:RET16": "https://log-validation.ondc.org/api/validate",
  "ONDC:RET17": "https://log-validation.ondc.org/api/validate",
  "ONDC:RET18": "https://log-validation.ondc.org/api/validate",
  "ONDC:FIS12": "https://log-validation.ondc.org/api/validate/fis/fis12",
};

export function compareDates(
  dateString1: string | number | Date,
  dateString2: string | number | Date
) {
  const date1 = new Date(dateString1);
  const date2 = new Date(dateString2);

  const year1 = date1.getUTCFullYear();
  const month1 = date1.getUTCMonth();
  const day1 = date1.getUTCDate();

  const year2 = date2.getUTCFullYear();
  const month2 = date2.getUTCMonth();
  const day2 = date2.getUTCDate();

  if (
    year1 > year2 ||
    (year1 === year2 && month1 > month2) ||
    (year1 === year2 && month1 === month2 && day1 > day2)
  ) {
    return true;
  } else if (
    year1 < year2 ||
    (year1 === year2 && month1 < month2) ||
    (year1 === year2 && month1 === month2 && day1 <= day2)
  ) {
    return false;
  }
}

export const hasTwoOrLessDecimalPlaces = (inputString: string) => {
  const parts = inputString.split(".");

  if (parts.length === 2) {
    const decimalPart = parts[1];
    return decimalPart.length <= 2;
  } else {
    return true; // No decimal part, automatically satisfies the condition
  }
};

type TagListItem = {
  code: string;
  value: string;
};

type Tag = {
  code: string;
  list: TagListItem[];
};

type FlowCodeRequirement = {
  flowId: string;
  code: string;
};

export function validateLSPFeaturesForFlows(
  currentFlowId: string,
  requirements: FlowCodeRequirement[],
  catalogTags: Tag[]
): boolean {
  // Filter requirements that apply to the current flow
  const relevantRequirements = requirements.filter(
    (req) => req.flowId === currentFlowId
  );

  // If no relevant rules exist for this flowId, it's valid
  if (relevantRequirements.length === 0) {
    return true;
  }

  // Get the lsp_features tag
  const lspFeaturesTag = catalogTags.find((tag) => tag.code === "lsp_features");
  if (!lspFeaturesTag || !Array.isArray(lspFeaturesTag.list)) {
    return false;
  }

  // Check that all required codes exist with value "yes"
  return relevantRequirements.every((req) =>
    lspFeaturesTag.list.some(
      (item) => item.code === req.code && item.value.toLowerCase() === "yes"
    )
  );
}

export function validateLBNPFeaturesForFlows(
  currentFlowId: string,
  requirements: FlowCodeRequirement[],
  intentTags: Tag[]
): boolean {
  // Filter requirements that apply to the current flow
  const relevantRequirements = requirements.filter(
    (req) => req.flowId === currentFlowId
  );

  // If no relevant rules exist for this flowId, it's valid
  if (relevantRequirements.length === 0) {
    return true;
  }

  // Get the lsp_features tag
  const lbnpFeaturesTag = intentTags.find(
    (tag) => tag.code === "lbnp_features"
  );
  if (!lbnpFeaturesTag || !Array.isArray(lbnpFeaturesTag.list)) {
    return false;
  }

  // Check that all required codes exist with value "yes"
  return relevantRequirements.every((req) =>
    lbnpFeaturesTag.list.some(
      (item) => item.code === req.code && item.value.toLowerCase() === "yes"
    )
  );
}
export const rules = [
  { flowId: "CASH_ON_DELIVERY_FLOW", code: "008" },
  { flowId: "PREPAID_PAYMENT_FLOW", code: "00D" },
  { flowId: "WEIGHT_DIFFERENTIAL_FLOW", code: "021" },
  { flowId: "PICKUP_DELIVERY_ATTEMPT", code: "00E" },
];

export const LSPfeatureFlow = [
  "CASH_ON_DELIVERY_FLOW",
  "PREPAID_PAYMENT_FLOW",
  "WEIGHT_DIFFERENTIAL_FLOW",
  "PICKUP_DELIVERY_ATTEMPT",
];

export const LBNPfeatureFlow = [
  "WEIGHT_DIFFERENTIAL_FLOW",
  "PICKUP_DELIVERY_ATTEMPT",
];

export const statesAfterPickup = [
  "Order-picked-up",
  "In-transit",
  "At-destination-hub",
  "At-delivery",
  "Delivery-rescheduled",
  "Order-delivered"
];
