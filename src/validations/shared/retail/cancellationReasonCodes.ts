/**
 * Retail cancellation reason codes, sourced from the "Cancellation - Retail"
 * tab of the reason-codes sheet (docs.google.com/spreadsheets/d/1_qAtG6Bu2we3AP6OpXr4GVP3X-32v2xNRNSYQhhR6kA,
 * gid=814799303), columns "Code (current)" [v1.2.0] and "Code (new)" [v1.2.5].
 *
 * The two versions are NOT a simple superset — some codes were renumbered
 * (004->051, 006->052, 010->053: the old number is retired in 1.2.5, not
 * just aliased) and some were merged away entirely (005 -> use 021/022/023/
 * 024 instead; 012 and 015 -> merged into 013). Others carry over unchanged
 * (001, 003, 009, 017, 020, 998, 999 have no "Code (new)" entry and no
 * merge/deprecation note — same code, both versions). And 021 is reused
 * for a completely different, unrelated meaning in 1.2.5 ("Store not
 * responsive") than whatever it might have meant elsewhere.
 *
 * Previously this was a single un-versioned table that also mixed in
 * several Logistics-domain-only codes (007, 008, 019, 996, 997, and 021
 * meaning "packed order not complete") that don't appear anywhere in this
 * sheet's Retail tab at all — those came from log-validation-utility's
 * shared/common reasonCode.ts table, which combines multiple domains, and
 * got ported wholesale instead of filtered to Retail. Dropped here.
 */

interface CancellationReasonCode {
  reason: string;
  usedBy: "BNP" | "SNP";
}

// v1.2.0 — the "Code (current)" column.
export const CANCELLATION_REASON_CODES_1_2_0: Record<string, CancellationReasonCode> = {
  "001": { reason: "Price of one or more items have changed due to which buyer was asked to make additional payment", usedBy: "BNP" },
  "002": { reason: "One or more items in the order not available", usedBy: "SNP" },
  "003": { reason: "Product available at lower than order price", usedBy: "BNP" },
  "004": { reason: "Store is not accepting order", usedBy: "BNP" },
  "005": { reason: "Store rejected the order", usedBy: "SNP" },
  "006": { reason: "Order / fulfillment not received as per O2D TAT", usedBy: "BNP" },
  "009": { reason: "Wrong product delivered", usedBy: "BNP" },
  "010": { reason: "Buyer wants to modify address / other order details", usedBy: "BNP" },
  "011": { reason: "Retail buyer not found / can't be contacted", usedBy: "SNP" },
  "012": { reason: "Buyer does not want product any more", usedBy: "SNP" },
  "013": { reason: "Retail buyer can't / doesn't want to accept delivery", usedBy: "SNP" },
  "014": { reason: "Delivery address incorrect or not found", usedBy: "SNP" },
  "015": { reason: "Buyer not available at location", usedBy: "SNP" },
  "016": { reason: "Force majeure (accident / strike / law & order situation, etc)", usedBy: "SNP" },
  "017": { reason: "Order delivery delayed or not possible (vehicle issues, etc)", usedBy: "SNP" },
  "018": { reason: "Order not serviceable", usedBy: "SNP" },
  "020": { reason: "Order lost or damaged in transit", usedBy: "SNP" },
  "998": { reason: "Order confirmation failure", usedBy: "SNP" },
  "999": { reason: "Order confirmation failure", usedBy: "BNP" },
};

// v1.2.5 — the "Code (new)" column where present, plus the unchanged
// carryovers (001, 003, 009, 017, 020, 998, 999). Excludes 004/005/006/
// 010/012/015, which are retired/merged in this version.
export const CANCELLATION_REASON_CODES_1_2_5: Record<string, CancellationReasonCode> = {
  "001": { reason: "Price of one or more items have changed due to which buyer was asked to make additional payment", usedBy: "BNP" },
  "002": { reason: "One or more items in the order not available", usedBy: "SNP" },
  "003": { reason: "Product available at lower than order price", usedBy: "BNP" },
  "009": { reason: "Wrong product delivered", usedBy: "BNP" },
  "011": { reason: "Retail buyer not found / can't be contacted", usedBy: "SNP" },
  "013": { reason: "Retail buyer can't / doesn't want to accept delivery", usedBy: "SNP" },
  "014": { reason: "Delivery address incorrect or not found", usedBy: "SNP" },
  "016": { reason: "Force majeure (accident / strike / law & order situation, etc)", usedBy: "SNP" },
  "017": { reason: "Order delivery delayed or not possible (vehicle issues, etc)", usedBy: "SNP" },
  "018": { reason: "Order not serviceable", usedBy: "SNP" },
  "020": { reason: "Order lost or damaged in transit", usedBy: "SNP" },
  "021": { reason: "Store not responsive", usedBy: "SNP" },
  "022": { reason: "Technical issue in merchant device", usedBy: "SNP" },
  "023": { reason: "Order received during non-operational hours", usedBy: "SNP" },
  "024": { reason: "Order received during store rush", usedBy: "SNP" },
  "051": { reason: "Store is not accepting order", usedBy: "BNP" },
  "052": { reason: "Order / fulfillment not received as per O2D TAT", usedBy: "BNP" },
  "053": { reason: "Buyer wants to modify address / other order details", usedBy: "BNP" },
  "998": { reason: "Order confirmation failure", usedBy: "SNP" },
  "999": { reason: "Order confirmation failure", usedBy: "BNP" },
};

function isV125(version: string | undefined): boolean {
  return (version || "").startsWith("1.2.5");
}

export function isValidCancellationReasonId(
  cancelledByRole: "BNP" | "SNP",
  reasonId: string | undefined,
  version?: string
): boolean {
  if (!reasonId) return false;
  const table = isV125(version) ? CANCELLATION_REASON_CODES_1_2_5 : CANCELLATION_REASON_CODES_1_2_0;
  const entry = table[reasonId];
  if (!entry) return false;
  return entry.usedBy === cancelledByRole;
}
