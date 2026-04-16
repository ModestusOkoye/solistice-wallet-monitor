import { loadState, mergeState } from "../lib/state";

const FEE_WALLET = "DuX1wcoQrJ6XypxLNq3GRrmHFAAMgCqAKbzboabyCtzB";
const EXPECTED_FEE_SOL = 0.075;
const FEE_TOLERANCE_SOL = 0.001;
const PRICE_CACHE_TTL_MS = 30 * 60 * 1000;

const LIVE_RECENT_TX_LIMIT = 10;
const LIVE_SIGNATURE_PAGE_SIZE = 25;
const LIVE_MAX_PAGES = 3;

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

async function fetchSolPriceFromCoinGecko() {
  const response = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
  );

  if (!response.ok) {
    throw new Error(`CoinGecko HTTP ${response.status}`);
  }

  const data = await response.json();
  const solUsd = data?.solana?.usd;

  if (typeof solUsd !== "number") {
    throw new Error("CoinGecko returned an invalid SOL price");
  }

  return Number(solUsd);
}

function isFreshPrice(priceState) {
  if (!priceState?.fetchedAt || priceState?.solUsd == null) {
    return false;
  }

  const fetchedAtMs = new Date(priceState.fetchedAt).getTime();
  if (Number.isNaN(fetchedAtMs)) {
    return false;
  }

  return Date.now() - fetchedAtMs < PRICE_CACHE_TTL_MS;
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

function buildRecentFeeTxRow(tx) {
  return {
    signature: tx.signature,
    blockTime: tx.blockTime || null,
    err: null,
  };
}

async function fetchLiveRecentFeeTxs() {
  let before = undefined;
  const rows = [];

  for (let page = 0; page < LIVE_MAX_PAGES; page++) {
    const options = before
      ? { limit: LIVE_SIGNATURE_PAGE_SIZE, before }
      : { limit: LIVE_SIGNATURE_PAGE_SIZE };

    const signatures = await heliusRpc("getSignaturesForAddress", [FEE_WALLET, options]);

    if (!signatures || signatures.length === 0) {
      break;
    }

    const successful = signatures.filter((sig) => sig.err === null);

    for (const sigObj of successful) {
      if (rows.length >= LIVE_RECENT_TX_LIMIT) {
        break;
      }

      try {
        const tx = await heliusRpc("getTransaction", [
          sigObj.signature,
          {
            encoding: "jsonParsed",
            maxSupportedTransactionVersion: 0,
          },
        ]);

        if (!tx) {
          continue;
        }

        const fullTx = {
          ...tx,
          signature: sigObj.signature,
          blockTime: sigObj.blockTime || tx.blockTime || null,
        };

        const transfers = extractSystemTransfers(fullTx);
        const hasFeeDeposit = transfers.some(
          (transfer) =>
            transfer.destination === FEE_WALLET &&
            isFeeLikeAmount(transfer.amountSol)
        );

        if (hasFeeDeposit) {
          rows.push(buildRecentFeeTxRow(fullTx));
        }
      } catch (error) {
        const message = String(error?.message || "");

        if (message.includes("429") || message.includes("403")) {
          break;
        }
      }
    }

    if (rows.length >= LIVE_RECENT_TX_LIMIT) {
      break;
    }

    if (signatures.length < LIVE_SIGNATURE_PAGE_SIZE) {
      break;
    }

    before = signatures[signatures.length - 1].signature;
  }

  return rows.slice(0, LIVE_RECENT_TX_LIMIT);
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  try {
    let state = await loadState();

    const balanceResult = await heliusRpc("getBalance", [FEE_WALLET]);
    const balanceSol = Number((balanceResult.value / 1_000_000_000).toFixed(4));

    let solUsd = null;
    let priceSource = state.price?.source || null;
    let priceError = null;
    let priceFetchedAt = state.price?.fetchedAt || null;
    let priceFromCache = false;
    let priceStale = false;

    if (isFreshPrice(state.price)) {
      solUsd = Number(state.price.solUsd);
      priceSource = state.price.source || "cache";
      priceFetchedAt = state.price.fetchedAt;
      priceFromCache = true;
      priceStale = false;
    } else {
      try {
        solUsd = await fetchSolPriceFromCoinGecko();
        priceSource = "coingecko";
        priceFetchedAt = new Date().toISOString();
        priceFromCache = false;
        priceStale = false;
        priceError = null;

        await mergeState({
          price: {
            solUsd,
            fetchedAt: priceFetchedAt,
            source: priceSource,
            stale: false,
            error: null,
          },
        });

        state = await loadState();
      } catch (error) {
        priceError = error.message || "Failed to fetch SOL price";

        if (state.price?.solUsd != null) {
          solUsd = Number(state.price.solUsd);
          priceSource = state.price.source || "cache";
          priceFetchedAt = state.price.fetchedAt || null;
          priceFromCache = true;
          priceStale = true;

          await mergeState({
            price: {
              ...state.price,
              stale: true,
              error: priceError,
            },
          });

          state = await loadState();
        } else {
          solUsd = null;
          priceSource = "coingecko";
          priceFetchedAt = null;
          priceFromCache = false;
          priceStale = true;
        }
      }
    }

    let recentTxs = state.recent?.feeTxs || [];

    try {
      const liveRecentTxs = await fetchLiveRecentFeeTxs();
      if (liveRecentTxs.length > 0) {
        recentTxs = liveRecentTxs;
      }
    } catch (error) {
      console.error("Live recent fee tx fetch failed:", error);
    }

    const totalCollectedSol = balanceSol;
    const totalCollectedUsd =
      solUsd != null ? Number((totalCollectedSol * solUsd).toFixed(2)) : null;

    return res.status(200).json({
      ok: true,
      wallet: FEE_WALLET,
      expectedFeeSol: EXPECTED_FEE_SOL,
      balanceSol,
      totalCollectedSol,
      totalCollectedUsd,
      solUsd,
      priceSource,
      priceError,
      priceFetchedAt,
      priceFromCache,
      priceStale,
      exactRegistrationCount: state.registrations?.exactRegistrationCount || 0,
      uniqueContributorCount: state.registrations?.uniqueContributorCount || 0,
      feeLikeInboundSol: state.registrations?.feeLikeInboundSol || 0,
      registrationScanCount: state.registrations?.signaturesScanned || 0,
      registrationHistoryLimitReached:
        state.registrations?.historyLimitReached || false,
      registrationsEstimate: Math.floor(totalCollectedSol / EXPECTED_FEE_SOL),
      recentTxs,
      lastSyncedAt: state.meta?.lastSyncedAt || null,
      lastProcessedSignature: state.meta?.lastProcessedSignature || null,
      syncRuns: state.meta?.syncRuns || 0,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Unknown summary error",
    });
  }
}