const FEE_WALLET = "DuX1wcoQrJ6XypxLNq3GRrmHFAAMgCqAKbzboabyCtzB";
const CREATION_SIGNATURE =
  "4Q8JY8eswgGqmGc4E4btwJ9VPHoAgi7gPLFxx4SngauPsXSKsMm5UHkzfz4SY8fs8VM79Pozfp947c2s7xaUXy2s";

const EXPECTED_FEE_SOL = 0.075;
const FEE_TOLERANCE_SOL = 0.001;
const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd";

const PRICE_TTL_MS = 30 * 60 * 1000;
const REGISTRATION_STATS_TTL_MS = 5 * 60 * 1000;
const SIGNATURE_PAGE_SIZE = 1000;
const MAX_SIGNATURE_PAGES = 8;
const TX_BATCH_SIZE = 100;

let priceCache = {
  solUsd: null,
  fetchedAtMs: 0,
  source: null,
};

let registrationStatsCache = {
  data: null,
  fetchedAtMs: 0,
};

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function heliusRpc(method, params) {
  const apiKey = process.env.HELIUS_API_KEY;

  if (!apiKey) {
    throw new Error("Missing HELIUS_API_KEY environment variable");
  }

  const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(`Helius HTTP error: ${response.status}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error.message || "Helius RPC error");
  }

  return data.result;
}

async function heliusRpcBatch(calls) {
  const apiKey = process.env.HELIUS_API_KEY;

  if (!apiKey) {
    throw new Error("Missing HELIUS_API_KEY environment variable");
  }

  const payload = calls.map((call, index) => ({
    jsonrpc: "2.0",
    id: index + 1,
    method: call.method,
    params: call.params,
  }));

  const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Helius batch HTTP error: ${response.status}`);
  }

  const data = await response.json();

  if (!Array.isArray(data)) {
    throw new Error("Unexpected Helius batch response");
  }

  const byId = new Map(data.map((item) => [item.id, item]));

  return calls.map((_, index) => {
    const item = byId.get(index + 1);
    if (!item || item.error) return null;
    return item.result;
  });
}

function extractAllInstructions(tx) {
  const outer = tx?.transaction?.message?.instructions || [];
  const innerGroups = tx?.meta?.innerInstructions || [];
  const inner = innerGroups.flatMap((group) => group.instructions || []);
  return [...outer, ...inner];
}

function extractSystemTransfers(tx) {
  const instructions = extractAllInstructions(tx);
  const found = [];

  for (const instruction of instructions) {
    if (instruction?.program !== "system") continue;
    if (instruction?.parsed?.type !== "transfer") continue;

    const info = instruction?.parsed?.info || {};
    const source = info.source;
    const destination = info.destination;
    const lamports = Number(info.lamports || 0);

    if (!source || !destination || !lamports) continue;

    found.push({
      source,
      destination,
      amountSol: lamports / 1_000_000_000,
    });
  }

  const deduped = new Map();

  for (const item of found) {
    const key = `${item.source}-${item.destination}-${item.amountSol}`;
    if (!deduped.has(key)) {
      deduped.set(key, item);
    }
  }

  return Array.from(deduped.values());
}

function isFeeLikeAmount(amountSol) {
  return Math.abs(amountSol - EXPECTED_FEE_SOL) <= FEE_TOLERANCE_SOL;
}

async function fetchAllFeeWalletSignatures() {
  let before = undefined;
  const all = [];
  let limitReached = false;

  for (let page = 0; page < MAX_SIGNATURE_PAGES; page++) {
    const options = before
      ? { limit: SIGNATURE_PAGE_SIZE, before }
      : { limit: SIGNATURE_PAGE_SIZE };

    const batch = await heliusRpc("getSignaturesForAddress", [FEE_WALLET, options]);

    if (!batch || batch.length === 0) {
      break;
    }

    all.push(...batch);

    if (batch.length < SIGNATURE_PAGE_SIZE) {
      break;
    }

    before = batch[batch.length - 1].signature;

    if (page === MAX_SIGNATURE_PAGES - 1) {
      limitReached = true;
    }
  }

  return { signatures: all, limitReached };
}

async function fetchTransactionsFromSignatures(signatureObjects) {
  const successful = signatureObjects.filter((sig) => sig.err === null);
  const chunks = chunkArray(successful, TX_BATCH_SIZE);
  const transactions = [];

  for (const chunk of chunks) {
    const results = await heliusRpcBatch(
      chunk.map((sigObj) => ({
        method: "getTransaction",
        params: [
          sigObj.signature,
          {
            encoding: "jsonParsed",
            maxSupportedTransactionVersion: 0,
          },
        ],
      }))
    );

    results.forEach((tx, index) => {
      if (!tx) return;

      transactions.push({
        ...tx,
        signature: chunk[index].signature,
        blockTime: chunk[index].blockTime || tx.blockTime || null,
      });
    });
  }

  return transactions;
}

async function scanRegistrationStats() {
  const { signatures, limitReached } = await fetchAllFeeWalletSignatures();
  const transactions = await fetchTransactionsFromSignatures(signatures);

  let exactRegistrationCount = 0;
  const contributorSet = new Set();
  let feeLikeInboundSol = 0;

  for (const tx of transactions) {
    if (tx.signature === CREATION_SIGNATURE) {
      continue;
    }

    const transfers = extractSystemTransfers(tx);

    for (const transfer of transfers) {
      if (transfer.destination !== FEE_WALLET) continue;
      if (!isFeeLikeAmount(transfer.amountSol)) continue;

      exactRegistrationCount += 1;
      feeLikeInboundSol += transfer.amountSol;

      if (transfer.source) {
        contributorSet.add(transfer.source);
      }
    }
  }

  return {
    exactRegistrationCount,
    uniqueContributorCount: contributorSet.size,
    feeLikeInboundSol: Number(feeLikeInboundSol.toFixed(6)),
    signaturesScanned: signatures.length,
    historyLimitReached: limitReached,
  };
}

async function getRegistrationStats() {
  const now = Date.now();

  if (
    registrationStatsCache.data &&
    now - registrationStatsCache.fetchedAtMs < REGISTRATION_STATS_TTL_MS
  ) {
    return registrationStatsCache.data;
  }

  const data = await scanRegistrationStats();

  registrationStatsCache = {
    data,
    fetchedAtMs: now,
  };

  return data;
}

async function fetchFreshSolPriceUsd() {
  try {
    const response = await fetch(COINGECKO_URL, {
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      return {
        solUsd: null,
        priceSource: "coingecko",
        priceError: `CoinGecko HTTP ${response.status}`,
      };
    }

    const data = await response.json();
    const solUsd = data?.solana?.usd;

    if (typeof solUsd !== "number") {
      return {
        solUsd: null,
        priceSource: "coingecko",
        priceError: "SOL price missing in CoinGecko response",
      };
    }

    return {
      solUsd,
      priceSource: "coingecko",
      priceError: null,
    };
  } catch (error) {
    return {
      solUsd: null,
      priceSource: "coingecko",
      priceError: error.message || "Unknown CoinGecko fetch error",
    };
  }
}

async function getSolPriceUsd() {
  const now = Date.now();
  const cacheIsFresh =
    priceCache.solUsd !== null &&
    now - priceCache.fetchedAtMs < PRICE_TTL_MS;

  if (cacheIsFresh) {
    return {
      solUsd: priceCache.solUsd,
      priceSource: priceCache.source,
      priceError: null,
      fromCache: true,
      stale: false,
      priceFetchedAt: new Date(priceCache.fetchedAtMs).toISOString(),
    };
  }

  const fresh = await fetchFreshSolPriceUsd();

  if (fresh.solUsd !== null) {
    priceCache = {
      solUsd: fresh.solUsd,
      fetchedAtMs: now,
      source: fresh.priceSource,
    };

    return {
      solUsd: fresh.solUsd,
      priceSource: fresh.priceSource,
      priceError: null,
      fromCache: false,
      stale: false,
      priceFetchedAt: new Date(now).toISOString(),
    };
  }

  if (priceCache.solUsd !== null) {
    return {
      solUsd: priceCache.solUsd,
      priceSource: priceCache.source,
      priceError: fresh.priceError || "Price refresh failed, using cached price",
      fromCache: true,
      stale: true,
      priceFetchedAt: new Date(priceCache.fetchedAtMs).toISOString(),
    };
  }

  return {
    solUsd: null,
    priceSource: fresh.priceSource,
    priceError: fresh.priceError || "No price available",
    fromCache: false,
    stale: false,
    priceFetchedAt: null,
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  try {
    const [balanceResult, signaturesResult, priceInfo, registrationStats] =
      await Promise.all([
        heliusRpc("getBalance", [FEE_WALLET]),
        heliusRpc("getSignaturesForAddress", [FEE_WALLET, { limit: 10 }]),
        getSolPriceUsd(),
        getRegistrationStats(),
      ]);

    const balanceLamports = balanceResult?.value ?? 0;
    const balanceSol = balanceLamports / 1_000_000_000;

    const totalCollectedUsd =
      priceInfo.solUsd !== null
        ? Number((balanceSol * priceInfo.solUsd).toFixed(2))
        : null;

    const recentTxs = (signaturesResult || []).map((tx) => ({
      signature: tx.signature,
      blockTime: tx.blockTime,
      err: tx.err,
    }));

    return res.status(200).json({
      ok: true,
      wallet: FEE_WALLET,
      expectedFeeSol: EXPECTED_FEE_SOL,
      feeToleranceSol: FEE_TOLERANCE_SOL,
      balanceSol: Number(balanceSol.toFixed(4)),
      totalCollectedSol: Number(balanceSol.toFixed(4)),
      totalCollectedUsd,
      solUsd: priceInfo.solUsd,
      priceSource: priceInfo.priceSource,
      priceError: priceInfo.priceError,
      priceFetchedAt: priceInfo.priceFetchedAt,
      priceFromCache: priceInfo.fromCache,
      priceStale: priceInfo.stale,
      exactRegistrationCount: registrationStats.exactRegistrationCount,
      uniqueContributorCount: registrationStats.uniqueContributorCount,
      feeLikeInboundSol: registrationStats.feeLikeInboundSol,
      registrationScanCount: registrationStats.signaturesScanned,
      registrationHistoryLimitReached: registrationStats.historyLimitReached,
      registrationsEstimate: Math.floor(balanceSol / EXPECTED_FEE_SOL),
      recentTxs,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Unknown server error",
    });
  }
}