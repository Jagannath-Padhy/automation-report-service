import { RedisService } from "@ondc/ondc-automation-cache-lib";
import logger from "@ondc/automation-logger";
// Function to save data under sessionId and transactionId

/**
 * Saves key value pairs under sessionId and transactionId.
 * @param {string} sessionId - The session ID.
 * @param {string} transactionId - The transaction ID.
 * @param {string} key - The key to add.
 * @param {string} value - The value to add.
 */

export const saveFlowData = async (
  sessionId: string,
  flowId: string,
  transactionId: string,
  key: string,
  value: Record<string, any> // Accept JSON object
): Promise<void> => {
  try {
    // pramaan-validation-parity skill: key scoping fixed 2026-08-25 — see gap-patterns.md.
    // search/on_search are scoped by (sessionId, flowId) only, NOT transactionId. Some BAP/BPP
    // pairs issue a fresh transaction_id per search round within the same flow (refine-and-
    // research before select), so a transaction-scoped key silently "loses" earlier rounds'
    // data the moment a later round's transaction_id differs — this was the root cause of a
    // reported false failure ("Form ID ... not found in any previous action. Checked: on_search
    // (no data found)") in select.ts's `getActionData(sessionID, flowId, txnId, "on_search")`
    // call. Every write to this key OVERWRITES the previous one, so a flow-scoped key also means
    // "latest on_search wins" for anything read back from it — consistent with the same
    // latest-on_search philosophy already applied in flowContinuityValidators.ts's
    // checkOrderTrailAgainstOnSearch. Every other action keeps transactionId in its key: FIS12's
    // select/init/confirm/etc. only ever run once per transaction within a flow, so there's no
    // equivalent multi-round collision for them.
    const redisKey =
      key === "on_search" || key === "search"
        ? `${sessionId}:${flowId}:${key}`
        : `${sessionId}:${flowId}:${transactionId}:${key}`;

    // Serialize the JSON object to a string
    const serializedValue = JSON.stringify(value);

    // Save the serialized value with optional TTL
    await RedisService.setKey(redisKey, serializedValue, 3600);
  } catch (error) {
    logger.error("Error saving data",
      {error,
      meta: { sessionId, flowId, transactionId, key }
    });
  }
};

// Function to fetch data for a specific key under sessionId and transactionId
export const fetchFlowData = async (
  sessionId: string,
  flowId: string,
  transactionId: string,
  key: string
): Promise<Record<string, any> | null> => {
  try {
    // See the matching comment in saveFlowData above — this must mirror that key exactly.
    const redisKey =
      key === "on_search" || key === "search"
        ? `${sessionId}:${flowId}:${key}`
        : `${sessionId}:${flowId}:${transactionId}:${key}`;


    // Fetch the serialized value
    const serializedValue = await RedisService.getKey(redisKey);

    if (!serializedValue) {
      // Most real flows (e.g. everything starting at `select`) don't run
      // search/on_search under their own transaction_id at all — the catalog
      // was discovered in a separate flow/transaction earlier in the same
      // session. For search/on_search specifically, fall back to any other
      // on_search saved anywhere in this session before giving up, since the
      // key format for these two is already transaction-scoped only (no
      // flowId), making a session-wide lookup meaningful.
      if (key === "on_search" || key === "search") {
        return await fetchFlowDataSessionWide(sessionId, key);
      }
      logger.error(`No data found for key: ${redisKey}`,
        {meta: { sessionId, flowId, transactionId, key }
      });
      return null;
    }
    // Deserialize the JSON object
    const value = JSON.parse(serializedValue);

    return value;
  } catch (error) {
    logger.error("Error fetching data",
      {error,
      meta: { sessionId, flowId, transactionId, key }
    });
    return null;
  }
};

// Session-wide fallback for keys whose redisKey format omits flowId
// (currently only "search"/"on_search" — see fetchFlowData above). Looks for
// any transaction in this session that saved this key, since the discovery
// step for a standalone order/select-first flow typically happened under a
// different transaction entirely.
const fetchFlowDataSessionWide = async (
  sessionId: string,
  key: string
): Promise<Record<string, any> | null> => {
  try {
    const matchingKeys = await RedisService.getAllKeys(`${sessionId}:*:${key}`);
    if (!matchingKeys || matchingKeys.length === 0) {
      logger.error(`No session-wide data found for key pattern: ${sessionId}:*:${key}`,
        { meta: { sessionId, key } }
      );
      return null;
    }
    // A session commonly has more than one on_search — a full-catalog
    // discovery plus one or more incremental catalog refreshes (city "*",
    // often only a partial item diff). matchingKeys[0] is whatever order
    // Redis happens to return, so picking it blindly could hand a later
    // /select the incremental snapshot instead of the full catalog,
    // producing false "item not available" failures for items that are
    // genuinely in the catalog but just absent from that particular delta.
    // Prefer the first full (non-"*") catalog snapshot; only fall back to
    // whatever's available if every match is an incremental one.
    let fallback: Record<string, any> | null = null;
    for (const matchKey of matchingKeys) {
      const serializedValue = await RedisService.getKey(matchKey);
      if (!serializedValue) continue;
      const parsed = JSON.parse(serializedValue);
      if (!fallback) fallback = parsed;
      if (parsed?.context?.city !== "*") return parsed;
    }
    return fallback;
  } catch (error) {
    logger.error("Error fetching session-wide flow data",
      { error, meta: { sessionId, key } }
    );
    return null;
  }
};

export const saveData = async (
  sessionId: string,
  transactionId: string,
  key: string,
  value: Record<string, any> // Accept JSON object
): Promise<void> => {
  try {
    // Create a unique key in the format sessionId:transactionId:key
    const redisKey = `${sessionId}:${transactionId}:${key}`;

    // Serialize the JSON object to a string
    const serializedValue = JSON.stringify(value);

    // Save the serialized value with optional TTL
    await RedisService.setKey(redisKey, serializedValue, 3600);
  } catch (error) {
    logger.error("Error saving data",
      {error,
      meta: { sessionId, transactionId, key }
    });
  }
};

// Function to fetch data for a specific key under sessionId and transactionId
export const fetchData = async (
  sessionId: string,
  transactionId: string,
  key: string
): Promise<Record<string, any> | null> => {
  try {
    const redisKey = `${sessionId}:${transactionId}:${key}`;

    // Fetch the serialized value
    const serializedValue = await RedisService.getKey(redisKey);

    if (!serializedValue) {
        logger.error(`No data found for key: ${redisKey}`,
        {meta: { sessionId, transactionId, key }
      });
      return null;
    }
    // Deserialize the JSON object
    const value = JSON.parse(serializedValue);

    return value;
  } catch (error) {
    logger.error("Error fetching data",
      {error,
      meta: { sessionId, transactionId, key }
    });
    return null;
  }
};

const sessionTransactionMap = new Map<
  string,
  Map<string, { transactionId: string }[]>
>();

/**
 * Add a transaction ID to a session's flow.
 * @param {string} sessionId - The session ID.
 * @param {string} flowId - The flow ID.
 * @param {string} transactionId - The transaction ID to add.
 */
export const addTransactionId = async (
  sessionId: string,
  flowId: string,
  transactionId: string
) => {
  // Check if the sessionId exists; initialize with a new Map containing the flowId if it doesn't

  try {
    if (!sessionTransactionMap.has(sessionId)) {
      const flowMap = new Map<string, { transactionId: string }[]>();
      flowMap.set(flowId, []);
      sessionTransactionMap.set(sessionId, flowMap);
    }

    // Get the flow map for the session
    const flowMap = sessionTransactionMap.get(sessionId);

    if (!flowMap?.has(flowId)) {
      flowMap?.set(flowId, []);
    }

    const transactions = flowMap?.get(flowId) ?? [];

    // Check if the transactionId already exists
    const isDuplicate = transactions.some(
      (t) => t.transactionId === transactionId
    );

    if (!isDuplicate) {
      transactions.push({ transactionId });
    }

    flowMap?.set(flowId, transactions); // Ensure the updated list is stored

    // Convert the nested structure to an object for storage in Redis
    const sessionData = Object.fromEntries(flowMap?.entries() || []);

    await RedisService.setKey(
      `${sessionId}:transactionMap`,
      JSON.stringify(sessionData)
    );
  } catch (error) {
    logger.error("Error adding transaction ID",
      {error,
      meta: { sessionId, flowId, transactionId }
    });
  }
};

/**
 * Get all transaction IDs for a specific session and flow.
 * @param {string} sessionId - The session ID.
 * @param {string} flowId - The flow ID.
 * @returns {Promise<string[]>} - Array of transaction IDs for the session and flow.
 */
export const getTransactionIds = async (
  sessionId: string,
  flowId: string
): Promise<string[]> => {
  // Retrieve session data from Redis
  const sessionTransactionData = await RedisService.getKey(
    `${sessionId}:transactionMap`
  );

  if (!sessionTransactionData) {
    logger.error(`No transaction data found for session "${sessionId}".`,
      {meta: { sessionId, flowId }
    });
    return [];
  }

  // Parse the data as a nested object structure
  const sessionData: Record<string, { transactionId: string }[]> = JSON.parse(
    sessionTransactionData
  );

  // Check if the flowId exists in the session data
  const transactions = sessionData[flowId];

  if (!transactions) {
      logger.error(`No transactions found for flow "${flowId}" in session "${sessionId}".`,
      {meta: { sessionId, flowId }
    });
    return [];
  }

  // Extract only the transactionId values and return them
  return transactions.map((transaction) => transaction.transactionId);
};

export async function updateApiMap(
  sessionID: string,
  transactionId: string,
  action: string
) {
  // Fetch the current apiMap
  try {
    let apiMap = await fetchData(sessionID, transactionId, "apiMap");

    // Extract the `value` field
    apiMap = apiMap?.value;
    // If apiMap exists, push the new action
    if (apiMap && apiMap.length > 0) {
      apiMap.push(action);
    } else {
      // If apiMap does not exist, initialize it with the new action
      apiMap = [action];
    }
    // Save the updated apiMap
    await saveData(sessionID, transactionId, "apiMap", { value: apiMap });
  } catch (error: any) {
    logger.error("Error updating API map",
     { error,
      meta: { sessionID, transactionId, action }
    });
  }
}