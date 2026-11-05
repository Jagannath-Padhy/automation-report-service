/**
 * TRV14 2.0.0 reporting: every workbench flow fixture must validate cleanly, and
 * each rule must catch a broken payload. Runs fully offline: Redis is an in-memory
 * map and the workbench L0+L1 call (externalSchemaValidator) is stubbed to pass —
 * these tests cover the report service's own TRV14 rules, not the workbench L1.
 *
 * Run: npm run test:trv14
 */
import fs from "fs";
import path from "path";
import { Payload, TestResult } from "../../../types/payload";

const store = new Map<string, any>();
jest.mock("../../../utils/redisUtils", () => ({
  saveFlowData: async (s: string, f: string, t: string, k: string, v: any) => { store.set(`${s}|${f}|${t}|${k}`, v); },
  fetchFlowData: async (s: string, f: string, t: string, k: string) => store.get(`${s}|${f}|${t}|${k}`) ?? null,
  saveData: async (s: string, t: string, k: string, v: any) => { store.set(`${s}|${t}|${k}`, v); },
  fetchData: async (s: string, t: string, k: string) => store.get(`${s}|${t}|${k}`) ?? null,
}));
jest.mock("../../shared/externalSchemaValidator", () => ({
  runExternalSchemaAndL1Validation: async () => {},
  prefetchExternalValidation: () => {},
  clearExternalValidationCache: () => {},
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { validate } = require("../validator");

const dir = path.join(__dirname, "../__fixtures__");
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const byId = (p: any[], id: string) => p.find((x) => x.action_id === id).jsonRequest;

/** Validate a fixture flow step by step (as the report does) and return its L2 failures. */
async function runFlow(flowId: string, file: string, mutate: (p: any[]) => void): Promise<string[]> {
  const payloads: Payload[] = load(file);
  mutate(payloads);
  const sessionID = `trv14-test-${Math.random().toString(36).slice(2)}`;
  const failed: string[] = [];
  for (const element of payloads) {
    const result: TestResult = await validate(element, sessionID, flowId, element.action_id as string);
    failed.push(...(result.failed || []).filter((f) => f.startsWith("L2: ")));
  }
  return failed;
}

function makeExpectFail(log: string[], onBad: () => void) {
  return async (name: string, flowId: string, file: string, mutate: (p: any[]) => void, needle: string) => {
    const failed = await runFlow(flowId, file, mutate);
    const ok = failed.some((f) => f.includes(needle));
    log.push(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> L2 failures: " + JSON.stringify(failed)}`);
    if (!ok) onBad();
  };
}

describe("TRV14 2.0.0 report validations", () => {
  beforeEach(() => store.clear());

  test("every workbench flow fixture passes all TRV14 rules", async () => {
    const manifest = load("manifest.json");
    expect(manifest.flows).toHaveLength(18);
    for (const flow of manifest.flows) {
      const failed = await runFlow(flow.flowId, flow.file, () => {});
      expect({ flow: flow.flowId, failed }).toEqual({ flow: flow.flowId, failed: [] });
    }
  });

  test("Phase 3: common checks, flow sequence and state table", async () => {
    const log: string[] = [];
    let bad = 0;
    const expectFail = makeExpectFail(log, () => bad++);
    const console = { log: (m: string) => { log.push(m); if (m.startsWith("FAIL")) bad++; } };
    const PJ = ["purchase_journey_without_form", "purchase_journey_without_form.json"] as const;
    const UC = ["User Cancellation (Full)", "User_Cancellation_Full.json"] as const;
    const IP = ["incremental_pull_journey", "incremental_pull_journey.json"] as const;

    // Baseline: no L2 failures on untouched flows.
    for (const [f, file] of [PJ, UC, IP]) {
      const failed = await runFlow(f, file, () => {});
      const ok = failed.length === 0;
      console.log(`${ok ? "PASS" : "FAIL"}  baseline ${f} has no L2 failures${ok ? "" : " -> " + JSON.stringify(failed)}`);
      if (!ok) bad++;
    }
    await expectFail("on_confirm with order.status COMPLETED", ...PJ,
      (p) => { byId(p, "on_confirm").message.order.status = "COMPLETED"; }, "order.status must be ACTIVE");
    await expectFail("confirmed user cancel still SOFT_CANCEL", ...UC,
      (p) => { byId(p, "on_cancel_confirm_user_cancellation").message.order.status = "SOFT_CANCEL"; }, "order.status must be CANCELLED");
    await expectFail("init with payments PAID", ...PJ,
      (p) => { byId(p, "init").message.order.payments[0].status = "PAID"; }, "payments[].status must be NOT-PAID");
    await expectFail("on_status fulfillment still CONFIRMED", ...PJ,
      (p) => { byId(p, "on_status").message.order.fulfillments[0].state.descriptor.code = "CONFIRMED"; }, "fulfillments[].state.descriptor.code must be COMPLETED");
    await expectFail("on_select with a different message_id", ...PJ,
      (p) => { byId(p, "on_select_without_form").context.message_id = "11111111-2222-3333-4444-555555555555"; }, "must match the select request");
    await expectFail("unsolicited on_search page reusing the search message_id", ...IP,
      (p) => { byId(p, "on_search_incremental_pull_2").context.message_id = byId(p, "search_incremental_pull").context.message_id; }, "unsolicited call must carry a new message_id");
    await expectFail("ttl not an ISO duration", ...PJ,
      (p) => { byId(p, "on_init").context.ttl = "30s"; }, "ttl must be an ISO-8601 duration");
    await expectFail("city changes mid-flow", ...PJ,
      (p) => { byId(p, "on_init").context.location.city.code = "std:011"; }, "city.code 'std:011' differs");

    expect(log.filter((m) => m.startsWith("PASS")).length).toBeGreaterThan(5);
    expect(log.filter((m) => m.startsWith("FAIL"))).toEqual([]);
    expect(bad).toBe(0);
  });

  test("Phase 4: search and catalog", async () => {
    const log: string[] = [];
    let bad = 0;
    const expectFail = makeExpectFail(log, () => bad++);
    const console = { log: (m: string) => { log.push(m); if (m.startsWith("FAIL")) bad++; } };
    const IP = ["incremental_pull_journey", "incremental_pull_journey.json"] as const;
    const SP = ["seller_app_pagination_journey", "seller_app_pagination_journey.json"] as const;
    const item = (p: any[], aid: string, id: string) =>
      byId(p, aid).message.catalog.providers[0].items.find((i: any) => i.id === id);
    const pag = (p: any[], aid: string) =>
      byId(p, aid).message.catalog.tags.find((t: any) => t.descriptor.code === "PAGINATION").list;
    const setPag = (p: any[], aid: string, code: string, value: string) => {
      const entry = pag(p, aid).find((l: any) => l.descriptor.code === code);
      if (entry) entry.value = value; else pag(p, aid).push({ descriptor: { code }, value });
    };

    for (const [f, file] of [IP, SP]) {
      const failed = await runFlow(f, file, () => {});
      const ok = failed.length === 0;
      console.log(`${ok ? "PASS" : "FAIL"}  baseline ${f} has no L2 failures${ok ? "" : " -> " + JSON.stringify(failed)}`);
      if (!ok) bad++;
    }
    await expectFail("search range start after end", ...IP,
      (p) => { const r = byId(p, "search_incremental_pull").message.intent.fulfillment.stops[0].time.range; [r.start, r.end] = [r.end, r.start]; }, "time.range.start");
    await expectFail("incremental pull without REGISTER true", ...IP,
      (p) => { byId(p, "search_incremental_pull").message.intent.tags.find((t: any) => t.descriptor.code === "INCREMENTAL_PULL").list[0].value = "false"; }, "INCREMENTAL_PULL.REGISTER 'true'");
    await expectFail("fee type percent without percentage", ...SP,
      (p) => { const l = byId(p, "search_seller_pagination").message.intent.tags.find((t: any) => t.descriptor.code === "BAP_TERMS").list; l.find((x: any) => x.descriptor.code === "BUYER_FINDER_FEES_PERCENTAGE").value = "abc"; }, "BUYER_FINDER_FEES_PERCENTAGE must be a number");
    await expectFail("later page changes PAGINATION_ID", ...IP,
      (p) => setPag(p, "on_search_incremental_pull_2", "PAGINATION_ID", "P9"), "PAGINATION_ID 'P9' differs");
    await expectFail("CURRENT_PAGE_NUMBER above MAX", ...SP,
      (p) => setPag(p, "on_search_seller_pagination_2", "CURRENT_PAGE_NUMBER", "5"), "CURRENT_PAGE_NUMBER must be between 1 and MAX_PAGE_NUMBER");
    await expectFail("ENTRY_PASS with a non-ABSTRACT parent", ...IP,
      (p) => { item(p, "on_search_incremental_pull_2", "I1").parent_item_id = "I2"; }, "ENTRY_PASS item I1 must have parent_item_id");
    await expectFail("item minimum above maximum", ...SP,
      (p) => { item(p, "on_search_seller_pagination_2", "I1").quantity.minimum.count = 9; }, "quantity.minimum.count 9 is greater");
    await expectFail("add-on with a non-numeric price", ...IP,
      (p) => { item(p, "on_search_incremental_pull_2", "I1").add_ons[0].price.value = "free"; }, "add-on A1 price.value");
    await expectFail("catalog without the searched category", ...SP,
      (p) => { byId(p, "on_search_seller_pagination_1").message.catalog.providers[0].categories.forEach((c: any) => { if (c.descriptor?.code === "CULTURE_HERITAGE") c.descriptor.code = "OTHERS"; }); }, "no category with code 'CULTURE_HERITAGE'");
    await expectFail("category with unknown parent", ...IP,
      (p) => { byId(p, "on_search_incremental_pull_2").message.catalog.providers[0].categories[1].parent_category_id = "C99"; }, "parent_category_id 'C99'");

    expect(log.filter((m) => m.startsWith("PASS")).length).toBeGreaterThan(5);
    expect(log.filter((m) => m.startsWith("FAIL"))).toEqual([]);
    expect(bad).toBe(0);
  });

  test("Phase 5: select and forms", async () => {
    const log: string[] = [];
    let bad = 0;
    const expectFail = makeExpectFail(log, () => bad++);
    const console = { log: (m: string) => { log.push(m); if (m.startsWith("FAIL")) bad++; } };
    const NF = ["purchase_journey_without_form", "purchase_journey_without_form.json"] as const;
    const WF = ["purchase_journey_with_form", "purchase_journey_with_form.json"] as const;
    const OL = ["purchase_journey_order_level_forms_culture_heritage", "purchase_journey_order_level_forms_culture_heritage.json"] as const;
    const MT = ["purchase_journey_without_form_Multiple_Tickets", "purchase_journey_without_form_Multiple_Tickets.json"] as const;
    const ord = (p: any[], aid: string) => byId(p, aid).message.order;
    const ticket = (p: any[], aid: string) => ord(p, aid).items.find((i: any) => i.descriptor?.code === "ENTRY_PASS" || !i.descriptor);
    const line = (p: any[], aid: string, title: string) => ord(p, aid).quote.breakup.find((b: any) => b.title === title);

    for (const [f, file] of [NF, WF, OL, MT]) {
      const failed = await runFlow(f, file, () => {});
      const ok = failed.length === 0;
      console.log(`${ok ? "PASS" : "FAIL"}  baseline ${f} has no L2 failures${ok ? "" : " -> " + JSON.stringify(failed)}`);
      if (!ok) bad++;
    }
    await expectFail("on_select changes the ticket quantity", ...NF,
      (p) => { ticket(p, "on_select_without_form").quantity.selected.count = 3; }, "differs from the selected 1");
    await expectFail("on_select changes the provider", ...NF,
      (p) => { ord(p, "on_select_without_form").provider.id = "P9"; }, "provider.id 'P9' differs");
    await expectFail("BASE_PRICE not unit price x quantity", ...NF,
      (p) => { line(p, "on_select_without_form", "BASE_PRICE").price.value = "999"; }, "BASE_PRICE for I1 is 999");
    await expectFail("ADD_ONS not add-on price x quantity", ...NF,
      (p) => { line(p, "on_select_without_form", "ADD_ONS").price.value = "1"; }, "ADD_ONS for I1 is 1");
    await expectFail("quote without a CONVENIENCE_FEE line", ...NF,
      (p) => { const o = ord(p, "on_select_without_form"); o.quote.breakup = o.quote.breakup.filter((b: any) => b.title !== "CONVENIENCE_FEE"); }, "must carry a CONVENIENCE_FEE line");
    await expectFail("form flow on_select without item xinput", ...WF,
      (p) => { delete ticket(p, "on_select").xinput; }, "must carry xinput.form");
    await expectFail("form submission answers a form that was not offered", ...WF,
      (p) => { ticket(p, "select_form_submission").xinput.form.id = "other_form"; }, "'other_form' was not offered");
    await expectFail("form submission echo with status not SUCCESS", ...WF,
      (p) => { ticket(p, "on_select_form_submission").xinput.form_response.status = "FAILED"; }, "form_response.status must be SUCCESS");
    await expectFail("quote changes in the submission round", ...WF,
      (p) => { const q = ord(p, "on_select_form_submission").quote; line(p, "on_select_form_submission", "TAX").price.value = "10"; q.price.value = String(Number(q.price.value) + 10); }, "quote differs from on_select");
    await expectFail("flow without forms carrying xinput", ...NF,
      (p) => { ticket(p, "on_select_without_form").xinput = { form: { id: "x", mime_type: "text/html", url: "https://x.example" } }; }, "must not carry xinput");
    await expectFail("order-level form flow with an item-level form", ...OL,
      (p) => { ticket(p, "on_select_submission_cultural").xinput = { form: { id: "x" } }; }, "found items[].xinput");
    await expectFail("multiple-ticket flow selecting one ticket", ...MT,
      (p) => { ticket(p, "select").quantity.selected.count = 1; }, "must select more than one ticket");

    expect(log.filter((m) => m.startsWith("PASS")).length).toBeGreaterThan(5);
    expect(log.filter((m) => m.startsWith("FAIL"))).toEqual([]);
    expect(bad).toBe(0);
  });

  test("Phase 6: init and confirm", async () => {
    const log: string[] = [];
    let bad = 0;
    const expectFail = makeExpectFail(log, () => bad++);
    const console = { log: (m: string) => { log.push(m); if (m.startsWith("FAIL")) bad++; } };
    const NF = ["purchase_journey_without_form", "purchase_journey_without_form.json"] as const;
    const BF = ["purchase_journey_with_form (BAP Convenience fee)", "purchase_journey_with_form_BAP_Convenience_fee.json"] as const;
    const TC = ["technical_cancellation", "technical_cancellation.json"] as const;
    const ord = (p: any[], aid: string) => byId(p, aid).message.order;
    const tag = (o: any, code: string, key: string) => o.tags.find((t: any) => t.descriptor.code === code).list.find((l: any) => l.descriptor.code === key);

    for (const [f, file] of [NF, BF, TC]) {
      const failed = await runFlow(f, file, () => {});
      const ok = failed.length === 0;
      console.log(`${ok ? "PASS" : "FAIL"}  baseline ${f} has no L2 failures${ok ? "" : " -> " + JSON.stringify(failed)}`);
      if (!ok) bad++;
    }
    await expectFail("init changes the ticket quantity", ...NF,
      (p) => { ord(p, "init").items[0].quantity.selected.count = 4; }, "items/quantities");
    await expectFail("on_init quote differs from on_select", ...NF,
      (p) => { const q = ord(p, "on_init").quote; q.breakup.find((b: any) => b.title === "TAX").price.value = "10"; q.price.value = String(Number(q.price.value) + 10); }, "quote (460) differs from on_select_without_form");
    await expectFail("on_init changes the payment collector", ...NF,
      (p) => { ord(p, "on_init").payments[0].collected_by = "BPP"; }, "payments (id, collected_by, type) differ from init");
    await expectFail("wrong BPP settlement amount", ...NF,
      (p) => { tag(ord(p, "on_init"), "BPP_TERMS", "SETTLEMENT_AMOUNT").value = "450"; }, "SETTLEMENT_AMOUNT 450 must be 445.50");
    await expectFail("confirm pays less than the quote", ...NF,
      (p) => { ord(p, "confirm").payments[0].params.amount = "400"; }, "params.amount 400 must equal the quote total 450");
    await expectFail("confirm changes BPP_TERMS", ...NF,
      (p) => { tag(ord(p, "confirm"), "BPP_TERMS", "COURT_JURISDICTION").value = "Mumbai"; }, "BPP_TERMS differ from on_init");
    await expectFail("on_confirm changes the payment transaction id", ...NF,
      (p) => { ord(p, "on_confirm").payments[0].params.transaction_id = "other"; }, "payments (id, params.transaction_id, params.amount) differ from confirm");
    await expectFail("on_confirm quote differs from on_init", ...TC,
      (p) => { const q = ord(p, "on_confirm_technical_cancellation").quote; q.breakup.find((b: any) => b.title === "TAX").price.value = "5"; q.price.value = String(Number(q.price.value) + 5); }, "quote differs from on_init");
    await expectFail("on_confirm created_at after updated_at", ...NF,
      (p) => { const o = ord(p, "on_confirm"); o.created_at = "2099-01-01T00:00:00.000Z"; }, "created_at must not be after order.updated_at");
    await expectFail("ticket authorization already expired", ...NF,
      (p) => { ord(p, "on_confirm").fulfillments[0].stops[0].authorization.valid_to = "2020-01-01T00:00:00.000Z"; }, "must be after the visit time");
    await expectFail("BAP fee flow: init_bap_ convenience changes the items", ...BF,
      (p) => { ord(p, "init_bap_ convenience").items[0].id = "I9"; }, "items/quantities");

    expect(log.filter((m) => m.startsWith("PASS")).length).toBeGreaterThan(5);
    expect(log.filter((m) => m.startsWith("FAIL"))).toEqual([]);
    expect(bad).toBe(0);
  });

  test("Phase 7: status", async () => {
    const log: string[] = [];
    let bad = 0;
    const expectFail = makeExpectFail(log, () => bad++);
    const console = { log: (m: string) => { log.push(m); if (m.startsWith("FAIL")) bad++; } };
    const NF = ["purchase_journey_without_form", "purchase_journey_without_form.json"] as const;
    const TC = ["technical_cancellation", "technical_cancellation.json"] as const;
    const OL = ["purchase_journey_order_level_forms_culture_heritage", "purchase_journey_order_level_forms_culture_heritage.json"] as const;
    const ord = (p: any[], aid: string) => byId(p, aid).message.order;
    const qr = (o: any) => o.fulfillments[0].stops.find((s: any) => s.authorization).authorization;

    for (const [f, file] of [NF, TC, OL]) {
      const failed = await runFlow(f, file, () => {});
      const ok = failed.length === 0;
      console.log(`${ok ? "PASS" : "FAIL"}  baseline ${f} has no L2 failures${ok ? "" : " -> " + JSON.stringify(failed)}`);
      if (!ok) bad++;
    }
    await expectFail("status asks for a different order", ...NF,
      (p) => { byId(p, "status").message.order_id = "some-other-order"; }, "order_id 'some-other-order' must be the confirmed order");
    await expectFail("on_status returns a different order id", ...NF,
      (p) => { ord(p, "on_status").id = "some-other-order"; }, "order.id 'some-other-order' must be");
    await expectFail("on_status changes created_at", ...OL,
      (p) => { ord(p, "on_status").created_at = "2026-01-01T00:00:00.000Z"; }, "order.created_at '2026-01-01T00:00:00.000Z' must stay");
    await expectFail("on_status moves updated_at backwards", ...NF,
      (p) => { ord(p, "on_status").updated_at = "2020-01-01T00:00:00.000Z"; }, "must not be before on_confirm");
    await expectFail("on_status changes the quote", ...NF,
      (p) => { const q = ord(p, "on_status").quote; q.breakup.find((b: any) => b.title === "TAX").price.value = "7"; q.price.value = String(Number(q.price.value) + 7); }, "quote must be unchanged");
    await expectFail("on_status changes the payment amount", ...NF,
      (p) => { ord(p, "on_status").payments[0].params.amount = "1"; }, "payments (id, status, params.transaction_id, params.amount) must be unchanged");
    await expectFail("on_status issues a new ticket token", ...TC,
      (p) => { qr(ord(p, "on_status_technical_cancellation")).token = "new-token"; }, "ticket authorization (token, valid_to) must be unchanged");
    await expectFail("on_status drops a ticket", ...NF,
      (p) => { ord(p, "on_status").items[1].quantity.selected.count = 9; }, "items/quantities");

    expect(log.filter((m) => m.startsWith("PASS")).length).toBeGreaterThan(5);
    expect(log.filter((m) => m.startsWith("FAIL"))).toEqual([]);
    expect(bad).toBe(0);
  });

  test("Phase 8: cancel and update", async () => {
    const log: string[] = [];
    let bad = 0;
    const expectFail = makeExpectFail(log, () => bad++);
    const console = { log: (m: string) => { log.push(m); if (m.startsWith("FAIL")) bad++; } };
    const UC = ["User Cancellation (Full)", "User_Cancellation_Full.json"] as const;
    const TC = ["technical_cancellation", "technical_cancellation.json"] as const;
    const CR = ["Cancellation Rejected", "Cancellation_Rejected.json"] as const;
    const UN = ["Cancellation Flow(unsolicited on_cancel)", "Cancellation_Flow_unsolicited_on_cancel.json"] as const;
    const PC = ["user_cancellation_partial", "user_cancellation_partial.json"] as const;
    const msg = (p: any[], aid: string) => byId(p, aid).message;
    const ord = (p: any[], aid: string) => msg(p, aid).order;
    const ln = (o: any, title: string) => o.quote.breakup.find((b: any) => b.title === title);

    for (const [f, file] of [UC, TC, CR, UN, PC]) {
      const failed = await runFlow(f, file, () => {});
      const ok = failed.length === 0;
      console.log(`${ok ? "PASS" : "FAIL"}  baseline ${f} has no L2 failures${ok ? "" : " -> " + JSON.stringify(failed)}`);
      if (!ok) bad++;
    }
    await expectFail("cancel for a different order", ...UC,
      (p) => { msg(p, "cancel_soft_user_cancellation").order_id = "other"; }, "order_id 'other' must be the confirmed order");
    await expectFail("confirm cancel sent as SOFT_CANCEL", ...UC,
      (p) => { msg(p, "cancel_confirm_user_cancellation").descriptor.code = "SOFT_CANCEL"; }, "descriptor.code must be CONFIRM_CANCEL");
    await expectFail("confirm cancel changes the reason", ...UC,
      (p) => { msg(p, "cancel_confirm_user_cancellation").cancellation_reason_id = "002"; }, "must match cancel_soft_user_cancellation");
    await expectFail("technical cancellation with a user reason", ...TC,
      (p) => { msg(p, "cancel_soft_technical_cancellation").cancellation_reason_id = "001"; }, "must use reason 000");
    await expectFail("on_cancel reason does not echo the request", ...UC,
      (p) => { ord(p, "on_cancel_soft_user_cancellation").cancellation.reason.descriptor.code = "003"; }, "must echo cancel_soft_user_cancellation");
    await expectFail("refund does not cover the ticket", ...UC,
      (p) => { const o = ord(p, "on_cancel_soft_user_cancellation"); ln(o, "REFUND").price.value = "-400"; ln(o, "CANCELLATION_CHARGES").price.value = "95"; o.quote.price.value = "95"; }, "REFUND for I1 must be -450");
    await expectFail("user cancellation charges not the 10% fee", ...UC,
      (p) => { const o = ord(p, "on_cancel_soft_user_cancellation"); ln(o, "CANCELLATION_CHARGES").price.value = "0"; ln(o, "REFUND").price.value = "-495"; }, "CANCELLATION_CHARGES 0 must be 45");
    await expectFail("technical cancellation charging a fee", ...TC,
      (p) => { const o = ord(p, "on_cancel_soft_technical_cancellation"); ln(o, "CANCELLATION_CHARGES").price.value = "45"; o.quote.price.value = "45"; ln(o, "REFUND").price.value = "-495"; }, "CANCELLATION_CHARGES 45 must be 0");
    await expectFail("confirmed on_cancel quote differs from the soft one", ...TC,
      (p) => { const o = ord(p, "on_cancel_confirm_technical_cancellation"); ln(o, "TAX").price.value = "3"; o.quote.price.value = "3"; }, "quote must match on_cancel_soft_technical_cancellation");
    await expectFail("on_cancel changes the payment", ...UN,
      (p) => { ord(p, "on_cancel_unsolicited").payments[0].params.amount = "1"; }, "payments must be unchanged");
    await expectFail("rejected flow returns an order instead of an error", ...CR,
      (p) => { const r = byId(p, "on_cancel_rejected"); delete r.error; r.message = { order: { id: "x" } }; }, "expects the cancellation to be rejected");
    await expectFail("rejection with a non-TRV14 error code", ...CR,
      (p) => { byId(p, "on_cancel_rejected").error.code = "90203"; }, "TRV14 error code (932xx)");
    await expectFail("partial update raises the quantity", ...PC,
      (p) => { ord(p, "update_soft_partial_cancellation").items[0].quantity.selected.count = 5; }, "must be lower than the confirmed 1");
    await expectFail("partial update with a wrong target", ...PC,
      (p) => { msg(p, "update_soft_partial_cancellation").update_target = "order.fulfillments"; }, "update_target must point at order.items");
    await expectFail("on_update does not apply the new quantity", ...PC,
      (p) => { ord(p, "on_update_soft_partial_cancellation").items.find((i: any) => i.id === "I1").quantity.selected.count = 1; }, "must be the updated 0");
    await expectFail("on_update without a REFUND", ...PC,
      (p) => { const o = ord(p, "on_update_soft_partial_cancellation"); o.quote.breakup = o.quote.breakup.filter((b: any) => b.title !== "REFUND"); o.quote.price.value = "450"; }, "needs a negative REFUND for I1");
    await expectFail("confirmed on_update quote differs from the soft one", ...PC,
      (p) => { const o = ord(p, "on_update_confirm_partial_cancellation"); ln(o, "TAX").price.value = "4"; o.quote.price.value = "4"; }, "quote must match on_update_soft_partial_cancellation");

    expect(log.filter((m) => m.startsWith("PASS")).length).toBeGreaterThan(5);
    expect(log.filter((m) => m.startsWith("FAIL"))).toEqual([]);
    expect(bad).toBe(0);
  });
  test("Phase 9: gaps found in the Pramaan coverage review", async () => {
    const log: string[] = [];
    let bad = 0;
    const expectFail = makeExpectFail(log, () => bad++);
    const NF = ["purchase_journey_without_form", "purchase_journey_without_form.json"] as const;
    const UC = ["User Cancellation (Full)", "User_Cancellation_Full.json"] as const;
    const IP = ["incremental_pull_journey", "incremental_pull_journey.json"] as const;
    const ord = (p: any[], aid: string) => byId(p, aid).message.order;

    await expectFail("a request reuses an earlier request's message_id", ...NF,
      (p) => { byId(p, "confirm").context.message_id = byId(p, "init").context.message_id; byId(p, "on_confirm").context.message_id = byId(p, "init").context.message_id; }, "was already used by an earlier request");
    await expectFail("on_select drops the selected fulfillment", ...NF,
      (p) => { ord(p, "on_select_without_form").fulfillments[0].id = "F9"; ord(p, "on_select_without_form").items.forEach((i: any) => { i.fulfillment_ids = ["F9"]; }); }, "selected fulfillment F1 is missing");
    await expectFail("on_status changes the fulfillment stops", ...NF,
      (p) => { ord(p, "on_status").fulfillments[0].stops.pop(); }, "fulfillments (id, type, stop types) must be unchanged");
    await expectFail("on_cancel changes the fulfillment type", ...UC,
      (p) => { ord(p, "on_cancel_soft_user_cancellation").fulfillments[0].type = "DELIVERY"; }, "fulfillments (id, type, stop types) must be unchanged");
    await expectFail("quote breakup in a different currency", ...NF,
      (p) => { ord(p, "on_init").quote.breakup[0].price.currency = "USD"; }, "quote breakup mixes currencies");
    await expectFail("a later on_search page changes a location", ...IP,
      (p) => { byId(p, "on_search_incremental_pull_2").message.catalog.providers[0].locations[0].gps = "1.0,1.0"; }, "categories/locations differ from the first page");

    expect(log.filter((m) => m.startsWith("PASS")).length).toBe(6);
    expect(log.filter((m) => m.startsWith("FAIL"))).toEqual([]);
    expect(bad).toBe(0);
  });
});
