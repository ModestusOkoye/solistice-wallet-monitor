const FEE_WALLET = "DuX1wcoQrJ6XypxLNq3GRrmHFAAMgCqAKbzboabyCtzB";
const DAYS_TO_SEARCH = 30;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

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

function isLikelySolanaAddress(value) {
  return typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function extractParsedInstructions(tx) {
  const outer = tx?.transaction?.message?.instructions || [];
  const innerGroups = tx?.meta?.innerInstructions || [];

  const inner = innerGroups.flatMap((group) => group.instructions || []);
  return [...outer, ...inner];
}

function extractTransfersToFeeWallet(tx, searchedWallet) {
  const instructions = extractParsedInstructions(tx);
  const matches = [];

  for (const instruction of instructions) {
    const program = instruction?.program;
    const parsed = instruction?.parsed;

    if (!parsed || program !== "system") continue;
    if (parsed.type !== "transfer") continue;

    const info = parsed.info || {};
    const source = info.source;
    const destination = info.destination;
    const lamports = Number(info.lamports || 0);

    if (source === searchedWallet && destination === FEE_WALLET && lamports > 0) {
      matches.push({
        signature: tx.signature,
        blockTime: tx.blockTime || null,
        amountSol: lamports / 1_000_000_000,
        source,
        destination,
      });
    }
  }

  return matches;
}

async function fetchTransactionsInChunks(signatures) {
  const chunks = chunkArray(signatures, 20);
  const results = [];

  for (const chunk of chunks) {
    const txs = await Promise.all(
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

    results.push(...txs.filter(Boolean));
  }

  return results;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  const address = req.query.address?.trim();

  if (!address) {
    return res.status(400).json({
      ok: false,
      error: "Missing address query parameter",
    });
  }

  if (!isLikelySolanaAddress(address)) {
    return res.status(400).json({
      ok: false,
      error: "Invalid Solana wallet address format",
    });
  }

  try {
    const now = new Date();
    const startDate = new Date(now);
    startDate.setUTCDate(startDate.getUTCDate() - DAYS_TO_SEARCH);
    const startTimestamp = Math.floor(startDate.getTime() / 1000);

    let before = undefined;
    let allSignatures = [];

    for (let page = 0; page < MAX_PAGES; page++) {
      const options = before
        ? { limit: PAGE_SIZE, before }
        : { limit: PAGE_SIZE };

      const batch = await heliusRpc("getSignaturesForAddress", [address, options]);

      if (!batch || batch.length === 0) {
        break;
      }

      const relevant = batch.filter(
        (sig) => sig.blockTime && sig.blockTime >= startTimestamp
      );

      allSignatures.push(...relevant);

      const oldest = batch[batch.length - 1];
      if (!oldest?.blockTime || oldest.blockTime < startTimestamp) {
        break;
      }

      before = oldest.signature;
    }

    const transactions = await fetchTransactionsInChunks(allSignatures);

    const contributionMatches = [];
    for (const tx of transactions) {
      const matches = extractTransfersToFeeWallet(tx, address);
      contributionMatches.push(...matches);
    }

    contributionMatches.sort((a, b) => (b.blockTime || 0) - (a.blockTime || 0));

    const totalContributedSol = contributionMatches.reduce(
      (sum, item) => sum + item.amountSol,
      0
    );

    const firstContribution = contributionMatches.length
      ? contributionMatches[contributionMatches.length - 1]
      : null;

    const lastContribution = contributionMatches.length
      ? contributionMatches[0]
      : null;

    return res.status(200).json({
      ok: true,
      searchedWallet: address,
      found: contributionMatches.length > 0,
      contributionCount: contributionMatches.length,
      totalContributedSol: Number(totalContributedSol.toFixed(6)),
      firstContributionAt: firstContribution?.blockTime || null,
      lastContributionAt: lastContribution?.blockTime || null,
      scannedSignatures: allSignatures.length,
      matches: contributionMatches.slice(0, 10),
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Unknown server error",
    });
  }
}