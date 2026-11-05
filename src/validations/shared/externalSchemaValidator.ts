import axios from "axios";
import http from "http";
import https from "https";
import logger from "@ondc/automation-logger";
import { TestResult } from "../../types/payload";
import { ConcurrencyLimiter } from "../../utils/concurrencyLimiter";

// Routed through automation-frontend/backend's POST /flow/validate/:action,
// per explicit instruction (2026-10-21) — this proxies to
// `${API_SERVICE}/${domain}/${version}/test/${action}` with no added logic
// (confirmed by reading flowController.validatePayload: no auth, no
// transformation, domain/version read straight from the payload body).
// Note: benchmarked both paths with a real payload — calling API_SERVICE
// directly averaged ~1.27s vs ~1.63s through this route (an extra network
// hop, same destination). Keeping this route per the explicit request.
const AUTOMATION_BACKEND_BASE =
  process.env.AUTOMATION_BACKEND || "https://dev-workbench.ondc.tech/backend-ui";

// Halved from the original 10000ms specifically because of the retry below
// (EXTERNAL_VALIDATE_MAX_ATTEMPTS): worst case per action is now
// attempts × this value, so halving it keeps that worst case at the same
// ~10s total as before a single attempt ever had — the retry only buys a
// second chance within that same budget, it doesn't add to it.
const EXTERNAL_VALIDATE_TIMEOUT_MS = 5000;

// Caps how many of these calls are in flight at once, regardless of how many
// flows/actions report generation parallelizes above this layer (see
// prefetchExternalValidation and validationModule.ts's flow-level
// parallelism) — protects the downstream API_SERVICE/backend-ui instance
// from being hit with every action of every flow simultaneously.
const EXTERNAL_VALIDATE_CONCURRENCY = Number(process.env.EXTERNAL_VALIDATE_CONCURRENCY) || 10;
const limiter = new ConcurrencyLimiter(EXTERNAL_VALIDATE_CONCURRENCY);

// Reuse TCP/TLS connections to the same host instead of paying a fresh
// handshake on every one of these calls.
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: EXTERNAL_VALIDATE_CONCURRENCY });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: EXTERNAL_VALIDATE_CONCURRENCY });

type ValidationOutcome =
  | { kind: "pass"; action: string }
  | { kind: "fail"; action: string; message: string }
  | { kind: "missing-context" }
  | { kind: "http-error"; action: string; status: number }
  | { kind: "unexpected-shape"; action: string }
  | { kind: "error"; action: string; message: string };

// Memoizes the outcome per unique payload (keyed off its own context, since
// callers only ever have the raw jsonRequest, not a DB-assigned payloadId at
// this layer) so a prefetched call and the validator's own later call for
// the same payload share one network round trip instead of two.
const resultCache = new Map<string, Promise<ValidationOutcome>>();

function getCacheKey(jsonPayload: Record<string, any> | undefined | null): string | null {
  const context = jsonPayload?.context;
  if (!context?.transaction_id || !context?.message_id || !context?.action) return null;
  return `${context.transaction_id}_${context.message_id}_${context.action}`;
}

// A timeout/connection failure against the shared dev-workbench backend is
// usually a transient load blip, not a dead server — the benchmark comment
// above shows normal latency is ~1.3-1.6s, so hitting the 10s timeout is
// already anomalous, and a single retry costs far less than the minutes of
// cumulative wall time a whole flow's worth of first-attempt timeouts added
// up to (confirmed from a real session: a 10s timeout on the external call
// for just one action, repeated across ~150 actions in an 11-flow report,
// was the dominant cost). Retrying a real 5xx from the server too, since
// that's the same "server having trouble right now" signal. Not retrying on
// a real ACK/NACK response — that's a genuine verdict, not a transient
// failure, and must not be retried into a different answer.
const EXTERNAL_VALIDATE_MAX_ATTEMPTS = 2;

async function performExternalValidationAttempt(
  url: string,
  jsonPayload: Record<string, any>,
  action: string
): Promise<{ outcome: ValidationOutcome | null; retryable: boolean }> {
  try {
    const response = await limiter.run(() =>
      axios.post(url, jsonPayload, {
        timeout: EXTERNAL_VALIDATE_TIMEOUT_MS,
        validateStatus: () => true, // we inspect the ACK/NACK body ourselves
        httpAgent,
        httpsAgent,
      })
    );

    const body = response.data;
    const ackStatus = body?.message?.ack?.status;

    if (response.status >= 500) {
      return { outcome: { kind: "http-error", action, status: response.status }, retryable: true };
    }

    if (ackStatus === "NACK") {
      const errCode = body?.error?.code;
      const errMessage = body?.error?.message || JSON.stringify(body?.error) || "NACK with no error detail";
      return {
        outcome: {
          kind: "fail",
          action,
          message: `${action} failed schema/L1 validation${errCode ? ` [${errCode}]` : ""} — ${errMessage}`,
        },
        retryable: false,
      };
    }

    if (ackStatus === "ACK") {
      return { outcome: { kind: "pass", action }, retryable: false };
    }

    return { outcome: { kind: "unexpected-shape", action }, retryable: false };
  } catch (error: any) {
    logger.error(`Error calling external schema/L1 validator for ${action}`, {}, error);
    return { outcome: { kind: "error", action, message: error?.message || String(error) }, retryable: true };
  }
}

async function performExternalValidation(
  jsonPayload: Record<string, any>
): Promise<ValidationOutcome> {
  const context = jsonPayload?.context;
  const domain = context?.domain;
  const version = context?.version || context?.core_version;
  const action = context?.action;

  if (!domain || !version || !action) {
    return { kind: "missing-context" };
  }

  const url = `${AUTOMATION_BACKEND_BASE}/flow/validate/${action}`;

  let lastOutcome: ValidationOutcome = { kind: "error", action, message: "never attempted" };
  for (let attempt = 1; attempt <= EXTERNAL_VALIDATE_MAX_ATTEMPTS; attempt++) {
    const { outcome, retryable } = await performExternalValidationAttempt(url, jsonPayload, action);
    lastOutcome = outcome as ValidationOutcome;
    if (!retryable || attempt === EXTERNAL_VALIDATE_MAX_ATTEMPTS) break;
    logger.error(
      `Retrying external schema/L1 validator for ${domain}/${version}/${action} (attempt ${attempt} of ${EXTERNAL_VALIDATE_MAX_ATTEMPTS} failed)`,
      {},
      lastOutcome
    );
  }
  return lastOutcome;
}

function applyOutcome(outcome: ValidationOutcome, testResults: TestResult, checkLabel: string): void {
  switch (outcome.kind) {
    case "missing-context":
      testResults.failed.push(
        `${checkLabel}: cannot call external validator — context.domain/version/action missing from payload`
      );
      return;
    case "http-error":
      testResults.failed.push(
        `${checkLabel}: external validator call failed (HTTP ${outcome.status}) for ${outcome.action}`
      );
      return;
    case "fail":
      testResults.failed.push(`${checkLabel}: ${outcome.message}`);
      return;
    case "pass":
      testResults.passed.push(`${checkLabel}: ${outcome.action} passed schema + L1 validation`);
      return;
    case "unexpected-shape":
      testResults.failed.push(
        `${checkLabel}: unexpected response shape from external validator for ${outcome.action} (no message.ack.status)`
      );
      return;
    case "error":
      testResults.failed.push(
        `${checkLabel}: external validator call errored for ${outcome.action} — ${outcome.message}`
      );
      return;
  }
}

/**
 * Runs the project's own L0 (schema) + L1 (JVAL business rules) validation
 * for a single action/on_action payload, and merges the verdict into
 * testResults in place (same convention every other custom check in this
 * service already uses: mutate testResults.passed/testResults.failed).
 *
 * domain/version/action are taken from the payload's own context so callers
 * don't need to re-derive them.
 *
 * If prefetchExternalValidation already kicked off this same payload's call
 * (same flow, earlier in processPayloads), this just awaits that in-flight
 * promise instead of firing a second request.
 */
export async function runExternalSchemaAndL1Validation(
  jsonPayload: Record<string, any>,
  testResults: TestResult,
  checkLabel = "L0+L1 (schema + JVAL business rules)"
): Promise<void> {
  const key = getCacheKey(jsonPayload);

  let promise = key ? resultCache.get(key) : undefined;
  if (!promise) {
    promise = performExternalValidation(jsonPayload);
    if (key) resultCache.set(key, promise);
  }

  const outcome = await promise;
  applyOutcome(outcome, testResults, checkLabel);
}

/**
 * Fires the L0+L1 external validation call for every payload in a flow up
 * front, concurrently (bounded by the shared limiter above), instead of
 * waiting for each action's sequential business-logic pass to reach it one
 * at a time. Each payload only needs its own data for this check — unlike
 * the business-logic checks ported from log-validation-utility, it has no
 * dependency on a prior action's saved Redis state — so it's safe to run
 * every action's schema/L1 check for a flow in parallel.
 *
 * Fire-and-forget: callers don't await this. The later, in-order
 * runExternalSchemaAndL1Validation call for the same payload picks up the
 * already-in-flight (or already-resolved) result from the cache.
 */
export function prefetchExternalValidation(
  jsonPayloads: Array<Record<string, any> | undefined | null>
): void {
  for (const jsonPayload of jsonPayloads) {
    if (!jsonPayload) continue;
    const key = getCacheKey(jsonPayload);
    if (!key || resultCache.has(key)) continue;
    resultCache.set(key, performExternalValidation(jsonPayload));
  }
}

/**
 * resultCache is a module-level singleton (shared across every report
 * generation this process handles), so it must be cleared once a report
 * finishes — otherwise every session's payload keys accumulate for the
 * lifetime of the process. Call this once after validationModule() finishes
 * processing all of a session's flows.
 */
export function clearExternalValidationCache(): void {
  resultCache.clear();
}
