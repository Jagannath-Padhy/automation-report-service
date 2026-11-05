/**
 * Real RET10 fulfillment.type values, confirmed both from the real v1.2.0/1.2.5
 * API contracts (bpp/fulfillments enum: "Delivery" / "Self-Pickup" / "Delivery
 * and Self-Pickup") and from real recorded session payloads, which additionally
 * use "Buyer-Delivery" (present in provider fulfillment lists in the contract's
 * own catalog examples, but absent from its top-level enum).
 *
 * Several checks in this domain were hardcoded to only recognize "Delivery",
 * which produced false failures for real Self_Pickup_Flow data — see KI-01
 * through KI-05 in the validation-coverage audit. Use these helpers instead of
 * a literal "Delivery" comparison wherever a check isn't genuinely
 * Delivery-specific.
 */
export const RET10_FULFILLMENT_TYPES = [
  "Delivery",
  "Self-Pickup",
  "Buyer-Delivery",
  "Delivery and Self-Pickup",
];

export function isRecognizedFulfillmentType(type: any): boolean {
  return RET10_FULFILLMENT_TYPES.includes(type);
}

/**
 * Finds the primary (forward-journey) fulfillment on an order — i.e. whichever
 * one carries a real RET10_FULFILLMENT_TYPES type — as opposed to the
 * separately-typed "RTO"/"Cancel"/"Return" fulfillments that some flows add
 * alongside it. Falls back to the first fulfillment if none match, so a
 * genuinely-wrong/unrecognized type still surfaces to the caller instead of
 * silently returning undefined.
 */
export function findPrimaryFulfillment(order: any): any {
  const fulfillments = order?.fulfillments || [];
  return (
    fulfillments.find((f: any) => isRecognizedFulfillmentType(f?.type)) ||
    fulfillments[0]
  );
}
