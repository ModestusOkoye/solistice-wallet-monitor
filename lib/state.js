function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createDefaultState() {
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
  };
}

let inMemoryState = createDefaultState();

export function loadState() {
  return clone(inMemoryState);
}

export function saveState(nextState) {
  inMemoryState = clone(nextState);
  return loadState();
}

export function mergeState(patch) {
  inMemoryState = {
    ...inMemoryState,
    ...clone(patch),
    meta: {
      ...inMemoryState.meta,
      ...(patch.meta || {}),
    },
    price: {
      ...inMemoryState.price,
      ...(patch.price || {}),
    },
    registrations: {
      ...inMemoryState.registrations,
      ...(patch.registrations || {}),
    },
    recent: {
      ...inMemoryState.recent,
      ...(patch.recent || {}),
    },
    outflows: {
      ...inMemoryState.outflows,
      ...(patch.outflows || {}),
    },
  };

  return loadState();
}

export function resetState() {
  inMemoryState = createDefaultState();
  return loadState();
}