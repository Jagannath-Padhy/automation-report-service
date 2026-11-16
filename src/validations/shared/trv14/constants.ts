// TRV14 2.0.0 workbench values. Source of truth: ONDC-Official/automation-specifications
// draft-TRV14-2.0.0 (commit ca523e5f) — config/validations/index.yaml enums and the
// payloads its flow generators produce. The TRV14 contract is reference only; where
// it disagrees (e.g. NOT_PAID) the workbench value wins.

export const TRV14_DOMAIN = "ONDC:TRV14";
export const TRV14_VERSION = "2.0.0";

export const TRV14_ENUMS = {
  paymentStatus: ["PAID", "NOT-PAID"],
  paymentType: ["PRE_ORDER"],
  paymentCollectedBy: ["BAP", "BPP"],
  orderStatus: ["SOFT_CANCEL", "CONFIRM_CANCEL", "ACTIVE", "COMPLETED", "CANCELLED"],
  onUpdateOrderStatus: ["SOFT_CANCEL", "ACTIVE"],
  fulfillmentState: ["CONFIRMED", "IN_PROGRESS", "COMPLETED"],
  fulfillmentType: ["VISIT"],
  itemCode: ["ABSTRACT", "ENTRY_PASS", "ADD_ON"],
  breakupTitle: [
    "BASE_PRICE",
    "TAX",
    "ADD_ONS",
    "REFUND",
    "CANCELLATION_CHARGES",
    "CONVENIENCE_FEE",
    "BAP_CONVENIENCE_FEE",
  ],
  cancelDescriptorCode: ["SOFT_CANCEL", "CONFIRM_CANCEL"],
  cancellationReasonId: ["000", "001", "002", "003", "004", "005", "011", "012", "013", "014"],
  cancelledBy: ["CONSUMER", "PROVIDER"],
  searchCategoryCode: ["CULTURE_HERITAGE"],
} as const;
