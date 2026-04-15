import { loadState, mergeState } from "../lib/state";

const FEE_WALLET = "DuX1wcoQrJ6XypxLNq3GRrmHFAAMgCqAKbzboabyCtzB";
const EXPECTED_FEE_SOL = 0.075;
const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd";

const PRICE_TTL_MS = 30 * 60 * 1000;

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
        source: "coingecko",
        error: `CoinGecko HTTP ${response.status}`,
      };
    }

    const data = await response.json();
    const solUsd = data?.solana?.usd;

    if (typeof solUsd !== "number") {
      return {
        solUsd: null,
        source: "coingecko",
        error: "SOL price missing in CoinGecko response",
      };
    }

    return {
      solUsd,
      source: "coingecko",
      error: null,
    };
  } catch (error) {
    return {
      solUsd: null,
      source: "coingecko",
      error: error.message || "Unknown CoinGecko fetch error",
    };
  }
}

async function getPriceFromState() {
  const state = loadState();
  const now = Date.now();

  const cachedSolUsd = state.price?.solUsd ?? null;
  const cachedFetchedAt = state.price?.fetchedAt
    ? new Date(state.price.fetchedAt).getTime()
    : 0;

  const cacheIsFresh =
    cachedSolUsd !== null &&
    cachedFetchedAt &&
    now - cachedFetchedAt < PRICE_TTL_MS;

  if (cacheIsFresh) {
    return {
      solUsd: cachedSolUsd,
      priceSource: state.price.source,
      priceError: null,
      priceFetchedAt: state.price.fetchedAt,
      priceFromCache: true,
      priceStale: false,
    };
  }

  const fresh = await fetchFreshSolPriceUsd();

  if (fresh.solUsd !== null) {
    const fetchedAt = new Date().toISOString();

    mergeState({
      price: {
        solUsd: fresh.solUsd,
        fetchedAt,
        source: fresh.source,
        stale: false,
        error: null,
      },
    });

    return {
      solUsd: fresh.solUsd,
      priceSource: fresh.source,
      priceError: null,
      priceFetchedAt: fetchedAt,
      priceFromCache: false,
      priceStale: false,
    };
  }

  if (cachedSolUsd !== null) {
    mergeState({
      price: {
        ...state.price,
        stale: true,
        error: fresh.error,
      },
    });

    return {
      solUsd: cachedSolUsd,
      priceSource: state.price.source,
      priceError: fresh.error,
      priceFetchedAt: state.price.fetchedAt,
      priceFromCache: true,
      priceStale: true,
    };
  }

  return {
    solUsd: null,
    priceSource: fresh.source,
    priceError: fresh.error,
    priceFetchedAt: null,
    priceFromCache: false,
    priceStale: false,
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
    const [balanceResult, priceInfo] = await Promise.all([
      heliusRpc("getBalance", [FEE_WALLET]),
      getPriceFromState(),
    ]);

    const state = loadState();

    const balanceLamports = balanceResult?.value ?? 0;
    const balanceSol = balanceLamports / 1_000_000_000;

    const totalCollectedUsd =
      priceInfo.solUsd !== null
        ? Number((balanceSol * priceInfo.solUsd).toFixed(2))
        : null;

    return res.status(200).json({
      ok: true,
      wallet: FEE_WALLET,
      expectedFeeSol: EXPECTED_FEE_SOL,

      balanceSol: Number(balanceSol.toFixed(4)),
      totalCollectedSol: Number(balanceSol.toFixed(4)),
      totalCollectedUsd,

      solUsd: priceInfo.solUsd,
      priceSource: priceInfo.priceSource,
      priceError: priceInfo.priceError,
      priceFetchedAt: priceInfo.priceFetchedAt,
      priceFromCache: priceInfo.priceFromCache,
      priceStale: priceInfo.priceStale,

      exactRegistrationCount: state.registrations.exactRegistrationCount,
      uniqueContributorCount: state.registrations.uniqueContributorCount,
      feeLikeInboundSol: state.registrations.feeLikeInboundSol,
      registrationScanCount: state.registrations.signaturesScanned,
      registrationHistoryLimitReached: state.registrations.historyLimitReached,

      registrationsEstimate: Math.floor(balanceSol / EXPECTED_FEE_SOL),

      recentTxs: state.recent.feeTxs || [],

      lastSyncedAt: state.meta.lastSyncedAt,
      lastProcessedSignature: state.meta.lastProcessedSignature,
      syncRuns: state.meta.syncRuns,

      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Unknown server error",
    });
  }
}