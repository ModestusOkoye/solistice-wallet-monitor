const FEE_WALLET = "DuX1wcoQrJ6XypxLNq3GRrmHFAAMgCqAKbzboabyCtzB";
const EXPECTED_FEE_SOL = 0.075;
const DAYS_TO_SHOW = 14;
const PAGE_SIZE = 1000;
const MAX_PAGES = 12;

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

function formatDayLabel(date) {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function buildLastNDays(days) {
  const labels = [];
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    labels.push(formatDayLabel(d));
  }

  return labels;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  try {
    const labels = buildLastNDays(DAYS_TO_SHOW);
    const startDate = new Date();
    startDate.setUTCHours(0, 0, 0, 0);
    startDate.setUTCDate(startDate.getUTCDate() - (DAYS_TO_SHOW - 1));

    const startTimestamp = Math.floor(startDate.getTime() / 1000);

    let before = undefined;
    let allRelevantSigs = [];

    for (let page = 0; page < MAX_PAGES; page++) {
      const options = before
        ? { limit: PAGE_SIZE, before }
        : { limit: PAGE_SIZE };

      const batch = await heliusRpc("getSignaturesForAddress", [FEE_WALLET, options]);

      if (!batch || batch.length === 0) {
        break;
      }

      for (const sig of batch) {
        if (sig.blockTime && sig.blockTime >= startTimestamp) {
          allRelevantSigs.push(sig);
        }
      }

      const oldest = batch[batch.length - 1];
      if (!oldest?.blockTime || oldest.blockTime < startTimestamp) {
        break;
      }

      before = oldest.signature;
    }

    const dayMap = {};
    for (const label of labels) {
      dayMap[label] = 0;
    }

    for (const sig of allRelevantSigs) {
      if (!sig.blockTime) continue;

      const label = formatDayLabel(new Date(sig.blockTime * 1000));
      if (label in dayMap) {
        dayMap[label] += 1;
      }
    }

    const dailyFeePayments = labels.map((label) => dayMap[label] || 0);
    const dailySol = dailyFeePayments.map((count) =>
      Number((count * EXPECTED_FEE_SOL).toFixed(3))
    );

    return res.status(200).json({
      ok: true,
      wallet: FEE_WALLET,
      labels,
      dailyFeePayments,
      dailyWalletsContributing: dailyFeePayments,
      dailySol,
      expectedFeeSol: EXPECTED_FEE_SOL,
      scannedTransactions: allRelevantSigs.length,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Unknown server error",
    });
  }
}