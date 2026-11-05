import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { loadConfig } from "./configLoader";
import { assignActionIds, detectDomainVersion, logsToPayloads, LogsInputError, parseLogsFile } from "./logsAdapter";

// Contexts of a real downloaded Buyer_Initiated_Return run (messages stripped — the adapter
// only reads context).
const birLogs = JSON.parse(
  fs.readFileSync(path.join(__dirname, "__fixtures__/bir-logs.json"), "utf8")
);
const BIR = "Buyer_Initiated_Return_(Full_Order_and_Partial_Order)";

describe("logsAdapter", () => {
  const config = loadConfig("ONDC:RETeB2B", "1.2.5");

  it("maps a downloaded BIR logs file to payloads with the spec's action_ids", () => {
    const entries = parseLogsFile(birLogs);
    assert.deepEqual(detectDomainVersion(entries), { domain: "ONDC:RETeB2B", version: "1.2.5" });

    const payloads = assignActionIds(
      logsToPayloads(entries, BIR),
      config.flows[BIR],
      config.flow_action_ids[BIR]
    );

    assert.equal(payloads.length, 18);
    const times = payloads.map((p) => new Date(p.createdAt).getTime());
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
    assert.deepEqual(
      payloads.map((p) => p.action_id),
      config.flow_action_ids[BIR]
    );
    assert.deepEqual(payloads[13].jsonResponse, { response: { message: { ack: { status: "ACK" } } } });
  });

  it("keeps an action_id supplied in the log entry and falls back to action when unmatched", () => {
    const entries = parseLogsFile([
      { ...birLogs[0], action_id: "select_custom" },
      birLogs[1],
    ]);
    const payloads = assignActionIds(logsToPayloads(entries, "x"), ["select"], ["select"]);
    assert.deepEqual(payloads.map((p) => p.action_id), ["select_custom", "on_select"]);
  });

  it("accepts the { request, response } log shape", () => {
    const [entry] = parseLogsFile([{ request: birLogs[0].req, response: { message: {} } }]);
    assert.deepEqual(entry.res, { response: { message: {} } });
  });

  it("rejects unusable logs files", () => {
    assert.throws(() => parseLogsFile({}), LogsInputError);
    assert.throws(() => parseLogsFile([]), LogsInputError);
    assert.throws(() => parseLogsFile([{ req: {} }]), LogsInputError);
    const otherTxn = { req: { context: { ...birLogs[1].req.context, transaction_id: "other" } } };
    assert.throws(() => parseLogsFile([birLogs[0], otherTxn]), /exactly one transaction/);
  });

  it("aligns every RETeB2B flow_action_ids list 1:1 with its flow steps", () => {
    for (const [flowId, steps] of Object.entries<string[]>(config.flows)) {
      const ids: string[] = config.flow_action_ids[flowId];
      assert.ok(ids, `${flowId} has no flow_action_ids`);
      assert.equal(ids.length, steps.length, `${flowId} length mismatch`);
      steps.forEach((step, i) =>
        assert.ok(ids[i].startsWith(step), `${flowId}[${i}]: ${ids[i]} is not a ${step} step`)
      );
    }
  });
});
