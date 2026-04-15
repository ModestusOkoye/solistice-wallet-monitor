const MULTISIG = "J9iWieFzB4GbV4LVfKJT4aPY2nByi3vYuKRBCwsjeZ4t";
const APPROVER = "6qrp8Pv3YM9uuP4Bi17rjEsS9E8crLpfMwVLGvNRQPPr";
const SQUADS_V4_PROGRAM = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
const LIMIT = 5;

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

function getAccountKeys(tx) {
  const keys = tx?.transaction?.message?.accountKeys || [];
  return keys.map((k) => (typeof k === "string" ? k : k?.pubkey)).filter(Boolean);
}

function extractAllInstructions(tx) {
  const outer = tx?.transaction?.message?.instructions || [];
  const innerGroups = tx?.meta?.innerInstructions || [];
  const inner = innerGroups.flatMap((group) => group.instructions || []);
  return [...outer, ...inner];
}

function getProgramIdString(instruction) {
  const value = instruction?.programId;
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value?.toString === "function") return value.toString();
  return "";
}

function hasSquadsInstruction(tx) {
  const instructions = extractAllInstructions(tx);

  return instructions.some((instruction) => {
    const program = String(instruction?.program || "").toLowerCase();
    const programId = getProgramIdString(instruction);
    return program.includes("squads") || programId === SQUADS_V4_PROGRAM;
  });
}

function findParsedSystemTransferForWallet(tx, walletAddress) {
  const instructions = extractAllInstructions(tx);

  for (const instruction of instructions) {
    if (instruction?.program !== "system") continue;
    if (instruction?.parsed?.type !== "transfer") continue;

    const info = instruction?.parsed?.info || {};
    const source = info.source;
    const destination = info.destination;
    const lamports = Number(info.lamports || 0);
    const roundedSol = Number((lamports / 1_000_000_000).toFixed(4));

    if (roundedSol <= 0) continue;

    if (source === walletAddress || destination === walletAddress) {
      return {
        source,
        destination,
        amountSol: roundedSol,
      };
    }
  }

  return null;
}

function classifyTransaction(tx, walletAddress, role) {
  const accounts = getAccountKeys(tx);
  const idx = accounts.indexOf(walletAddress);

  const preBalances = tx?.meta?.preBalances || [];
  const postBalances = tx?.meta?.postBalances || [];

  let type = "program";
  let label = "Program interaction";
  let amountSol = null;

  if (
    idx !== -1 &&
    preBalances[idx] !== undefined &&
    postBalances[idx] !== undefined
  ) {
    const diffLamports = Number(postBalances[idx]) - Number(preBalances[idx]);
    const roundedDiffSol = Number((diffLamports / 1_000_000_000).toFixed(4));

    if (roundedDiffSol > 0) {
      type = "received";
      label = "Received SOL";
      amountSol = roundedDiffSol;
    } else if (roundedDiffSol < 0) {
      type = "sent";
      label = "Sent SOL";
      amountSol = Math.abs(roundedDiffSol);
    }
  }

  if (amountSol === null) {
    const transfer = findParsedSystemTransferForWallet(tx, walletAddress);

    if (transfer) {
      if (transfer.destination === walletAddress) {
        type = "received";
        label = "Received SOL";
        amountSol = transfer.amountSol;
      } else if (transfer.source === walletAddress) {
        type = "sent";
        label = "Sent SOL";
        amountSol = transfer.amountSol;
      }
    }
  }

  if (amountSol === null && hasSquadsInstruction(tx)) {
    type = "squads";
    label =
      role === "multisig"
        ? "Squads multisig action"
        : "Approved / executed Squads action";
  }

  return {
    signature: tx.signature,
    blockTime: tx.blockTime || null,
    type,
    label,
    amountSol,
  };
}

async function fetchActivityForWallet(walletAddress, role) {
  const sigs = await heliusRpc("getSignaturesForAddress", [
    walletAddress,
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
        return {
          signature: sigObj.signature,
          blockTime: sigObj.blockTime || null,
        };
      }
    })
  );

  return txs.filter(Boolean).map((tx) => classifyTransaction(tx, walletAddress, role));
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  try {
    const [multisig, approver] = await Promise.all([
      fetchActivityForWallet(MULTISIG, "multisig"),
      fetchActivityForWallet(APPROVER, "approver"),
    ]);

    return res.status(200).json({
      ok: true,
      multisig,
      approver,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Unknown server error",
    });
  }
}