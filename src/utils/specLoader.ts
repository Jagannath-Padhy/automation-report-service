import { readFileSync, existsSync } from "fs";
import path from "path";
import yaml from "js-yaml";
import { saveActionData } from "../services/actionDataService";
import { ValidationAction } from "../types/actions";

/**
 * Save-specs for search/on_search/select/on_select/init/on_init/confirm are
 * identical across every RET1X domain (confirmed byte-for-byte, 2026-10-23) —
 * the cross-action fields these capture (context, items, provider, etc.)
 * don't vary by category. Mirrors log-validation-utility's own structure
 * (one utils/Retail folder, not one per domain, with only RET11 ever
 * carrying its own named exception) — RET10's own save-specs folder plays
 * that same "shared structure" role: a domain+version is checked first (so
 * a genuine future override still works), falling back to
 * config/save-specs/RET10/<version> when no domain-specific file exists.
 * Only applies to RET1X domains (`domain` here is already the ":"-stripped
 * key, e.g. "RET11") — non-Retail domains have genuinely distinct per-domain
 * specs, not duplicates, and are untouched.
 */
export function loadSaveSpec(domain: string, version: string, action: string): { [k: string]: any } {
  const isRetDomain = domain.startsWith("RET");
  const domainSpecific = path.resolve(
    __dirname,
    `../config/save-specs/${domain}/${version}/${action}.yaml`
  );
  const specPath =
    !isRetDomain || existsSync(domainSpecific)
      ? domainSpecific
      : path.resolve(__dirname, `../config/save-specs/RET10/${version}/${action}.yaml`);
  const content = readFileSync(specPath, "utf8");
  return yaml.load(content) as any;
}

export async function saveFromElement(
  element: any,
  sessionID: string,
  flowId: string,
  source: "jsonRequest" | "jsonResponse"
) {
  try {
    const payload = element?.[source];
    const context = payload?.context as any;
    const transactionId: string | undefined = context?.transaction_id;
    const domainKey = (context?.domain || "").split(":").pop() || "";
    const action = (context?.action || "");
    // ONDC 1.x contexts (retail/eB2B/logistics) carry `core_version`; 2.x contexts
    // (FIS/TRV) carry `version`. Reading only `version` made this function a silent
    // no-op for every 1.x domain — RETeB2B payloads declare `core_version: "1.2.5"`
    // and no `version` at all, so NOTHING was ever persisted for them and every
    // cross-call check that reads save-spec data (select-vs-on_search, the
    // on_init -> confirm term echoes, order-id continuity) skipped silently.
    // Same precedence every domain validator already uses, e.g.
    // src/validations/ONDC:FIS12/validator.ts:7.
    const version: string | undefined = context?.version || context?.core_version;
    if (transactionId && domainKey && version && action) {
      const spec = loadSaveSpec(domainKey, version, action);
      await saveActionData(sessionID,flowId, transactionId, action, payload, spec);
    }
  } catch (_) {}
}


