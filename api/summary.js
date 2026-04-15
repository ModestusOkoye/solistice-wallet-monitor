const FEE_WALLET = "DuX1wcoQrJ6XypxLNq3GRrmHFAAMgCqAKbzboabyCtzB";
const EXPECTED_FEE_SOL = 0.075;
const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd";

// Change this to 60 * 60 * 1000 if you want 1 hour
const PRICE_TTL_MS = 30 * 60 * 1000;

// Soft in-memory cache.
// This usually survives between requests on a warm instance,
// but it is not guaranteed across every cold start.
let priceCache = {
  solUsd: null,
  fetchedAtMs: 0,
  source: null,
};

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

  // If refresh failed but we already have an older cached price,
  // keep using it instead of returning N/A.
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

  // No fresh price and no cached price available
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
    const [balanceResult, signaturesResult, priceInfo] = await Promise.all([
      heliusRpc("getBalance", [FEE_WALLET]),
      heliusRpc("getSignaturesForAddress", [FEE_WALLET, { limit: 10 }]),
      getSolPriceUsd(),
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
      balanceSol: Number(balanceSol.toFixed(4)),
      totalCollectedSol: Number(balanceSol.toFixed(4)),
      totalCollectedUsd,
      solUsd: priceInfo.solUsd,
      priceSource: priceInfo.priceSource,
      priceError: priceInfo.priceError,
      priceFetchedAt: priceInfo.priceFetchedAt,
      priceFromCache: priceInfo.fromCache,
      priceStale: priceInfo.stale,
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