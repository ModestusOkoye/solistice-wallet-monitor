const FEE_WALLET = "DuX1wcoQrJ6XypxLNq3GRrmHFAAMgCqAKbzboabyCtzB";
const MULTISIG = "J9iWieFzB4GbV4LVfKJT4aPY2nByi3vYuKRBCwsjeZ4t";
const APPROVER = "6qrp8Pv3YM9uuP4Bi17rjEsS9E8crLpfMwVLGvNRQPPr";
const FUNDING_SOURCE = "EY7yPT1nJr7AWiXApcnuMyPqba9NM5MgyzFZKscPXzxE";

const LIMIT = 25;

const KNOWN_DESTINATIONS = {
  [MULTISIG]: "Known internal: Multisig",
  [APPROVER]: "Known internal: Approver wallet",
  [FUNDING_SOURCE]: "Known internal: Funding source",
  [FEE_WALLET]: "Fee wallet",
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

function extractAllInstructions(tx) {
  const outer = tx?.transaction?.message?.instructions || [];
  const innerGroups = tx?.meta?.innerInstructions || [];
  const inner = innerGroups.flatMap((group) => group.instructions || []);
  return [...outer, ...inner];
}

function extractFeeWalletOutflows(tx) {
  const instructions = extractAllInstructions(tx);
  const found = [];

  for (const instruction of instructions) {
    if (instruction?.program !== "system") continue;
    if (instruction?.parsed?.type !== "transfer") continue;

    const info = instruction?.parsed?.info || {};
    const source = info.source;
    const destination = info.destination;
    const lamports = Number(info.lamports || 0);

    if (source === FEE_WALLET && destination && lamports > 0) {
      found.push({
        signature: tx.signature,
        blockTime: tx.blockTime || null,
        source,
        destination,
        amountSol: Number((lamports / 1_000_000_000).toFixed(6)),
      });
    }
  }

  // Deduplicate in case the same transfer appears through inner + outer parsing
  const deduped = new Map();

  for (const item of found) {
    const key = `${item.signature}-${item.destination}-${item.amountSol}`;
    if (!deduped.has(key)) {
      deduped.set(key, item);
    }
  }

  return Array.from(deduped.values());
}

function labelDestination(address) {
  return KNOWN_DESTINATIONS[address] || "Unknown destination";
}

async function fetchRecentTransactions() {
  const sigs = await heliusRpc("getSignaturesForAddress", [
    FEE_WALLET,
    { limit: LIMIT },
  ]);

  if (!sigs || sigs.length === 0) {
    return [];
  }

  const txs = await Promise.all(
    sigs.map(async (sigObj) => {
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

  return txs.filter(Boolean);
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  try {
    const txs = await fetchRecentTransactions();

    const outflows = [];
    for (const tx of txs) {
      const extracted = extractFeeWalletOutflows(tx);
      outflows.push(...extracted);
    }

    outflows.sort((a, b) => (b.blockTime || 0) - (a.blockTime || 0));

    const labeledOutflows = outflows.map((item) => {
      const destinationLabel = labelDestination(item.destination);
      const suspicious = destinationLabel === "Unknown destination";

      return {
        ...item,
        destinationLabel,
        suspicious,
      };
    });

    const suspiciousOutflows = labeledOutflows.filter((item) => item.suspicious);
    const totalOutflowSol = labeledOutflows.reduce((sum, item) => sum + item.amountSol, 0);
    const suspiciousOutflowSol = suspiciousOutflows.reduce(
      (sum, item) => sum + item.amountSol,
      0
    );

    return res.status(200).json({
      ok: true,
      wallet: FEE_WALLET,
      outflows: labeledOutflows.slice(0, 15),
      totalOutflowCount: labeledOutflows.length,
      totalOutflowSol: Number(totalOutflowSol.toFixed(6)),
      suspiciousCount: suspiciousOutflows.length,
      suspiciousOutflowSol: Number(suspiciousOutflowSol.toFixed(6)),
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Unknown server error",
    });
  }
}