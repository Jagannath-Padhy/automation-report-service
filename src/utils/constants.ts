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
  "issue",
  "on_issue",
  "issue_status",
  "on_issue_status",
];

export const MANDATORY_FLOWS: String[] = [
  "STATION_CODE_FLOW",
  "TECHNICAL_CANCELLATION_FLOW",
];

export const GOLD_LOAN_FLOWS = ["Gold_Loan_With_Account_Aggregator", "Gold_Loan_Without_Account_Aggregator", "Gold_Loan_Foreclosure,Gold_Loan_Missed_EMI", "Gold_Loan_Pre_Part_Payment"]
export const PAYMENT_COLLECTED_BY = ['BPP', 'BAP']
export const PERSONAL_LOAN_FLOWS = [
  "Personal_Loan_With_AA_And_Monitoring_Consent",
  "Personal_Loan_Without_AA_And_Monitoring_Consent",
  "Personal_Loan_Without_Acount_Monitoring",
  "Personal_Loan_Offline",
  "Personal_Loan_Offline_And_Online",
  "Personal_Loan_Foreclosure",
  "Personal_Loan_Missed_EMI",
  "Personal_Loan_Pre_Part_Payment",
  "Personal_Loan_Multiple_Offers"
]

export const CREDIT_CARD_FLOWS = ["Credit_card"]

export const PURCHASE_FINANCE_FLOWS = [
  "Purchase_Finance_Without_AA",
  "Purchase_Finance_Single_Redirection_Without_AA",
  "Purchase_Finance_Without_AA_Multiple_Offer",
  "Purchase_Finance_Without_AA_Loan_Foreclosure",
  "Purchase_Finance_Without_AA_Missed_EMI_Payment",
  "Purchase_Finance_Without_AA_Pre_Part_Payment",
  "Purchase_Finance_Without_AA_Cancellation",
  "Purchase_Finance_With_AA",
  "Purchase_Finance_Single_Redirection_With_AA",
  "Purchase_Finance_With_AA_Multiple_Offer",
  "Purchase_Finance_With_AA_Loan_Foreclosure",
  "Purchase_Finance_With_AA_Missed_EMI_Payment",
  "Purchase_Finance_With_AA_Pre_Part_Payment",
  "Purchase_Finance_With_AA_Cancellation"
]

export const UNIFIED_CREDIT_FLOWS = [
  "business_term_loan_with_offline_online",
  "lamf_credit_line_with_mfc_offline_journey",
  "credit_offline",
  "offline_journey",
  "master_search",
  "business_term_loan_without_aa",
  "lamf_credit_line_with_mfc"
]

export const PURCHASE_FINANCE_FLOWS_SKIP_VALIDATION = [
  "Purchase_Finance_With_AA_Loan_Foreclosure",
  "Purchase_Finance_With_AA_Missed_EMI_Payment",
  "Purchase_Finance_With_AA_Pre_Part_Payment",
  "Purchase_Finance_Without_AA_Loan_Foreclosure",
  "Purchase_Finance_Without_AA_Missed_EMI_Payment",
  "Purchase_Finance_Without_AA_Pre_Part_Payment",
]

export const HEALTH_INSURANCE_FLOWS = [
  "Health_Insurance_Application(Individual)",
  "Health_Insurance_Application(PRE-ORDER-Individual)",
  "Claim_Health_Insurance(Individual)",
  "Renew_Health_Insurance(Individual)",
  "Cancel_Health_Insurance(Individual)",
  "Health_Insurance_Application(Family)",
  "Health_Insurance_Application(PRE-ORDER-Family)",
  "Claim_Health_Insurance(Family)",
  "Renew_Health_Insurance(Family)",
  "Cancel_Health_Insurance(Family)"
]

export const GIFT_CARD_FLOWS = [
  "Seller_App_Fulfilling",
  "Buyer_App_Fulfilling_Code_On_Confirm",
  "Buyer_App_Fulfilling_Code_On_Update",
  "Physical_Store_Based_Gift_Cards",
  "Seller_Cancellation",
  "Update_Receiver_Info"
];

export const SACHET_INSURANCE_FLOWS = [
  "Discovery_of_Insurer_Providers_and_Master_Policies",
  "Discovery_of_Products_from_Master_Policies (Accidental Insurance)",
  "Purchase_Journey_Accidental_Insurance",
  "CD_Balance_Error_Accidental_Insurance"
]


export const SACHET_INSURANCE_FLOWS_OBJ = {
  Discovery_of_Insurer_Providers_and_Master_Policies: "Discovery_of_Insurer_Providers_and_Master_Policies",
  Discovery_of_Products_from_Master_Policies: "Discovery_of_Products_from_Master_Policies (Accidental Insurance)",
  Purchase_Journey_Accidental_Insurance: "Purchase_Journey_Accidental_Insurance",
  CD_Balance_Error_Accidental_Insurance: "CD_Balance_Error_Accidental_Insurance"
}

export const MOTOR_INSURANCE_FLOWS = [
  "Motor_Insurance_Application",
  "Motor_Insurance_Application(PRE-ORDER)",
  "Claim_Motor_Insurance",
  "Cancel_Motor_Insurance"
]

export const MOTOR_INSURANCE_SELECT_ACTIONS = [
  "select_motor",
  "select2_motor",
  "select3_motor"
]

export const MOTOR_INSURANCE_INIT_ACTIONS = [
  "init_motor",
  "init2_motor",
  "init3_motor"
]

export const MOTOR_INSURANCE_CONFIRM_ACTIONS = [
  "confirm_motor",
  "confirm2_motor",
  "confirm3_motor"
]
export const ITEM_PRICE_NOT_REQUIRED_FIS13 = [
  "on_search", "on_search2", "on_search3", "select", "select2", "init", "init2", "init3"
]



export const validCategoryMap: Record<string, string> = {
  GOLD_LOAN: "Gold Loan",
  BUREAU_LOAN: "Bureau Loan",
  AA_LOAN: "Account Aggregator Loan",
  PERSONAL_LOAN: "Personal Loan",
  AA_PERSONAL_LOAN: "Account Aggregator Personal Loan"
};

export const BUYER_CANCEL_CODES: String[] = ["001", "002", "003", "004", "005"];

export const SELLER_CANCEL_CODES: String[] = ["011", "012", "013", "014"];

export const ENABLED_DOMAINS: String[] = [
  "ONDC:LOG10:1.2.5",
  "ONDC:LOG11:1.2.5",
  "ONDC:FIS10:2.1.0",
  "ONDC:FIS11:2.0.0",
  "ONDC:FIS12:2.0.2",
  "ONDC:FIS12:2.0.3",
  "ONDC:FIS12:2.2.1",
  "ONDC:FIS12:2.2.0",
  "ONDC:FIS12:2.0.1",
  "ONDC:FIS12:2.3.0",
  "ONDC:FIS13:2.0.1",
  // "ONDC:FIS13:2.0.0:hospicash-insurance",
  // "ONDC:FIS13:2.0.0:accidental-insurance",
  "ONDC:TRV10:2.1.0",
  "ONDC:TRV11:2.0.1",
  "ONDC:TRV11:2.1.0",
  "ONDC:TRV13:2.0.1",
  "ONDC:FIS14:2.1.0"
];

// Usecase-level enabling: Map of domain:version -> allowed usecases
// If a domain:version is in ENABLED_DOMAINS but not in this map, all usecases are allowed
// If present in this map, only listed usecases will use internal validations
export const ENABLED_USECASES: Record<string, string[]> = {
  "ONDC:TRV11:2.0.0": ["metro"],  // Only Metro enabled for 2.0.0
  "ONDC:TRV11:2.0.1": ["metro"],  // Only Metro enabled for 2.0.1, Bus will use Pramaan
  "ONDC:TRV11:2.1.0": ["metro", "bus"],  // Metro and Bus enabled for 2.1.0
};

export const DOMAINS = {
  NIC: "nic2004:60232",
  LOG10: "ONDC:LOG10",
  LOG11: "ONDC:LOG11",
  FIS11: "ONDC:FIS11",
  FIS12: "ONDC:FIS12",
  TRV10: "ONDC:TRV10",
  TRV11: "ONDC:TRV11",
  TRV13: "ONDC:TRV13"
};

export const FLOW_MAPPINGS: Record<string, string> = {
  //METRO
  STATION_CODE_FLOW_ORDER: "METRO_STATION_CODE",
  STATION_CODE_FLOW_CATALOG: "METRO_STATION_CODE",
  TECHNICAL_CANCELLATION_FLOW: "METRO_TECHNICAL_CANCEL",
};

export const DOMAINS_WITH_VERSION = {
  FIS13: "ONDC:FIS13",
  FIS13_VERSION: "2.0.0"
};

export const VALIDATION_URL: Record<string, string> = {
  "ONDC:TRV10": "https://log-validation.ondc.org/api/validate/trv",
  "ONDC:TRV11": "https://log-validation.ondc.org/api/validate/trv",
  "ONDC:RET10": "https://log-validation.ondc.org/api/validate",
  "ONDC:RET11": "https://log-validation.ondc.org/api/validate",
  "ONDC:RET12": "https://log-validation.ondc.org/api/validate",
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
  const lbnpFeaturesTag = intentTags?.find(
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

export const FLOW_ID_MAP: Record<
  string,
  Record<
    string,
    Record<
      string,
      Record<string, string>
    >
  >
> = {
  "ONDC:TRV11": {
    "2.0.0": {
      "Bus": {
        "ORDER_TO_CONFIRM_TO_JOURNEY_COMPLETION": "MBL_8",
        "TECHNICAL_CANCELLATION_FLOW": "MBL_11",
        "USER_CANCELLATION_FLOW": "MBL_12"
      },
      "Metro": {
        "ORDER_TO_CONFIRM_TO_JOURNEY_COMPLETION_SJT": "MBL_1",
        "ORDER_TO_CONFIRM_TO_JOURNEY_COMPLETION_RJT": "MBL_2",
        "USER_CANCELLATION_FLOW": "MBL_4",
        // "TICKET_EXPIRY_CANCELLATION_FLOW": "MBL_5",
        // "MERCHANT_SIDE_CANCELLATION_FLOW": "MBL_6",
        // "ORDER_TO_CONFIRM_MONTHLY_PASS": "MBL_3",
        "TECHNICAL_CANCELLATION_FLOW": "MBL_20",
      }
    },
    "2.0.1": {
      "Bus": {
        "IntraCity_Purchase_Journey_Flow_Code_Based": "MBL_8",
        "IntraCity_User_Cancellation_Flow": "MBL_11",
        "IntraCity_Technical_Cancellation_Flow": "MBL_12",
        "IntraCity_Monthly_Passes_Flow_Code_Based": "MBL_10",
        "IntraCity_Merchant_Side_Cancellation": "MBL_13"
      }
    }
  },
  "ONDC:TRV10": {
    "2.0.1": {
      "Ride-hailing": {
        "OnDemand_Assign_driver_on_onconfirm": "DEM_2A",
        "OnDemand_Assign_driver_post_onconfirm": "DEM_2B",
        "OnDemand_Assign_driver_post_onconfirmSelfPickup": "DEM_6",
        "Technical_cancellation_flow": "DEM_4",
        // "OnDemand_Female_driver_flow": "TRV10_4",
        "OnDemand_Ride_cancellation_by_driver": "DEM_3",
        "OnDemand_Ride_cancellation_by_rider": "DEM_2",
        "Driver_not_found_on_onconfirm": "DEM_1A",
        "Driver_not_found_post_onconfirm": "DEM_1B",
        // "OnDemand_Assign_driver_on_onconfirm_with_IGM(1.0.0)": "TRV10_9"
      }
    }
  },
  "ONDC:TRV13": {
    "2.0.0": {
      "Hotel-Booking": {
        "Order to Confirm to Fulfillment (City Based)": "ACM_1",
        "Incremental Catalog refresh": "ACM_2",
        "Order to Confirm to Fulfillment (Time range Based)": "ACM_3",
        "Order to Confirm to Fulfillment (Provider Specific)": "ACM_4",
        "Order to Confirm to Fulfillment (Part Payment)": "ACM_5",
        "Buyer side full cancellation": "ACM_6",
        "Merchant side full cancellation": "ACM_7",
        "Order to Confirm to Fulfillment (Updates in Booking)": "ACM_8",
      },
    },
  },
  "ONDC:TRV14": {
    "2.0.0": {
      "unreserved-entry-pass": {
        "purchase_journey_with_form": "EP_1",
        "purchase_journey_without_form": "EP_2",
        "purchase_journey_with_form_Multiple_Tickets": "EP_3",
        "purchase_journey_without_form_Multiple_Tickets": "EP_4",
        "technical_cancellation_with_form": "EP_5",
        "technical_cancellation": "EP_6",
        "User_Cancellation_FULL_With_Form": "EP_7",
        "User Cancellation (Full)": "EP_8"
      },
    },
  },
  "ONDC:TRV12": {
    "2.0.0": {
      "Intercity": {
        "Intercity(Bus)_Station_Code_Based_Flow": "ITC_1",
        "Intercity(Bus)_Station_Code_Based_Flow_Multiple_Tickets": "ITC_2",
        "Intercity(Bus)_Cancel_Flow(Buyer)": "ITC_3",
        "Intercity(Bus)_Seller_Cancellation": "ITC_4"
      },
      "Airline": {
        "Purchase Journey(Code Based Flow)": "AIR_1",
        "Purchase Journey(Multiple Tickets)": "AIR_2",
        "Cancellation by Buyer": "AIR_3",
        "Cancellation by Seller": "AIR_4"
      },
    },
  },
  "ONDC:RET10": {
    "1.2.5": {
      "GROCERY": {
        "Discovery_Flow_full_catalog": "RET_9",
        "Discovery_Flow_incremental_catalog": "RET_9_INC_PUSH",
        "Delivery_Flow": "RET_1",
        "Cancellation_Flow": "RET_3",
        "RTO_And_Part_Cancellation_Flow": "RET_MRGD_1",
        "Out_Of_Stock_Flow(Error-code)": "RET_6",
        "Return_Flow": "RET_MRGD_2",
        "Replacement_Flow": "RET_ENH_00B",
        "Cash_On_Delivery_Flow": "RET_1b",
        "Self_Pickup_Flow": "RET_ENH_002",
        "Slotted_Delivery_Flow": "RET_ENH_003",
        "Buyer_Delivery_Flow": "RET_ENH_004", //pramaan pending
        "Buyer_Instructions_And_Delivery_Update_Flow": "RET_MRGD_3_OOF_011",
        "Commercial_Model_For_BNP/SNP_Flow": "RET_ENH_00A",
        "Forced_Cancellation_Flow": "RET_ENH_005"
      },
    },
    "1.2.0": {
      "GROCERY": {
        "Search_and_Custom_Menu_(Full_Catalog_City)": "RET_9",
        "Search_and_Custom_Menu_(Incremental_Push)": "RET_9_INC_PUSH",
        "Order_to_confirm_to_fulfillment_(Prepaid)": "RET_1",
        "Buyer_Side_Order_Cancellation": "RET_3",
        "Merchant_Side_RTO_and_Part_Order_Cancellation_Flow": "RET_MRGD_4",
        "Buyer_Initiated_Return_(Full_Order_and_Partial_Order)": "RET_MRGD_5",
        "Out_of_Stock(Error_code)": "RET_6",
      },
    },
  },
  "ONDC:RETeB2B": {
    "1.2.5": {
      "eB2B": {
        "Discovery_flow_broadcast_search": "RET_9_EB2B",
        "Order_to_confirm_to_fulfillment_(cod)": "RET_1B_EB2B",
      },
    },
  },
  
  "ONDC:RET11": {
    "1.2.5": {
      "F&B": {
        "FULL_CATALOG": "RET_9",
        "INCREMENTAL_CATALOG": "RET_9_INC_PUSH",
        "ORDER_FLOW": "RET_1",
        "RTO_PLUS_PART_CANCELLATION": "RET_MRGD_1",
        "RETURN_FLOW": "RET_MRGD_2",
        "REPLACEMENT_FLOW": "RET_ENH_00B",
        "COMMERCIAL_MODEL_FOR_BNP/SNP_FLOW": "RET_ENH_00A",
        "OUT_OF_STOCK(ERROR-CODE)": "RET_6",
        "BUYER_CANCEL": "RET_3",
        "FORCE_CANCEL": "RET_ENH_005",
        "OFFERS_FLOW": "RET_ENH_009",
        "SELF_PICKUP": "RET_ENH_002",
        "SLOTTED_DELIVERY": "RET_ENH_003",
        "BUYER_DELIVERY": "RET_ENH_004",// pramaan pending
        "BUYER INSTRUCTIONS AND ADDRESS UPDATE FLOW": "RET_MRGD_3_OOF_011",
      },
    },
    "1.2.0": {
      "F&B": {
        "Search_and_Custom_Menu_(Full_Catalog_City)": "RET_9",
        "Search_and_Custom_Menu_(Incremental_Push)": "RET_9_INC_PUSH",
        "Order_to_confirm_to_fulfillment_(Prepaid)": "RET_1",
        "Buyer_Side_Order_Cancellation": "RET_3",
        "Merchant_Side_RTO_and_Part_Order_Cancellation_Flow": "RET_MRGD_4",
        "Buyer_Initiated_Return_(Full_Order_and_Partial_Order)": "RET_MRGD_5",
        "Out_of_Stock(Error_code)": "RET_6",
      },
    },
  },
  "ONDC:RET12": {
    "1.2.5": {
      "FASHION": {
        "Discovery_Flow_full_catalog": "RET_9",
        "Discovery_Flow_incremental_catalog": "RET_9_INC_PUSH",
        "Delivery_Flow": "RET_1",
        "Buyer_Cancellation_Flow": "RET_3",
        "Seller_Cred_Flow": "RET_ENH_017",
        "Return_Flow": "RET_MRGD_2",
        "Cash_On_Delivery_Flow": "RET_1b",
        "Replacement_Flow": "RET_ENH_00B",
        "Cancel_Return_Request_Flow": "RET_ENH_00D",// pramman pending
        "Force_Cancellation_Flow": "RET_ENH_005",
        "Out_Of_Stock_Flow(Error-code)": "RET_6",
        "Buyer_Instructions_And_Delivery_Update_Flow": "RET_MRGD_3_OOF_011",
      },
    },
    "1.2.0": {
      "FASHION": {
        "Search_and_Custom_Menu_(Full_Catalog_City)": "RET_9",
        "Search_and_Custom_Menu_(Incremental_Push)": "RET_9_INC_PUSH",
        "Order_to_confirm_to_fulfillment_(Prepaid)": "RET_1",
        "Buyer_Side_Order_Cancellation": "RET_3",
        "Merchant_Side_RTO_and_Part_Order_Cancellation_Flow": "RET_MRGD_4",
        "Buyer_Initiated_Return_(Full_Order_and_Partial_Order)": "RET_MRGD_5",
        "Out_of_Stock(Error_code)": "RET_6",
      },
    },
  },
  "ONDC:RET13": {
    "1.2.5": {
      "BPC": {
        "Discovery_Flow_full_catalog": "RET_9",
        "Discovery_Flow_incremental_catalog": "RET_9_INC_PUSH",
        "Delivery_Flow": "RET_1",
        "Buyer_Cancellation_Flow": "RET_3",
        "Seller_Cred_Flow": "RET_ENH_017",
        "Replacement_Flow": "RET_ENH_00B",
        "Cash_On_Delivery_Flow": "RET_1b",
        "Out_Of_Stock_Flow(Error-code)": "RET_6",
        "Force_Cancellation_Flow": "RET_ENH_005",
        "Offers_Flow": "RET_ENH_009",
      },
    },
    "1.2.0": {
      "BPC": {
        "Search_and_Custom_Menu_(Full_Catalog_City)": "RET_9",
        "Search_and_Custom_Menu_(Incremental_Push)": "RET_9_INC_PUSH",
        "Order_to_confirm_to_fulfillment_(Prepaid)": "RET_1",
        "Buyer_Side_Order_Cancellation": "RET_3",
        "Merchant_Side_RTO_and_Part_Order_Cancellation_Flow": "RET_MRGD_4",
        "Buyer_Initiated_Return_(Full_Order_and_Partial_Order)": "RET_MRGD_5",
        "Out_of_Stock(Error_code)": "RET_6",
      },
    },
  },
  "ONDC:RET14": {
    "1.2.5": {
      "ELECTRONICS": {
        "Discovery_Flow_full_catalog": "RET_9",
        "Discovery_Flow_incremental_catalog": "RET_9_INC_PUSH",
        "Delivery_Flow": "RET_1",
        "Buyer_Cancellation_Flow": "RET_3",
        "Out_Of_Stock_Flow(Error-code)": "RET_6",
        "Replacement_Flow": "RET_ENH_00B",
        "Purchase_Finance_Flow": "RET_ENH_0099",
        "Customization_Input_Text_Flow": "RET_ENH_016",// pramaan 
      },
    },
    "1.2.0": {
      "ELECTRONICS": {
        "Search_and_Custom_Menu_(Full_Catalog_City)": "RET_9",
        "Search_and_Custom_Menu_(Incremental_Push)": "RET_9_INC_PUSH",
        "Order_to_confirm_to_fulfillment_(Prepaid)": "RET_1",
        "Buyer_Side_Order_Cancellation": "RET_3",
        "Merchant_Side_RTO_and_Part_Order_Cancellation_Flow": "RET_MRGD_4",
        "Buyer_Initiated_Return_(Full_Order_and_Partial_Order)": "RET_MRGD_5",
        "Out_of_Stock(Error_code)": "RET_6",
      },
    },
  },
  "ONDC:RET15": {
    "1.2.5": {
      "APPLIANCES": {
        "Discovery_Flow_full_catalog": "RET_9",
        "Discovery_Flow_incremental_catalog": "RET_9_INC_PUSH",
        "Delivery_Flow": "RET_1",
        "Buyer_Cancellation_Flow": "RET_3",
        "Out_Of_Stock_Flow(Error-code)": "RET_6",
        "Replacement_Flow": "RET_ENH_00B",
        "Purchase_Finance_Flow": "RET_ENH_0099",
        "Customization_Input_Text_Flow": "RET_ENH_016",// pramaan 
        "Force_Cancellation_Flow": "RET_ENH_005",
      },
    },
    "1.2.0": {
      "APPLIANCES": {
        "Search_and_Custom_Menu_(Full_Catalog_City)": "RET_9",
        "Search_and_Custom_Menu_(Incremental_Push)": "RET_9_INC_PUSH",
        "Order_to_confirm_to_fulfillment_(Prepaid)": "RET_1",
        "Buyer_Side_Order_Cancellation": "RET_3",
        "Merchant_Side_RTO_and_Part_Order_Cancellation_Flow": "RET_MRGD_4",
        "Buyer_Initiated_Return_(Full_Order_and_Partial_Order)": "RET_MRGD_5",
        "Out_of_Stock(Error_code)": "RET_6",
      },
    },
  },
  "ONDC:RET16": {
    "1.2.5": {
      "HOME&KITCHEN": {
        "Discovery_Flow_full_catalog": "RET_9",
        "Discovery_Flow_incremental_catalog": "RET_9_INC_PUSH",
        "Delivery_Flow": "RET_1",
        "Buyer_Cancellation_Flow": "RET_3",
        "Out_Of_Stock_Flow(Error-code)": "RET_6",
        "Replacement_Flow": "RET_ENH_00B",
        "Purchase_Finance_Flow": "RET_ENH_0099",
        "Customization_Input_Text_Flow": "RET_ENH_016",// pramaan 
        "Force_Cancellation_Flow": "RET_ENH_005",
      },
    },
    "1.2.0": {
      "HOME&KITCHEN": {
        "Search_and_Custom_Menu_(Full_Catalog_City)": "RET_9",
        "Search_and_Custom_Menu_(Incremental_Push)": "RET_9_INC_PUSH",
        "Order_to_confirm_to_fulfillment_(Prepaid)": "RET_1",
        "Buyer_Side_Order_Cancellation": "RET_3",
        "Merchant_Side_RTO_and_Part_Order_Cancellation_Flow": "RET_MRGD_4",
        "Buyer_Initiated_Return_(Full_Order_and_Partial_Order)": "RET_MRGD_5",
        "Out_of_Stock(Error_code)": "RET_6",
      },
    },
  },
  "ONDC:RET18": {
    "1.2.5": {
      "HEALTH&WELLNESS": {
        "Discovery_Flow_full_catalog": "RET_9",
        "Discovery_Flow_incremental_catalog": "RET_9_INC_PUSH",
        "Delivery_Flow": "RET_1",
        "Self_Pickup_Flow": "RET_ENH_002",
        "Slotted_Delivery_Flow": "RET_ENH_003",
        "Replacement_Flow": "RET_ENH_00B",
        "Buyer_Instructions_And_Delivery_Update_Flow": "RET_MRGD_3_OOF_011",
        "Seller_Cred_Flow": "RET_ENH_017",
        "Force_Cancellation_Flow": "RET_ENH_005", // pramaan 
        "Buyer_Cancellation_Flow": "RET_3",
        "Cash_On_Delivery_Flow": "RET_1b",
        "Out_Of_Stock_Flow(Error-code)": "RET_6",
      },
    },
    "1.2.0": {
      "HEALTH&WELLNESS": {
        "Search_and_Custom_Menu_(Full_Catalog_City)": "RET_9",
        "Search_and_Custom_Menu_(Incremental_Push)": "RET_9_INC_PUSH",
        "Order_to_confirm_to_fulfillment_(Prepaid)": "RET_1",
        "Buyer_Side_Order_Cancellation": "RET_3",
        "Merchant_Side_RTO_and_Part_Order_Cancellation_Flow": "RET_MRGD_4",
        "Buyer_Initiated_Return_(Full_Order_and_Partial_Order)": "RET_MRGD_5",
        "Out_of_Stock(Error_code)": "RET_6",
      },
    },
  },
  "ONDC:LOG10": {
    "1.2.5": {
      "ride-Logistics (P2P)": {
        "STATIC_OTP_RTO_DELIVERY": "LOG_ENH_00A",
        "CASH_ON_DELIVERY_FLOW": "LOG_ENH_008",
        "SURGE_FEE_FLOW": "LOG_ENH_017",
      },
    },
  },
  "ONDC:LOG11": {
    "1.2.5": {
      "ride-Logistics (P2P)": {
        "STATIC_OTP_RTO_DELIVERY": "LOG_ENH_00A",
        "CASH_ON_DELIVERY_FLOW": "LOG_ENH_008",
        "SURGE_FEE_FLOW": "LOG_ENH_017",
        "ORDER_FLOW_BASE_LINE": "LOG11_TECH_1"
      },
    },
  },
  "nic2004:60232": {
    "1.2.0": {
      "Logistics (NIC2004:60232)": {
        "ORDER_FLOW_BASELINE": "B2C_1",
        "ORDER_FLOW_BASELINE(without rts)": "B2C_1_WORTS",
        "BUYER_SIDE_ORDER_CANCELLATION": "B2C_5",
        "RTO_FLOW": "B2C_2"
      }
    }
  },
  "ONDC:FIS13": {
    "2.0.0": {
      "transit-insurance": {
        "Discovery_of_Insurer_Providers_and_Master_Policies": "INS_SGRTD_1",
        "Discovery_of_Products_from_Master_Policies (Transit Insurance)": "INS_SGRTD_2",
        "Purchase_Journey_Transit_Insurance": "INS_20",
        "CD_Balance_Error_Transit_Insurance": "INS_23"
      },
      "accidental-insurance": {
        "Discovery_of_Insurer_Providers_and_Master_Policies": "INS_SGRTD_1",
        "Discovery_of_Products_from_Master_Policies (Accidental Insurance)": "INS_SGRTD_2",
        "Purchase_Journey_Accidental_Insurance": "INS_SGRTD_3",
        "CD_Balance_Error_Transit_Insurance": "INS_23"

      },
      "hospicash-insurance": {
        "Discovery_of_Insurer_Providers_and_Master_Policies": "INS_SGRTD_1",
        "Discovery_of_Products_from_Master_Policies (Hospicash Insurance)": "INS_SGRTD_2",
        "Purchase_Journey_Hospicash_Insurance": "INS_21",
        "CD_Balance_Error_Hospicash_Insurance": "INS_23"
      }
    }
  }
}

export const typeMapping: Record<string, string> = {
  "Bus": "BUS",
  "Metro": "METRO",
  "Ride-hailing": "RIDE_HAILING",
  "ride-Logistics (P2P)": "LOG",
  "gift-card": "GIFTCARD",
  "GROCERY": "RETAIL",
  "eB2B": "RETAIL",
  "F&B": "RETAIL",
  "FASHION": "RETAIL",
  "BPC": "RETAIL",
  "ELECTRONICS": "RETAIL",
  "APPLIANCES": "RETAIL",
  "HOME&KITCHEN": "RETAIL",
  "HEALTH&WELLNESS": "RETAIL",
  "Airline": "AIRLINE",
  "Intercity": "INTERCITY",
  "unreserved-entry-pass": "ENTRY_PASS",
  "Hotel-Booking": "ACCOMMODATION",
  "transit-insurance": "SACHET_INSURANCE",
  "accidental-insurance": "SACHET_INSURANCE",
  "hospicash-insurance": "SACHET_INSURANCE",
  "Logistics (NIC2004:60232)": "LOGISTICS"
};

export const NIC_LOGISTICS_CATEGORY_FLOW_MAP: Record<string, string> = {
  "Standard Delivery": "B2C_1A",
  "Same Day Delivery": "B2C_1B",
  "Next Day Delivery": "B2C_1C",
  "Immediate Delivery": "B2C_1D",
  "Express Delivery": "B2C_1E",
};
