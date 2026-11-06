import { Payload, TestResult } from "../../../../types/payload";
import { Trv14FlowProfile } from "../flowProfiles";
import { getPreviousTrv14Order } from "../helpers";

// Business rules for select / on_select (incl. the form rounds) that the workbench
// L1 does not cover (L1 checks presence and enums). Values follow what the
// workbench (ONDC-Official draft-TRV14-2.0.0, commit ca523e5f) generates:
// on_select echoes the selection plus the ABSTRACT parent; quote BASE_PRICE =
// unit price x quantity, ADD_ONS = add-on price x add-on quantity (against the
// parent ticket), TAX and CONVENIENCE_FEE always present; item-level forms sit on
// the ENTRY_PASS items, the culture-heritage form on order.xinput.

const isSelectStep = (id: string) => id.startsWith("select");
const isOnSelectStep = (id: string) => id.startsWith("on_select");

const num = (v: any) => Number(v);
const sameAmount = (a: any, b: any) => Math.abs(num(a) - num(b)) < 0.01;

function ticketMap(order: any): Map<string, { qty: number; parent?: string; addOns: Map<string, number> }> {
  const map = new Map();
  for (const item of order?.items ?? []) {
    const code = item?.descriptor?.code;
    if (code === "ABSTRACT") continue;
    const addOns = new Map<string, number>();
    for (const a of item?.add_ons ?? []) addOns.set(a?.id, num(a?.quantity?.selected?.count));
    map.set(item?.id, { qty: num(item?.quantity?.selected?.count), parent: item?.parent_item_id, addOns });
  }
  return map;
}

function quoteSignature(quote: any): string {
  const lines = (quote?.breakup ?? [])
    .map((b: any) => `${b?.title}|${b?.item?.id ?? ""}|${num(b?.price?.value)}`)
    .sort();
  return `${num(quote?.price?.value)}#${lines.join(",")}`;
}

function formOf(order: any, form: Trv14FlowProfile["form"]): any[] {
  if (form === "ORDER_LEVEL") return order?.xinput ? [order.xinput] : [];
  return (order?.items ?? []).filter((i: any) => i?.xinput).map((i: any) => i.xinput);
}

export async function validateTrv14Select(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string,
  profile: Trv14FlowProfile,
  testResults: TestResult
): Promise<void> {
  const request = element?.jsonRequest;
  const order = request?.message?.order;
  const txnId: string | undefined = request?.context?.transaction_id;
  if (!order || !txnId) return;
  const tickets = ticketMap(order);

  let bad = 0;
  for (const [id, t] of tickets) {
    if (!Number.isInteger(t.qty) || t.qty < 1) {
      bad++;
      testResults.failed.push(`select (${actionId}): item ${id} quantity.selected.count must be a positive integer, found '${t.qty}'`);
    }
    for (const [addOnId, count] of t.addOns) {
      if (!Number.isInteger(count) || count < 1) {
        bad++;
        testResults.failed.push(`select (${actionId}): item ${id} add-on ${addOnId} quantity.selected.count must be a positive integer, found '${count}'`);
      }
    }
  }
  if (tickets.size > 0 && bad === 0) testResults.passed.push(`select (${actionId}): selected quantities are positive integers`);

  // The workbench's own select input defaults to 1 ticket in the Multiple_Tickets
  // flows too, so a single ticket is a warning, not a failure.
  if (profile.tickets === "MULTIPLE") {
    const total = [...tickets.values()].reduce((s, t) => s + (t.qty || 0), 0);
    if (total > 1) testResults.passed.push(`select (${actionId}): multiple tickets selected (${total})`);
    else testResults.passed.push(`Warning: select (${actionId}): a multiple-ticket flow selected only ${total} ticket`);
  }

  // Form submission round: same selection as the first select, answering the form
  // the previous on_select sent.
  const previousSelect = await getPreviousTrv14Order(sessionID, flowId, txnId, profile.sequence, actionId, isSelectStep);
  if (!previousSelect) return;
  const before = ticketMap(previousSelect.order);
  const sameSelection =
    before.size === tickets.size &&
    [...tickets].every(([id, t]) => before.get(id)?.qty === t.qty && before.get(id)?.parent === t.parent);
  if (sameSelection) {
    testResults.passed.push(`select (${actionId}): selection matches ${previousSelect.actionId}`);
  } else {
    testResults.failed.push(`select (${actionId}): items/quantities differ from ${previousSelect.actionId}`);
  }

  const offered = await getPreviousTrv14Order(sessionID, flowId, txnId, profile.sequence, actionId, isOnSelectStep);
  const offeredFormIds = new Set(formOf(offered?.order, profile.form).map((x: any) => x?.form?.id));
  const responses = formOf(order, profile.form);
  if (responses.length === 0) {
    testResults.failed.push(`select (${actionId}): the form submission round must carry xinput.form_response`);
    return;
  }
  for (const x of responses) {
    if (!offeredFormIds.has(x?.form?.id)) {
      testResults.failed.push(`select (${actionId}): xinput.form.id '${x?.form?.id}' was not offered in ${offered?.actionId ?? "the previous on_select"}`);
    } else if (!x?.form_response?.submission_id) {
      testResults.failed.push(`select (${actionId}): xinput.form_response.submission_id is required for form '${x?.form?.id}'`);
    } else {
      testResults.passed.push(`select (${actionId}): answers form '${x.form.id}' with a submission_id`);
    }
  }
}

export async function validateTrv14OnSelect(
  element: Payload,
  sessionID: string,
  flowId: string,
  actionId: string,
  profile: Trv14FlowProfile,
  testResults: TestResult
): Promise<void> {
  const request = element?.jsonRequest;
  const order = request?.message?.order;
  const txnId: string | undefined = request?.context?.transaction_id;
  if (!order || !txnId) return;
  const items: any[] = order.items ?? [];
  const byId = new Map(items.map((i) => [i?.id, i]));

  // Echo of the select it answers.
  const select = await getPreviousTrv14Order(sessionID, flowId, txnId, profile.sequence, actionId, isSelectStep);
  if (select) {
    if (select.order?.provider?.id && select.order.provider.id !== order?.provider?.id) {
      testResults.failed.push(`on_select (${actionId}): provider.id '${order?.provider?.id}' differs from ${select.actionId}'s '${select.order.provider.id}'`);
    }
    let mismatches = 0;
    for (const [id, t] of ticketMap(select.order)) {
      const item = byId.get(id);
      if (!item) {
        mismatches++;
        testResults.failed.push(`on_select (${actionId}): selected item ${id} is missing`);
        continue;
      }
      if (num(item?.quantity?.selected?.count) !== t.qty) {
        mismatches++;
        testResults.failed.push(`on_select (${actionId}): item ${id} quantity ${item?.quantity?.selected?.count} differs from the selected ${t.qty}`);
      }
      const echoed = new Map((item?.add_ons ?? []).map((a: any) => [a?.id, num(a?.quantity?.selected?.count)]));
      for (const [addOnId, count] of t.addOns) {
        if (echoed.get(addOnId) !== count) {
          mismatches++;
          testResults.failed.push(`on_select (${actionId}): item ${id} add-on ${addOnId} quantity ${echoed.get(addOnId)} differs from the selected ${count}`);
        }
      }
    }
    const offeredFulfillments = new Set((order?.fulfillments ?? []).map((f: any) => f?.id));
    for (const f of select.order?.fulfillments ?? []) {
      if (f?.id && !offeredFulfillments.has(f.id)) {
        mismatches++;
        testResults.failed.push(`on_select (${actionId}): selected fulfillment ${f.id} is missing from order.fulfillments`);
      }
    }
    if (mismatches === 0) testResults.passed.push(`on_select (${actionId}): echoes the provider, items, quantities, add-ons and fulfillments of ${select.actionId}`);
  }

  // Every ticket's ABSTRACT parent is part of the order; fulfillment ids exist.
  const fulfillmentIds = new Set((order.fulfillments ?? []).map((f: any) => f?.id));
  for (const item of items) {
    if (item?.descriptor?.code === "ENTRY_PASS" || item?.descriptor?.code === "ADD_ON") {
      if (byId.get(item?.parent_item_id)?.descriptor?.code !== "ABSTRACT") {
        testResults.failed.push(`on_select (${actionId}): item ${item?.id} parent '${item?.parent_item_id}' must be an ABSTRACT item in the order`);
      }
    }
    for (const fid of item?.fulfillment_ids ?? []) {
      if (!fulfillmentIds.has(fid)) testResults.failed.push(`on_select (${actionId}): item ${item?.id} fulfillment_id '${fid}' is not in order.fulfillments`);
    }
  }

  // Quote lines.
  const breakup: any[] = order?.quote?.breakup ?? [];
  let quoteProblems = 0;
  for (const item of items.filter((i) => i?.descriptor?.code === "ENTRY_PASS")) {
    const qty = num(item?.quantity?.selected?.count);
    const line = breakup.find((b) => b?.title === "BASE_PRICE" && b?.item?.id === item.id);
    if (!line) {
      quoteProblems++;
      testResults.failed.push(`on_select (${actionId}): quote has no BASE_PRICE line for item ${item.id}`);
    } else {
      if (!sameAmount(line?.price?.value, num(item?.price?.value) * qty)) {
        quoteProblems++;
        testResults.failed.push(`on_select (${actionId}): BASE_PRICE for ${item.id} is ${line?.price?.value}, expected ${item?.price?.value} x ${qty}`);
      }
      if (num(line?.item?.quantity?.selected?.count) !== qty) {
        quoteProblems++;
        testResults.failed.push(`on_select (${actionId}): BASE_PRICE item.quantity for ${item.id} is ${line?.item?.quantity?.selected?.count}, expected ${qty}`);
      }
    }
    const addOns: any[] = item?.add_ons ?? [];
    if (addOns.length > 0) {
      const expected = addOns.reduce((s, a) => s + num(a?.price?.value) * num(a?.quantity?.selected?.count), 0);
      const addOnLine = breakup.find((b) => b?.title === "ADD_ONS" && b?.item?.id === item.id);
      if (!addOnLine) {
        quoteProblems++;
        testResults.failed.push(`on_select (${actionId}): quote has no ADD_ONS line for item ${item.id}`);
      } else if (!sameAmount(addOnLine?.price?.value, expected)) {
        quoteProblems++;
        testResults.failed.push(`on_select (${actionId}): ADD_ONS for ${item.id} is ${addOnLine?.price?.value}, expected ${expected}`);
      }
    }
  }
  for (const title of ["TAX", "CONVENIENCE_FEE"]) {
    if (!breakup.some((b) => b?.title === title)) {
      quoteProblems++;
      testResults.failed.push(`on_select (${actionId}): quote must carry a ${title} line`);
    }
  }
  if (quoteProblems === 0) testResults.passed.push(`on_select (${actionId}): BASE_PRICE, ADD_ONS, TAX and CONVENIENCE_FEE lines are consistent`);

  // Forms.
  const itemForms = items.filter((i) => i?.xinput);
  const orderForm = order?.xinput;
  if (profile.form === "NONE") {
    if (itemForms.length > 0 || orderForm) testResults.failed.push(`on_select (${actionId}): a flow without forms must not carry xinput`);
    return;
  }
  if (profile.form === "ITEM_LEVEL" && orderForm) {
    testResults.failed.push(`on_select (${actionId}): this flow uses item-level forms, found order.xinput`);
  }
  if (profile.form === "ORDER_LEVEL" && itemForms.length > 0) {
    testResults.failed.push(`on_select (${actionId}): this flow uses an order-level form, found items[].xinput`);
  }
  const forms = formOf(order, profile.form);
  const previousOnSelect = await getPreviousTrv14Order(sessionID, flowId, txnId, profile.sequence, actionId, isOnSelectStep);

  if (!previousOnSelect) {
    // First round: the form is offered.
    if (profile.form === "ITEM_LEVEL") {
      const tickets = items.filter((i) => i?.descriptor?.code === "ENTRY_PASS");
      const missing = tickets.filter((i) => !i?.xinput?.form?.id).map((i) => i.id);
      if (missing.length > 0) testResults.failed.push(`on_select (${actionId}): ENTRY_PASS items ${missing.join(", ")} must carry xinput.form`);
    }
    if (forms.length === 0) testResults.failed.push(`on_select (${actionId}): the first on_select of a form flow must offer xinput.form`);
    for (const x of forms) {
      if (x?.form?.mime_type !== "text/html" || !x?.form?.url) {
        testResults.failed.push(`on_select (${actionId}): xinput.form '${x?.form?.id}' must have mime_type text/html and a url`);
      } else {
        testResults.passed.push(`on_select (${actionId}): offers form '${x.form.id}' (text/html)`);
      }
    }
    return;
  }

  // Submission round: echo the response, keep items and quote unchanged.
  const submitted = new Map(formOf(select?.order, profile.form).map((x: any) => [x?.form?.id, x?.form_response?.submission_id]));
  for (const x of forms) {
    if (x?.form_response?.status !== "SUCCESS") {
      testResults.failed.push(`on_select (${actionId}): form '${x?.form?.id}' form_response.status must be SUCCESS, found '${x?.form_response?.status}'`);
    } else if (!submitted.has(x?.form?.id)) {
      testResults.failed.push(`on_select (${actionId}): form '${x?.form?.id}' was not submitted in ${select?.actionId ?? "the previous select"}`);
    } else if (x?.form_response?.submission_id && x.form_response.submission_id !== submitted.get(x.form.id)) {
      testResults.failed.push(`on_select (${actionId}): form '${x.form.id}' submission_id differs from the submitted one`);
    } else {
      testResults.passed.push(`on_select (${actionId}): confirms form '${x.form.id}' with status SUCCESS`);
    }
  }
  if (forms.length === 0) testResults.failed.push(`on_select (${actionId}): the submission round must echo xinput.form_response`);
  if (quoteSignature(order?.quote) === quoteSignature(previousOnSelect.order?.quote)) {
    testResults.passed.push(`on_select (${actionId}): quote unchanged from ${previousOnSelect.actionId}`);
  } else {
    testResults.failed.push(`on_select (${actionId}): quote differs from ${previousOnSelect.actionId}`);
  }
}
