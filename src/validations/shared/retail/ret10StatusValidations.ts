import { Payload, TestResult } from "../../../types/payload";
import { createBaseValidationSetup, tagLayer } from "../commonValidations";
import { runExternalSchemaAndL1Validation } from "../externalSchemaValidator";
import { saveData, fetchData } from "../../../utils/redisUtils";
import { getActionData } from "../../../services/actionDataService";
import { isValidCancellationReasonId } from "./cancellationReasonCodes";
import { findPrimaryFulfillment } from "./fulfillmentTypes";
import { checkProviderCredsConsistency } from "./credsValidation";

// Async counterpart to tagLayer (shared helper only supports sync callbacks)
// — needed here since checkMonotonicOnStatusTimestamp/checkCrossActionConsistency/
// checkRtoDelivered are all async.
async function tagLayerAsync(
  testResults: TestResult,
  layer: "L2" | "L3",
  fn: () => Promise<void>
): Promise<void> {
  const passedStart = testResults.passed.length;
  const failedStart = testResults.failed.length;
  await fn();
  for (let i = passedStart; i < testResults.passed.length; i++) {
    testResults.passed[i] = `${layer}: ${testResults.passed[i]}`;
  }
  for (let i = failedStart; i < testResults.failed.length; i++) {
    testResults.failed[i] = `${layer}: ${testResults.failed[i]}`;
  }
}

/**
 * Ported from log-validation-utility/utils/Retail/Status/{status,onStatusPending,
 * onStatusPacked,onStatusPicked,onStatusOutForDelivery,onStatusDelivered,
 * onStatusRTODelivered}.ts, with the AJV validateSchema(...) calls removed
 * (now redundant — see runExternalSchemaAndL1Validation) and the generic
 * context/city/transaction_id boilerplate dropped (that's either an L1/JVAL
 * concern already covered by the external call, or depends on state saved by
 * sibling action families — search/select — ported in parallel and not
 * coordinated with this file; see report for details).
 *
 * createDomainValidator dispatches purely by action name (STATUS/ON_STATUS),
 * not by fulfillment stage, so validateRet10OnStatus detects the stage itself
 * from the payload's fulfillment.state.descriptor.code and dispatches
 * internally — mirroring the same technique already used for Logistics
 * on_status differentiation earlier in this project.
 */

const ROUTING_ENUMS = ["P2P", "P2H2P"];
const BUYER_INSTRUCTION_CODES = ["1", "2", "3", "5"]; // OTP, other DCC, no delivery code, static OTP
const OTP_INSTRUCTION_CODE = "1";

function findFulfillment(order: any, type: string) {
  return (order?.fulfillments || []).find((f: any) => f?.type === type);
}

function isValidDate(value: any): boolean {
  if (!value) return false;
  const d = new Date(value);
  return !isNaN(d.getTime());
}

async function checkMonotonicOnStatusTimestamp(
  sessionID: string,
  transactionId: string,
  contextTimestamp: string,
  testResults: TestResult
): Promise<void> {
  try {
    const prev = await fetchData(sessionID, transactionId, "ret10_on_status_last_timestamp");
    const prevTs = prev?.value;
    if (prevTs && contextTimestamp && prevTs >= contextTimestamp) {
      testResults.failed.push(
        `on_status: context.timestamp (${contextTimestamp}) must be strictly later than the previous on_status call's timestamp (${prevTs})`
      );
    } else {
      testResults.passed.push("on_status: context.timestamp is monotonically increasing across calls");
    }
    if (contextTimestamp) {
      await saveData(sessionID, transactionId, "ret10_on_status_last_timestamp", { value: contextTimestamp });
    }
  } catch {
    // best-effort — don't fail the whole validation if Redis state is unavailable
  }
}

function checkRoutingTag(deliveryFulfillment: any, stageLabel: string, testResults: TestResult): void {
  const tags = deliveryFulfillment?.tags;
  if (!tags) {
    testResults.failed.push(`${stageLabel}: tags are mandatory on the Delivery fulfillment`);
    return;
  }
  const routingTag = tags.find((t: any) => t?.code === "routing");
  if (!routingTag) {
    testResults.failed.push(`${stageLabel}: a "routing" tag is mandatory on the Delivery fulfillment's tags`);
    return;
  }
  const typeEntry = (routingTag.list || []).find((e: any) => e?.code === "type");
  if (!typeEntry) {
    testResults.failed.push(`${stageLabel}: routing tag must contain a "type" entry`);
    return;
  }
  if (!ROUTING_ENUMS.includes(typeEntry.value)) {
    testResults.failed.push(
      `${stageLabel}: routing tag's "type" value must be one of ${ROUTING_ENUMS.join("/")}, got "${typeEntry.value}"`
    );
    return;
  }
  testResults.passed.push(`${stageLabel}: routing tag present and valid`);
}

function checkCodCollectedCorrectly(
  order: any,
  flowId: string,
  expectPaid: boolean,
  stageLabel: string,
  testResults: TestResult
): void {
  // Mirrors log-validation-utility's FLOW.FLOW012 (Cash on Delivery) handling:
  // payment must stay NOT-PAID until delivery, and must be PAID once delivered.
  if (flowId !== "CASH_ON_DELIVERY_FLOW" && flowId !== "FLOW012") return;
  const status = order?.payment?.status;
  if (!status) return;
  const expected = expectPaid ? "PAID" : "NOT-PAID";
  if (status !== expected) {
    testResults.failed.push(
      `${stageLabel}: payment.status should be "${expected}" for the Cash on Delivery flow, got "${status}"`
    );
  } else {
    testResults.passed.push(`${stageLabel}: payment.status is correctly "${expected}" for COD`);
  }
}

function checkPending(order: any, context: any, testResults: TestResult): void {
  if (order?.state !== "Accepted") {
    testResults.failed.push(
      `on_status (Pending): order.state should be "Accepted", got "${order?.state}"`
    );
  } else {
    testResults.passed.push("on_status (Pending): order.state is correctly Accepted");
  }
  const delivery = findPrimaryFulfillment(order);
  if (!delivery?.id) {
    testResults.failed.push("on_status (Pending): a fulfillment with an id is mandatory");
  } else {
    testResults.passed.push(`on_status (Pending): fulfillment "${delivery.id}" (type ${delivery.type}) with an id is present`);
  }
}

// stageLabel lets this one function correctly report whichever intermediate
// "In-progress" fulfillment-state code the payload actually used — Packed,
// but also Agent-assigned, Ready-to-ship, etc. — instead of hardcoding
// "Packed" in every message regardless of what the real code was.
function checkPacked(order: any, flowId: string, testResults: TestResult, stageLabel: string = "Packed"): void {
  if (order?.state !== "In-progress") {
    testResults.failed.push(
      `on_status (${stageLabel}): order.state should be "In-progress", got "${order?.state}"`
    );
  } else {
    testResults.passed.push(`on_status (${stageLabel}): order.state is correctly In-progress`);
  }

  const delivery = findPrimaryFulfillment(order);
  const instructions = delivery?.end?.instructions;
  if (instructions) {
    const code = instructions.code;
    if (!BUYER_INSTRUCTION_CODES.includes(code)) {
      testResults.failed.push(`on_status (${stageLabel}): delivery instruction code "${code}" is invalid`);
    } else {
      testResults.passed.push(`on_status (${stageLabel}): delivery instruction code is valid`);
    }
    if (code === OTP_INSTRUCTION_CODE) {
      const authorization = delivery?.end?.authorization;
      if (!authorization?.token) {
        testResults.failed.push(
          `on_status (${stageLabel}): instruction code is OTP (1) but end.authorization.token is missing`
        );
      } else {
        testResults.passed.push(`on_status (${stageLabel}): OTP authorization token present`);
      }
    }
  }

  checkCodCollectedCorrectly(order, flowId, false, `on_status (${stageLabel})`, testResults);
}

function checkPicked(order: any, context: any, flowId: string, testResults: TestResult): void {
  const delivery = findPrimaryFulfillment(order);
  // For a standard Delivery/Buyer-Delivery fulfillment, "Order-picked-up" is an
  // intermediate stage (order.state stays "In-progress"); for Self-Pickup it's
  // the terminal stage (the buyer picking it up IS completion) and
  // order.state is "Completed" — confirmed from a real Self_Pickup_Flow
  // session. Same state code, different lifecycle position depending on type.
  const isSelfPickup = delivery?.type === "Self-Pickup";
  const expectedOrderStates = isSelfPickup ? ["Completed"] : ["In-progress"];
  if (!expectedOrderStates.includes(order?.state)) {
    testResults.failed.push(
      `on_status (Order-picked-up): order.state should be "${expectedOrderStates.join('" or "')}", got "${order?.state}"`
    );
  } else {
    testResults.passed.push(`on_status (Order-picked-up): order.state is correctly "${order?.state}"`);
  }

  // Routing tags (P2P/P2H2P courier routing) only apply when a courier/LSP is
  // actually involved — Self-Pickup has no courier at all.
  if (!isSelfPickup) {
    checkRoutingTag(delivery, "on_status (Order-picked-up)", testResults);
  }

  const pickupTime = delivery?.start?.time?.timestamp;
  if (!pickupTime) {
    testResults.failed.push("on_status (Order-picked-up): fulfillment.start.time.timestamp (pickup time) is missing");
  } else if (context?.timestamp && pickupTime > context.timestamp) {
    testResults.failed.push("on_status (Order-picked-up): pickup timestamp cannot be later than context.timestamp");
  } else {
    testResults.passed.push("on_status (Order-picked-up): pickup timestamp present and not future-dated");
  }

  // The start/end time *range* is a Delivery/Buyer-Delivery concept (a
  // delivery window); Self-Pickup's real payloads use a flat
  // start.time.timestamp instead (already checked above), not a range.
  if (!isSelfPickup) {
    const range = delivery?.start?.time?.range;
    const endRange = delivery?.end?.time?.range;
    if (!range || !endRange) {
      testResults.failed.push("on_status (Order-picked-up): Delivery fulfillment is missing a complete start/end time range");
    } else {
      testResults.passed.push("on_status (Order-picked-up): Delivery fulfillment has a complete start/end time range");
    }
  }

  checkCodCollectedCorrectly(order, flowId, false, "on_status (Order-picked-up)", testResults);
}

function checkOutForDelivery(order: any, context: any, flowId: string, testResults: TestResult): void {
  if (order?.state !== "In-progress") {
    testResults.failed.push(
      `on_status (Out-for-delivery): order.state should be "In-progress", got "${order?.state}"`
    );
  } else {
    testResults.passed.push("on_status (Out-for-delivery): order.state is correctly In-progress");
  }
  const delivery = findPrimaryFulfillment(order);
  checkRoutingTag(delivery, "on_status (Out-for-delivery)", testResults);

  const outForDeliveryTime = delivery?.start?.time?.timestamp;
  if (!outForDeliveryTime) {
    testResults.failed.push("on_status (Out-for-delivery): fulfillment.start.time.timestamp is missing");
  } else if (context?.timestamp && outForDeliveryTime > context.timestamp) {
    testResults.failed.push(
      "on_status (Out-for-delivery): start timestamp cannot be later than context.timestamp"
    );
  } else {
    testResults.passed.push("on_status (Out-for-delivery): start timestamp present and not future-dated");
  }

  checkCodCollectedCorrectly(order, flowId, false, "on_status (Out-for-delivery)", testResults);
}

function checkDelivered(order: any, context: any, flowId: string, testResults: TestResult): void {
  if (order?.state !== "Completed") {
    testResults.failed.push(
      `on_status (Order-delivered): order.state should be "Completed", got "${order?.state}"`
    );
  } else {
    testResults.passed.push("on_status (Order-delivered): order.state is correctly Completed");
  }
  const delivery = findPrimaryFulfillment(order);
  checkRoutingTag(delivery, "on_status (Order-delivered)", testResults);

  const pickupTime = delivery?.start?.time?.timestamp;
  const deliveryTime = delivery?.end?.time?.timestamp;
  if (!deliveryTime) {
    testResults.failed.push("on_status (Order-delivered): fulfillment.end.time.timestamp (delivery time) is missing");
  } else {
    if (context?.timestamp && deliveryTime > context.timestamp) {
      testResults.failed.push(
        "on_status (Order-delivered): delivery timestamp cannot be later than context.timestamp"
      );
    }
    if (pickupTime && pickupTime >= deliveryTime) {
      testResults.failed.push(
        "on_status (Order-delivered): delivery timestamp (end.time.timestamp) must be after the pickup timestamp (start.time.timestamp)"
      );
    }
    if (!(context?.timestamp && deliveryTime > context.timestamp) && !(pickupTime && pickupTime >= deliveryTime)) {
      testResults.passed.push("on_status (Order-delivered): delivery timestamp is valid and after pickup");
    }
  }

  // Inverted vs. the other stages — COD must now be collected (PAID).
  checkCodCollectedCorrectly(order, flowId, true, "on_status (Order-delivered)", testResults);
}

/**
 * Cross-action consistency chain, ported from the repeated block at the top
 * of every log-validation-utility Status/onStatus*.ts variant: compares this
 * on_status call against earlier actions in the same flow/transaction
 * (confirm's order id, select's fulfillment tracking flags). Uses this
 * service's own actionDataService DAO (populated via saveFromElement from the
 * confirm/select save-specs) rather than the original's in-memory dao.
 */
async function checkCrossActionConsistency(
  sessionID: string,
  flowId: string,
  transactionId: string | undefined,
  order: any,
  context: any,
  testResults: TestResult
): Promise<void> {
  if (!transactionId) return;

  const confirmData = await getActionData(sessionID, flowId, transactionId, "confirm");
  if (confirmData?.order_id) {
    if (order?.id !== confirmData.order_id) {
      testResults.failed.push(
        `on_status: order.id (${order?.id}) does not match the order id confirmed in /confirm (${confirmData.order_id})`
      );
    } else {
      testResults.passed.push("on_status: order.id matches /confirm");
    }
  }

  if (order?.updated_at && context?.timestamp && order.updated_at > context.timestamp) {
    testResults.failed.push(
      "on_status: order.updated_at should not be later than context.timestamp"
    );
  } else if (order?.updated_at && context?.timestamp) {
    testResults.passed.push("on_status: order.updated_at is not later than context.timestamp");
  }

  const onSearchData = await getActionData(sessionID, flowId, transactionId, "on_search");
  checkProviderCredsConsistency(order, onSearchData, flowId, "on_status", testResults);

  const selectData = await getActionData(sessionID, flowId, transactionId, "select");
  if (Array.isArray(selectData?.fulfillments) && Array.isArray(order?.fulfillments)) {
    for (const ff of order.fulfillments) {
      if (ff?.type === "Cancel" || !ff?.id) continue;
      const selectFf = (selectData.fulfillments as any[]).find((f) => f?.id === ff.id);
      if (selectFf && typeof selectFf.tracking === "boolean" && typeof ff.tracking === "boolean") {
        if (selectFf.tracking !== ff.tracking) {
          testResults.failed.push(
            `on_status: fulfillment ${ff.id}'s tracking (${ff.tracking}) mismatches the value set at /select (${selectFf.tracking})`
          );
        } else {
          testResults.passed.push(`on_status: fulfillment ${ff.id}'s tracking matches /select`);
        }
      }
    }
  }
}

/**
 * Ported from log-validation-utility's checkQuoteTrailSum + checkQuoteTrail
 * (utils/index.ts). Reconciles a Cancel/RTO fulfillment's quote_trail tags
 * against the price confirmed at /confirm and the per-item prices quoted at
 * /on_select, using this service's actionDataService DAO instead of the
 * original's in-memory dao/Map state.
 */
async function checkQuoteTrailReconciliation(
  sessionID: string,
  flowId: string,
  transactionId: string | undefined,
  cancelOrRtoFulfillments: any[],
  currentQuote: any,
  stageLabel: string,
  testResults: TestResult
): Promise<void> {
  if (!transactionId) return;
  const ARR_TYPE = ["misc", "packing", "delivery", "tax", "item"];
  let quoteTrailSum = 0;
  let sawAnyTrail = false;

  for (const ff of cancelOrRtoFulfillments || []) {
    const trailTags = (ff?.tags || []).filter((t: any) => t?.code === "quote_trail");
    for (const tag of trailTags) {
      sawAnyTrail = true;
      const typeEntry = (tag.list || []).find((e: any) => e?.code === "type");
      const valueEntry = (tag.list || []).find((e: any) => e?.code === "value");
      if (typeEntry && !ARR_TYPE.includes(typeEntry.value)) {
        testResults.failed.push(
          `${stageLabel}: quote_trail type "${typeEntry.value}" is invalid — must be one of ${ARR_TYPE.join("/")}`
        );
      } else if (typeEntry) {
        testResults.passed.push(`${stageLabel}: quote_trail type "${typeEntry.value}" is valid`);
      }
      if (valueEntry?.value !== undefined) {
        quoteTrailSum -= parseFloat(valueEntry.value) || 0;
      }
    }
  }

  if (!sawAnyTrail) return;
  quoteTrailSum = Number(quoteTrailSum.toFixed(2));

  const confirmData = await getActionData(sessionID, flowId, transactionId, "confirm");
  const priceAtConfirm = parseFloat(confirmData?.order?.quote?.price?.value);
  const currentPrice = parseFloat(currentQuote?.price?.value);
  if (!isNaN(priceAtConfirm) && !isNaN(currentPrice)) {
    if (Math.round(priceAtConfirm) !== Math.round(currentPrice + quoteTrailSum)) {
      testResults.failed.push(
        `${stageLabel}: quote_trail price and item quote price sum (${currentPrice + quoteTrailSum}) should equal the price confirmed at /confirm (${priceAtConfirm})`
      );
    } else {
      testResults.passed.push(`${stageLabel}: quote_trail reconciles with the price confirmed at /confirm`);
    }
  }

  const onSelectData = await getActionData(sessionID, flowId, transactionId, "on_select");
  const selectPriceMap = new Map<string, number>();
  for (const line of onSelectData?.quote?.breakup || []) {
    const itemId = line?.["@ondc/org/item_id"];
    if (itemId) selectPriceMap.set(itemId, parseFloat(line?.price?.value));
  }
  const itemIds = new Set<string>((onSelectData?.items || []).map((it: any) => it?.id).filter(Boolean));

  for (const ff of cancelOrRtoFulfillments || []) {
    const trailTags = (ff?.tags || []).filter((t: any) => t?.code === "quote_trail");
    for (const tag of trailTags) {
      const idEntry = (tag.list || []).find((e: any) => e?.code === "id");
      const valueEntry = (tag.list || []).find((e: any) => e?.code === "value");
      const typeEntry = (tag.list || []).find((e: any) => e?.code === "type");
      if (typeEntry?.value !== "item" || !idEntry?.value) continue;
      const itemId = idEntry.value;
      const actual = Math.abs(parseFloat(valueEntry?.value));

      if (selectPriceMap.size > 0) {
        const expected = selectPriceMap.get(itemId);
        if (expected !== undefined && !isNaN(actual) && expected !== actual) {
          testResults.failed.push(
            `${stageLabel}: quote_trail price for item ${itemId} (${actual}) mismatches /on_select's quote (${expected})`
          );
        } else if (expected !== undefined) {
          testResults.passed.push(`${stageLabel}: quote_trail price for item ${itemId} matches /on_select's quote`);
        }
      }
      if (itemIds.size > 0) {
        if (!itemIds.has(itemId)) {
          testResults.failed.push(`${stageLabel}: quote_trail references item ${itemId} not present in /on_select's items`);
        } else {
          testResults.passed.push(`${stageLabel}: quote_trail item ${itemId} exists in /on_select's items`);
        }
      }
    }
  }
}

function checkDeliveryAddressCompleteness(
  deliveryFulfillment: any,
  startOrEnd: "Start" | "End",
  testResults: TestResult
): void {
  const label = `on_status (RTO): Delivery.${startOrEnd.toLowerCase()}`;
  const node = startOrEnd === "Start" ? deliveryFulfillment?.start : deliveryFulfillment?.end;

  if (!node) {
    testResults.failed.push(`${label} is missing`);
    return;
  }

  if (startOrEnd === "End") {
    const address = node?.location?.address;
    if (!address) {
      testResults.failed.push(`${label}.location.address is missing`);
    } else {
      if (!address.name) testResults.failed.push(`${label}.location.address.name is missing`);
      else testResults.passed.push(`${label}.location.address.name is present`);
      if (!address.building) testResults.failed.push(`${label}.location.address.building is missing`);
      else testResults.passed.push(`${label}.location.address.building is present`);
      if (!address.country) testResults.failed.push(`${label}.location.address.country is missing`);
      else testResults.passed.push(`${label}.location.address.country is present`);
    }
  }

  if (!node?.contact?.phone) {
    testResults.failed.push(`${label}.contact.phone is missing`);
  } else if (isNaN(Number(node.contact.phone))) {
    testResults.failed.push(`${label}.contact.phone is not a valid phone number`);
  } else {
    testResults.passed.push(`${label}.contact.phone is present and valid`);
  }

  if (!node?.contact?.email) {
    testResults.failed.push(`${label}.contact.email is missing`);
  } else if (typeof node.contact.email !== "string") {
    testResults.failed.push(`${label}.contact.email is not a string`);
  } else {
    testResults.passed.push(`${label}.contact.email is present`);
  }

  if (startOrEnd === "End") {
    if (!node?.person?.name) {
      testResults.failed.push(`${label}.person.name is missing`);
    } else if (typeof node.person.name !== "string") {
      testResults.failed.push(`${label}.person.name is not a string`);
    } else {
      testResults.passed.push(`${label}.person.name is present`);
    }
  }
}

async function checkRtoDelivered(
  sessionID: string,
  flowId: string,
  transactionId: string | undefined,
  order: any,
  context: any,
  testResults: TestResult
): Promise<void> {
  const rto = findFulfillment(order, "RTO");
  const delivery = findPrimaryFulfillment(order);
  const validStates = ["RTO-Delivered", "RTO-Disposed"];

  if (!rto) {
    testResults.failed.push("on_status (RTO): an RTO-type fulfillment is mandatory");
    return;
  }

  const rtoCode = rto?.state?.descriptor?.code;
  if (!validStates.includes(rtoCode)) {
    testResults.failed.push(
      `on_status (RTO): RTO fulfillment state should be one of ${validStates.join("/")}, got "${rtoCode}"`
    );
  } else {
    testResults.passed.push(`on_status (RTO): RTO fulfillment state is valid (${rtoCode})`);
  }

  if (!rto?.start?.location) {
    testResults.failed.push("on_status (RTO): RTO fulfillment.start.location is missing");
  } else {
    testResults.passed.push("on_status (RTO): RTO fulfillment.start.location is present");
  }

  if (validStates.includes(rtoCode)) {
    const endTimestamp = rto?.end?.time?.timestamp;
    if (!endTimestamp) {
      testResults.failed.push("on_status (RTO): RTO fulfillment.end.time.timestamp is missing");
    } else if (!isValidDate(endTimestamp)) {
      testResults.failed.push("on_status (RTO): RTO fulfillment.end.time.timestamp is not a valid date");
    } else {
      testResults.passed.push("on_status (RTO): RTO fulfillment.end.time.timestamp is present and valid");
    }
  }

  if (delivery) {
    const deliveryCode = delivery?.state?.descriptor?.code;
    if (deliveryCode !== "Cancelled") {
      testResults.failed.push(
        `on_status (RTO): the forward Delivery fulfillment's state should be "Cancelled" once RTO has concluded, got "${deliveryCode}"`
      );
    } else if (!delivery.tags || delivery.tags.length === 0) {
      testResults.failed.push(
        'on_status (RTO): the Delivery fulfillment must carry tags once its state is "Cancelled"'
      );
    } else {
      testResults.passed.push("on_status (RTO): forward Delivery fulfillment correctly Cancelled with tags");
    }

    // Full address/contact/person completeness on the (now-cancelled) forward
    // Delivery fulfillment's start and end nodes.
    checkDeliveryAddressCompleteness(delivery, "Start", testResults);
    checkDeliveryAddressCompleteness(delivery, "End", testResults);

    // Forward-vs-cancellation fulfillment item count: items on the cancelled
    // forward fulfillment must have quantity 0; items on any other
    // (surviving) fulfillment must not.
    const selectData = transactionId ? await getActionData(sessionID, flowId, transactionId, "select") : null;
    const forwardFulfillmentIds: string[] = (Array.isArray(selectData?.fulfillments) ? selectData.fulfillments : [])
      .map((f: any) => f?.id)
      .filter(Boolean);
    if (forwardFulfillmentIds.length > 0 && Array.isArray(order?.items)) {
      for (const item of order.items) {
        const isForward = forwardFulfillmentIds.includes(item?.fulfillment_id);
        const count = item?.quantity?.count;
        if (isForward && count !== 0) {
          testResults.failed.push(
            `on_status (RTO): item ${item?.id}'s quantity.count should be 0 for the cancelled forward shipment, got ${count}`
          );
        } else if (!isForward && count === 0) {
          testResults.failed.push(
            `on_status (RTO): item ${item?.id}'s quantity.count should not be 0 for the RTO/cancel shipment`
          );
        } else {
          testResults.passed.push(`on_status (RTO): item ${item?.id}'s quantity.count is consistent with its shipment`);
        }
      }
    }
  }

  // Reason-code / cancelled_by mapping (BNP vs SNP), ported from
  // log-validation-utility's mapCancellationID.
  const cancellation = order?.cancellation;
  const reasonId = cancellation?.reason?.id;
  const cancelledBy = cancellation?.cancelled_by;
  if (reasonId && cancelledBy) {
    const role: "BNP" | "SNP" = cancelledBy === context?.bap_id ? "BNP" : "SNP";
    const version = context?.version || context?.core_version;
    if (!isValidCancellationReasonId(role, reasonId, version)) {
      testResults.failed.push(
        `on_status (RTO): cancellation.reason.id ${reasonId} is not a valid/allowed reason code for ${role}`
      );
    } else {
      testResults.passed.push(`on_status (RTO): cancellation.reason.id ${reasonId} is valid for ${role}`);
    }
  }

  // Simplified quote sanity check (breakup must sum to the declared price).
  const quote = order?.quote;
  if (quote?.price?.value && Array.isArray(quote?.breakup)) {
    const sum = quote.breakup.reduce((acc: number, line: any) => acc + (parseFloat(line?.price?.value) || 0), 0);
    const declared = parseFloat(quote.price.value);
    if (Math.abs(sum - declared) > 0.01) {
      testResults.failed.push(
        `on_status (RTO): quote.price.value (${declared}) does not equal the sum of quote.breakup (${sum})`
      );
    } else {
      testResults.passed.push("on_status (RTO): quote.price matches sum of breakup");
    }
  }

  // quote_trail reconciliation against /confirm's price and /on_select's
  // per-item quote, ported from checkQuoteTrailSum + checkQuoteTrail.
  const trailFulfillments = rto ? [rto] : [];
  await checkQuoteTrailReconciliation(
    sessionID,
    flowId,
    transactionId,
    trailFulfillments,
    quote,
    "on_status (RTO)",
    testResults
  );
}

export async function validateRet10Status(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const { testResults, jsonRequest, context, message } = createBaseValidationSetup(element);
  await runExternalSchemaAndL1Validation(jsonRequest, testResults);

  tagLayer(testResults, "L2", () => {
    if (!message?.order_id) {
      testResults.failed.push("status: message.order_id is mandatory");
    } else {
      testResults.passed.push("status: message.order_id present");
    }
  });

  return testResults;
}

export async function validateRet10OnStatus(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string
): Promise<TestResult> {
  const { testResults, jsonRequest, context, message } = createBaseValidationSetup(element);
  await runExternalSchemaAndL1Validation(jsonRequest, testResults);

  const order = message?.order;
  if (!order) {
    testResults.failed.push("on_status: message.order is missing");
    return testResults;
  }

  await tagLayerAsync(testResults, "L2", () =>
    checkMonotonicOnStatusTimestamp(sessionID, element.transactionId, context?.timestamp, testResults)
  );
  await tagLayerAsync(testResults, "L2", () =>
    checkCrossActionConsistency(sessionID, flowId, element.transactionId, order, context, testResults)
  );

  const rto = findFulfillment(order, "RTO");
  const delivery = findPrimaryFulfillment(order);
  const deliveryStateCode = delivery?.state?.descriptor?.code;
  const rtoStateCode = rto?.state?.descriptor?.code;

  if (rto && ["RTO-Delivered", "RTO-Disposed", "RTO-Initiated"].includes(rtoStateCode)) {
    // Entire RTO path is flow-specific: delivery-address completeness,
    // BNP/SNP reason-code mapping, forward-vs-cancellation item count, and
    // quote_trail reconciliation are all only meaningful for RTO flows.
    await tagLayerAsync(testResults, "L3", () =>
      checkRtoDelivered(sessionID, flowId, element.transactionId, order, context, testResults)
    );
  } else if (deliveryStateCode === "Order-picked-up") {
    tagLayer(testResults, "L2", () => checkPicked(order, context, flowId, testResults));
  } else if (deliveryStateCode === "Out-for-delivery") {
    tagLayer(testResults, "L2", () => checkOutForDelivery(order, context, flowId, testResults));
  } else if (deliveryStateCode === "Order-delivered" || order.state === "Completed") {
    tagLayer(testResults, "L2", () => checkDelivered(order, context, flowId, testResults));
  } else if (deliveryStateCode === "Packed" || order.state === "In-progress") {
    // Covers every intermediate "In-progress" micro-stage, not just literal
    // "Packed" — e.g. real payloads also use "Agent-assigned" and
    // Buyer_Delivery_Flow's "Ready-to-ship" — same checks apply, and the
    // stage label passed through keeps the report message accurate about
    // which one actually occurred instead of always saying "Packed".
    tagLayer(testResults, "L2", () => checkPacked(order, flowId, testResults, deliveryStateCode || "Packed"));
  } else {
    // Default/fallback: Pending (deliveryStateCode === "Pending", or order.state === "Accepted",
    // or no fulfillment state present yet).
    tagLayer(testResults, "L2", () => checkPending(order, context, testResults));
  }

  return testResults;
}
