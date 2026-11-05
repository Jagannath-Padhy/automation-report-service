import jsonpath from "jsonpath";

export type SaveSpec = Record<string, string> | { 'save-data': Record<string, string> };

export function extractBySpec(payload: any, spec: SaveSpec): Record<string, any> {
  const extracted: Record<string, any> = {};
  if (!spec) return extracted;

  // Handle the case where spec has a 'save-data' key (from YAML files)
  const specData = (spec as any)['save-data'] || spec;
  
  for (const key of Object.keys(specData)) {
    const path = specData[key];
    try {
      const result = jsonpath.query(payload, path);
      // jsonpath.query always returns an array, even for a path that targets
      // a single scalar/object field — unwrap those back to their natural
      // type. But a path using a wildcard/array selector (e.g. "...[*]")
      // means the caller wants a list, and must stay a list even when there
      // happens to be exactly one match — collapsing it to a bare object
      // breaks any downstream code that calls .find()/.map() on it.
      const isArrayPath = /\[\*\]|\[\d*:\d*\]/.test(path);
      extracted[key] =
        Array.isArray(result) && !isArrayPath && result.length === 1 ? result[0] : result;
    } catch (error) {
      console.error(`Error extracting data for key '${key}' with path '${path}':`, error);
      extracted[key] = null;
    }
  }
  return extracted;
}


