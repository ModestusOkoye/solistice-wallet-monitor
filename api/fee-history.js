import { loadState, saveState } from "../lib/state";

const FEE_WALLET = "DuX1wcoQrJ6XypxLNq3GRrmHFAAMgCqAKbzboabyCtzB";
const EXPECTED_FEE_SOL = 0.075;
const FEE_TOLERANCE_SOL = 0.001;

const SIGNATURE_PAGE_SIZE = 25;
const FORWARD_PAGE_LIMIT = 2;
const FORWARD_TX_LIMIT = 12;

const BOOTSTRAP_PAGE_LIMIT = 1;
const BOOTSTRAP_TX_LIMIT = 12;

const TX_DELAY_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function isFeeLikeAmount(amountSol) {
  return Math.abs(amountSol - EXPECTED_FEE_SOL) <= FEE_TOLERANCE_SOL;
}

function getDayKeyFromUnix(blockTime) {
  return new Date(blockTime * 1000).toISOString().slice(0, 10);
}

function formatLabel(dayKey) {
  const date = new Date(`${dayKey}T00:00:00Z`);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
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

function ensureChartBucket(state, dayKey) {
  if (!state.chart) {
    state.chart = {
      startDateUtc: "2026-04-14T00:00:00Z",
      newestProcessedSignature: null,
      bootstrapCursor: null,
      bootstrapCompleted: false,
      lastUpdatedAt: null,
      daily: {},
    };
  }

  if (!state.chart.daily) {
    state.chart.daily = {};
  }

  if (!state.chart.daily[dayKey]) {
    state.chart.daily[dayKey] = {
      feeTxCount: 0,
      feeSol: 0,
      contributorAddresses: [],
    };
  }

  return state.chart.daily[dayKey];
}

function addFeeDepositToChart(state, tx, transfer) {
  if (!tx.blockTime) return;

  const dayKey = getDayKeyFromUnix(tx.blockTime);
  const bucket = ensureChartBucket(state, dayKey);

  bucket.feeTxCount += 1;
  bucket.feeSol = Number((bucket.feeSol + transfer.amountSol).toFixed(6));

  if (transfer.source && !bucket.contributorAddresses.includes(transfer.source)) {
    bucket.contributorAddresses.push(transfer.source);
  }
}

async function fetchSingleTransaction(sigObj) {
  try {
    const tx = await heliusRpc("getTransaction", [
      sigObj.signature,
      {
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0,
      },
    ]);

    if (!tx) return null;

    return {
      ...tx,
      signature: sigObj.signature,
      blockTime: sigObj.blockTime || tx.blockTime || null,
    };
  } catch (error) {
    const message = String(error?.message || "");

    if (message.includes("429") || message.includes("403")) {
      return { skipped: true, signature: sigObj.signature };
    }

    return null;
  }
}

async function fetchForwardSignatures(newestProcessedSignature) {
  let before = undefined;
  let hitCursor = false;
  const collected = [];

  for (let page = 0; page < FORWARD_PAGE_LIMIT; page++) {
    const options = before
      ? { limit: SIGNATURE_PAGE_SIZE, before }
      : { limit: SIGNATURE_PAGE_SIZE };

    const batch = await heliusRpc("getSignaturesForAddress", [FEE_WALLET, options]);

    if (!batch || batch.length === 0) {
      break;
    }

    for (const sigObj of batch) {
      if (newestProcessedSignature && sigObj.signature === newestProcessedSignature) {
        hitCursor = true;
        break;
      }

      collected.push(sigObj);
    }

    if (hitCursor) {
      break;
    }

    if (batch.length < SIGNATURE_PAGE_SIZE) {
      break;
    }

    before = batch[batch.length - 1].signature;
  }

  return collected
    .filter((sig) => sig.err === null && sig.blockTime)
    .slice(0, FORWARD_TX_LIMIT);
}

async function processForwardUpdates(state) {
  const newestProcessedSignature = state.chart?.newestProcessedSignature || null;
  const forwardSignatures = await fetchForwardSignatures(newestProcessedSignature);

  if (forwardSignatures.length === 0) {
    return {
      processed: 0,
      skipped: 0,
    };
  }

  const newestSignatureSeen = forwardSignatures[0].signature;
  const oldestSignatureSeen = forwardSignatures[forwardSignatures.length - 1].signature;

  let processed = 0;
  let skipped = 0;

  for (const sigObj of [...forwardSignatures].reverse()) {
    const tx = await fetchSingleTransaction(sigObj);

    if (tx?.skipped) {
      skipped += 1;
      break;
    }

    if (!tx) {
      continue;
    }

    const transfers = extractSystemTransfers(tx);

    for (const transfer of transfers) {
      if (
        transfer.destination === FEE_WALLET &&
        isFeeLikeAmount(transfer.amountSol)
      ) {
        addFeeDepositToChart(state, tx, transfer);
      }
    }

    processed += 1;
    await sleep(TX_DELAY_MS);
  }

  state.chart.newestProcessedSignature = newestSignatureSeen;

  if (!state.chart.bootstrapCursor) {
    state.chart.bootstrapCursor = oldestSignatureSeen;
  }

  return {
    processed,
    skipped,
  };
}

async function fetchBootstrapSignatures(cursorSignature, startDateUtc) {
  if (!cursorSignature) {
    return [];
  }

  const startMs = new Date(startDateUtc).getTime();
  let before = cursorSignature;
  const collected = [];
  let crossedStartDate = false;

  for (let page = 0; page < BOOTSTRAP_PAGE_LIMIT; page++) {
    const batch = await heliusRpc("getSignaturesForAddress", [
      FEE_WALLET,
      {
        limit: SIGNATURE_PAGE_SIZE,
        before,
      },
    ]);

    if (!batch || batch.length === 0) {
      break;
    }

    for (const sigObj of batch) {
      if (!sigObj.blockTime) continue;

      const sigMs = sigObj.blockTime * 1000;

      if (sigMs >= startMs) {
        collected.push(sigObj);
      } else {
        crossedStartDate = true;
        break;
      }
    }

    if (crossedStartDate) {
      break;
    }

    if (batch.length < SIGNATURE_PAGE_SIZE) {
      break;
    }

    before = batch[batch.length - 1].signature;
  }

  return {
    signatures: collected
      .filter((sig) => sig.err === null && sig.blockTime)
      .slice(0, BOOTSTRAP_TX_LIMIT),
    crossedStartDate,
  };
}

async function processBootstrapUpdates(state) {
  const startDateUtc = state.chart?.startDateUtc || "2026-04-14T00:00:00Z";

  if (state.chart?.bootstrapCompleted) {
    return {
      processed: 0,
      skipped: 0,
      completed: true,
    };
  }

  if (!state.chart?.bootstrapCursor) {
    return {
      processed: 0,
      skipped: 0,
      completed: false,
    };
  }

  const { signatures, crossedStartDate } = await fetchBootstrapSignatures(
    state.chart.bootstrapCursor,
    startDateUtc
  );

  if (signatures.length === 0) {
    if (crossedStartDate) {
      state.chart.bootstrapCompleted = true;
    }

    return {
      processed: 0,
      skipped: 0,
      completed: !!state.chart.bootstrapCompleted,
    };
  }

  let processed = 0;
  let skipped = 0;

  for (const sigObj of signatures) {
    const tx = await fetchSingleTransaction(sigObj);

    if (tx?.skipped) {
      skipped += 1;
      break;
    }

    if (!tx) {
      continue;
    }

    const transfers = extractSystemTransfers(tx);

    for (const transfer of transfers) {
      if (
        transfer.destination === FEE_WALLET &&
        isFeeLikeAmount(transfer.amountSol)
      ) {
        addFeeDepositToChart(state, tx, transfer);
      }
    }

    processed += 1;
    state.chart.bootstrapCursor = sigObj.signature;
    await sleep(TX_DELAY_MS);
  }

  if (crossedStartDate) {
    state.chart.bootstrapCompleted = true;
  }

  return {
    processed,
    skipped,
    completed: !!state.chart.bootstrapCompleted,
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
    const state = await loadState();

    if (!state.chart) {
      state.chart = {
        startDateUtc: "2026-04-14T00:00:00Z",
        newestProcessedSignature: null,
        bootstrapCursor: null,
        bootstrapCompleted: false,
        lastUpdatedAt: null,
        daily: {},
      };
    }

    const forward = await processForwardUpdates(state);
    const bootstrap = await processBootstrapUpdates(state);

    state.chart.lastUpdatedAt = new Date().toISOString();
    await saveState(state);

    const sortedDays = Object.keys(state.chart.daily || {}).sort();

    const labels = sortedDays.map(formatLabel);
    const dailySol = sortedDays.map((dayKey) => Number(state.chart.daily[dayKey].feeSol || 0));
    const dailyWalletsContributing = sortedDays.map(
      (dayKey) => Array.isArray(state.chart.daily[dayKey].contributorAddresses)
        ? state.chart.daily[dayKey].contributorAddresses.length
        : 0
    );
    const dailyFeeTxCount = sortedDays.map(
      (dayKey) => Number(state.chart.daily[dayKey].feeTxCount || 0)
    );

    return res.status(200).json({
      ok: true,
      labels,
      dailySol,
      dailyWalletsContributing,
      dailyFeeTxCount,
      dayCount: sortedDays.length,
      chartStartDateUtc: state.chart.startDateUtc,
      newestProcessedSignature: state.chart.newestProcessedSignature,
      bootstrapCursor: state.chart.bootstrapCursor,
      bootstrapCompleted: state.chart.bootstrapCompleted,
      forwardProcessed: forward.processed,
      forwardSkipped: forward.skipped,
      bootstrapProcessed: bootstrap.processed,
      bootstrapSkipped: bootstrap.skipped,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Unknown fee history error",
    });
  }
}