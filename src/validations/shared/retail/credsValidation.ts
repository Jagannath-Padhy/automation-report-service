import { TestResult } from "../../../types/payload";

/**
 * Ported from log-validation-utility's repeated "credsWithProviderId" block
 * (utils/Retail_.1.2.5/{Confirm/onConfirm,Cancel/onCancel,Update/onUpdate,
 * Status/onStatus*}.ts — the same ~15 lines copy-pasted into every one of
 * those files). There, a provider's /on_search `creds` were saved once and
 * then compared on every later message that carries a `provider` object,
 * gated by `flow === FLOW017` (that project's id for Seller_Cred_Flow).
 *
 * First ported as purely payload-driven (any provider that advertised creds
 * in /on_search), on the assumption that a provider's creds are catalog
 * metadata that should stay consistent regardless of flow. Real session
 * data proved that assumption wrong for this environment: the same shared
 * catalog/provider is reused across every flow in a session, but on_confirm/
 * on_cancel/on_update/on_status only bother constructing a creds block when
 * the flow under test is actually exercising Seller_Cred_Flow — every other
 * flow's mock responses simply omit provider.creds, and that's normal, not
 * a defect. So this needs the flow-name gate after all, matching the
 * original.
 */
function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

export function isSellerCredFlow(flowId: string | undefined): boolean {
  return /seller.?cred/i.test(flowId || "");
}

export function checkProviderCredsConsistency(
  order: any,
  onSearchData: any,
  flowId: string | undefined,
  label: string,
  testResults: TestResult
): void {
  if (!isSellerCredFlow(flowId)) return;

  const providers = Array.isArray(onSearchData?.providers)
    ? onSearchData.providers
    : onSearchData?.providers
    ? [onSearchData.providers]
    : [];
  const matchedProvider = providers.find((p: any) => p?.id === order?.provider?.id);
  const expectedCreds = matchedProvider?.creds;
  if (!Array.isArray(expectedCreds) || expectedCreds.length === 0) return;

  const actualCreds = order?.provider?.creds;
  if (!Array.isArray(actualCreds) || actualCreds.length === 0) {
    testResults.failed.push(`${label}: provider.creds is missing — /on_search advertised creds for this provider`);
  } else if (!deepEqual(expectedCreds, actualCreds)) {
    testResults.failed.push(`${label}: provider.creds mismatches the creds advertised in /on_search`);
  } else {
    testResults.passed.push(`${label}: provider.creds matches /on_search`);
  }
}
