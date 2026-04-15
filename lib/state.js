import { Redis } from "@upstash/redis";

const redisUrl =
  process.env.UPSTASH_REDIS_KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;

const redisToken =
  process.env.UPSTASH_REDIS_KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

if (!redisUrl || !redisToken) {
  throw new Error("Missing Upstash Redis environment variables");
}

const redis = new Redis({
  url: redisUrl,
  token: redisToken,
});

const STATE_KEY = "solistice-monitor:state";

function createDefaultState() {
  return {
    meta: {
      initializedAt: new Date().toISOString(),
      lastProcessedSignature: null,
      lastSyncedAt: null,
      syncRuns: 0,
    },

    price: {
      solUsd: null,
      fetchedAt: null,
      source: null,
      stale: false,
      error: null,
    },

    registrations: {
      exactRegistrationCount: 0,
      uniqueContributorCount: 0,
      feeLikeInboundSol: 0,
      signaturesScanned: 0,
      historyLimitReached: false,
    },

    recent: {
      feeTxs: [],
      outflows: [],
      suspiciousOutflows: [],
    },

    outflows: {
      totalOutflowCount: 0,
      totalOutflowSol: 0,
      suspiciousCount: 0,
      suspiciousOutflowSol: 0,
      signaturesScanned: 0,
      historyLimitReached: false,
    },

    backfill: {
      startedAt: null,
      lastBackfilledSignature: null,
      lastBackfilledAt: null,
      runs: 0,
      completed: false,
      processedSignatures: 0,
    },

    history: {
      daily: {},
    },
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, incoming) {
  if (Array.isArray(base)) {
    return Array.isArray(incoming) ? incoming : base;
  }

  if (!isPlainObject(base)) {
    return incoming === undefined ? base : incoming;
  }

  const result = { ...base };

  for (const key of Object.keys(incoming || {})) {
    const baseValue = result[key];
    const incomingValue = incoming[key];

    if (Array.isArray(incomingValue)) {
      result[key] = incomingValue;
    } else if (isPlainObject(baseValue) && isPlainObject(incomingValue)) {
      result[key] = deepMerge(baseValue, incomingValue);
    } else if (incomingValue !== undefined) {
      result[key] = incomingValue;
    }
  }

  return result;
}

function normalizeDailyHistory(daily) {
  if (!isPlainObject(daily)) {
    return {};
  }

  const normalized = {};

  for (const [day, bucket] of Object.entries(daily)) {
    normalized[day] = {
      feeTxCount: Number(bucket?.feeTxCount || 0),
      feeSol: Number(bucket?.feeSol || 0),
      contributorAddresses: Array.isArray(bucket?.contributorAddresses)
        ? bucket.contributorAddresses
        : [],
    };
  }

  return normalized;
}

function normalizeState(rawState) {
  const defaults = createDefaultState();
  const merged = deepMerge(defaults, rawState || {});

  if (!merged.meta.initializedAt) {
    merged.meta.initializedAt = new Date().toISOString();
  }

  if (!Array.isArray(merged.recent.feeTxs)) {
    merged.recent.feeTxs = [];
  }

  if (!Array.isArray(merged.recent.outflows)) {
    merged.recent.outflows = [];
  }

  if (!Array.isArray(merged.recent.suspiciousOutflows)) {
    merged.recent.suspiciousOutflows = [];
  }

  if (!isPlainObject(merged.history)) {
    merged.history = { daily: {} };
  }

  merged.history.daily = normalizeDailyHistory(merged.history.daily);

  return merged;
}

export async function loadState() {
  try {
    const raw = await redis.get(STATE_KEY);

    if (!raw) {
      return createDefaultState();
    }

    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return normalizeState(parsed);
  } catch (error) {
    console.error("loadState failed:", error);
    return createDefaultState();
  }
}

export async function saveState(state) {
  const normalized = normalizeState(state);
  await redis.set(STATE_KEY, JSON.stringify(normalized));
  return normalized;
}

export async function mergeState(partialState) {
  const current = await loadState();
  const next = deepMerge(current, partialState || {});
  return await saveState(next);
}

export async function resetState() {
  const fresh = createDefaultState();
  await redis.set(STATE_KEY, JSON.stringify(fresh));
  return fresh;
}