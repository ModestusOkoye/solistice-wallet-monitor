const FEE_WALLET = "DuX1wcoQrJ6XypxLNq3GRrmHFAAMgCqAKbzboabyCtzB";
const EXPECTED_FEE_SOL = 0.075;
const FEE_TOLERANCE_SOL = 0.001;

const DAY_WINDOW = 2; // yesterday + today
const SIGNATURE_PAGE_SIZE = 100;
const MAX_PAGES = 10;
const MAX_TX_FETCH = 300;
const TX_BATCH_SIZE = 10;

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

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function getUtcDayKeyFromUnix(blockTime) {
  return new Date(blockTime * 1000).toISOString().slice(0, 10);
}

function getRecentDayKeys(windowDays = DAY_WINDOW) {
  const keys = [];

  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - i);
    keys.push(d.toISOString().slice(0, 10));
  }

  return keys;
}

function formatLabel(dayKey) {
  const date = new Date(`${dayKey}T00:00:00Z`);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function isFeeLikeAmount(amountSol) {
  return Math.abs(amountSol - EXPECTED_FEE_SOL) <= FEE_TOLERANCE_SOL;
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

async function fetchRecentSignatures() {
  const dayKeys = getRecentDayKeys(DAY_WINDOW);
  const oldestNeededDay = dayKeys[0];
  const oldestNeededMs = new Date(`${oldestNeededDay}T00:00:00Z`).getTime();

  let before = undefined;
  const collected = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const options = before
      ? { limit: SIGNATURE_PAGE_SIZE, before }
      : { limit: SIGNATURE_PAGE_SIZE };

    const batch = await heliusRpc("getSignaturesForAddress", [FEE_WALLET, options]);

    if (!batch || batch.length === 0) break;

    collected.push(...batch);

    const oldest = batch[batch.length - 1];
    const oldestMs = oldest?.blockTime ? oldest.blockTime * 1000 : null;

    if (oldestMs !== null && oldestMs < oldestNeededMs) {
      break;
    }

    if (batch.length < SIGNATURE_PAGE_SIZE) {
      break;
    }

    before = batch[batch.length - 1].signature;

    if (collected.length >= MAX_TX_FETCH) {
      break;
    }
  }

  return collected
    .filter((sig) => sig.err === null && sig.blockTime)
    .filter((sig) => sig.blockTime * 1000 >= oldestNeededMs)
    .slice(0, MAX_TX_FETCH);
}

async function fetchTransactions(signatureObjects) {
  const chunks = chunkArray(signatureObjects, TX_BATCH_SIZE);
  const transactions = [];

  for (const chunk of chunks) {
    const batchResults = await Promise.all(
      chunk.map(async (sigObj) => {
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
        } catch {
          return null;
        }
      })
    );

    transactions.push(...batchResults.filter(Boolean));
  }

  return transactions;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  try {
    const recentDayKeys = getRecentDayKeys(DAY_WINDOW);
    const buckets = {};

    for (const dayKey of recentDayKeys) {
      buckets[dayKey] = {
        feeSol: 0,
        contributors: new Set(),
      };
    }

    const signatures = await fetchRecentSignatures();
    const transactions = await fetchTransactions(signatures);

    for (const tx of transactions) {
      if (!tx.blockTime) continue;

      const dayKey = getUtcDayKeyFromUnix(tx.blockTime);
      if (!buckets[dayKey]) continue;

      const transfers = extractSystemTransfers(tx);

      for (const transfer of transfers) {
        if (
          transfer.destination === FEE_WALLET &&
          isFeeLikeAmount(transfer.amountSol)
        ) {
          buckets[dayKey].feeSol = Number(
            (buckets[dayKey].feeSol + transfer.amountSol).toFixed(6)
          );

          if (transfer.source) {
            buckets[dayKey].contributors.add(transfer.source);
          }
        }
      }
    }

    const labels = recentDayKeys.map(formatLabel);
    const dailySol = recentDayKeys.map((dayKey) => buckets[dayKey].feeSol);
    const dailyWalletsContributing = recentDayKeys.map(
      (dayKey) => buckets[dayKey].contributors.size
    );

    return res.status(200).json({
      ok: true,
      labels,
      dailySol,
      dailyWalletsContributing,
      dayCount: recentDayKeys.length,
      scannedSignatureCount: signatures.length,
      scannedTransactionCount: transactions.length,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Unknown fee history error",
    });
  }
}