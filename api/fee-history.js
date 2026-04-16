const FEE_WALLET = "DuX1wcoQrJ6XypxLNq3GRrmHFAAMgCqAKbzboabyCtzB";
const EXPECTED_FEE_SOL = 0.075;
const FEE_TOLERANCE_SOL = 0.001;

const START_DATE_UTC = "2026-04-14T00:00:00Z";
const SIGNATURE_PAGE_SIZE = 100;
const MAX_PAGES = 200;
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

async function fetchSignaturesFromStartDate() {
  const startMs = new Date(START_DATE_UTC).getTime();

  let before = undefined;
  let crossedStartDate = false;
  const collected = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const options = before
      ? { limit: SIGNATURE_PAGE_SIZE, before }
      : { limit: SIGNATURE_PAGE_SIZE };

    const batch = await heliusRpc("getSignaturesForAddress", [FEE_WALLET, options]);

    if (!batch || batch.length === 0) {
      break;
    }

    for (const sig of batch) {
      if (!sig.blockTime) continue;

      const sigMs = sig.blockTime * 1000;

      if (sigMs >= startMs) {
        collected.push(sig);
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

  return collected.filter((sig) => sig.err === null && sig.blockTime);
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
    const signatures = await fetchSignaturesFromStartDate();
    const transactions = await fetchTransactions(signatures);

    const buckets = {};

    for (const tx of transactions) {
      if (!tx.blockTime) continue;

      const dayKey = getDayKeyFromUnix(tx.blockTime);

      if (!buckets[dayKey]) {
        buckets[dayKey] = {
          feeSol: 0,
          contributors: new Set(),
          feeTxCount: 0,
        };
      }

      const transfers = extractSystemTransfers(tx);

      for (const transfer of transfers) {
        if (
          transfer.destination === FEE_WALLET &&
          isFeeLikeAmount(transfer.amountSol)
        ) {
          buckets[dayKey].feeSol = Number(
            (buckets[dayKey].feeSol + transfer.amountSol).toFixed(6)
          );
          buckets[dayKey].feeTxCount += 1;

          if (transfer.source) {
            buckets[dayKey].contributors.add(transfer.source);
          }
        }
      }
    }

    const sortedDays = Object.keys(buckets).sort();

    const labels = sortedDays.map(formatLabel);
    const dailySol = sortedDays.map((dayKey) => buckets[dayKey].feeSol);
    const dailyWalletsContributing = sortedDays.map(
      (dayKey) => buckets[dayKey].contributors.size
    );

    const dailyFeeTxCount = sortedDays.map(
      (dayKey) => buckets[dayKey].feeTxCount
    );

    return res.status(200).json({
      ok: true,
      startDateUtc: START_DATE_UTC,
      labels,
      dailySol,
      dailyWalletsContributing,
      dailyFeeTxCount,
      dayCount: sortedDays.length,
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