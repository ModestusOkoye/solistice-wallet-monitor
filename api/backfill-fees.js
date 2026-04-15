import { loadState, saveState } from "../lib/state";

const FEE_WALLET = "DuX1wcoQrJ6XypxLNq3GRrmHFAAMgCqAKbzboabyCtzB";
const MULTISIG = "J9iWieFzB4GbV4LVfKJT4aPY2nByi3vYuKRBCwsjeZ4t";
const APPROVER = "6qrp8Pv3YM9uuP4Bi17rjEsS9E8crLpfMwVLGvNRQPPr";
const FUNDING_SOURCE = "EY7yPT1nJr7AWiXApcnuMyPqba9NM5MgyzFZKscPXzxE";
const CREATION_SIGNATURE =
  "4Q8JY8eswgGqmGc4E4btwJ9VPHoAgi7gPLFxx4SngauPsXSKsMm5UHkzfz4SY8fs8VM79Pozfp947c2s7xaUXy2s";

const EXPECTED_FEE_SOL = 0.075;
const FEE_TOLERANCE_SOL = 0.001;

const SIGNATURE_FETCH_LIMIT = 20;
const TX_DELAY_MS = 400;

const KNOWN_DESTINATIONS = {
  [MULTISIG]: "Known internal: Multisig",
  [APPROVER]: "Known internal: Approver wallet",
  [FUNDING_SOURCE]: "Known internal: Funding source",
  [FEE_WALLET]: "Fee wallet",
};

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

function labelDestination(address) {
  return KNOWN_DESTINATIONS[address] || "Unknown destination";
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
      return {
        skipped: true,
        signature: sigObj.signature,
        blockTime: sigObj.blockTime || null,
      };
    }

    return null;
  }
}

async function fetchOlderSignatureBatch(cursorSignature) {
  return await heliusRpc("getSignaturesForAddress", [
    FEE_WALLET,
    {
      limit: SIGNATURE_FETCH_LIMIT,
      before: cursorSignature,
    },
  ]);
}

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  try {
    const state = await loadState();

    const startCursor =
      state.backfill?.lastBackfilledSignature || state.meta?.lastProcessedSignature;

    if (!startCursor) {
      return res.status(400).json({
        ok: false,
        error: "Backfill cannot start yet. Run /api/sync-fees first.",
      });
    }

    const batch = await fetchOlderSignatureBatch(startCursor);

    if (!batch || batch.length === 0) {
      const nextState = {
        ...state,
        backfill: {
          ...state.backfill,
          startedAt: state.backfill.startedAt || new Date().toISOString(),
          lastBackfilledAt: new Date().toISOString(),
          completed: true,
        },
      };

      await saveState(nextState);

      return res.status(200).json({
        ok: true,
        message: "No older fee-wallet signatures left to backfill",
        processedSignatures: 0,
        attemptedTransactions: 0,
        skippedTransactions: 0,
        backfill: nextState.backfill,
      });
    }

    const nextState = await loadState();

    if (!nextState.backfill.startedAt) {
      nextState.backfill.startedAt = new Date().toISOString();
    }

    let attemptedTransactions = 0;
    let processedTransactions = 0;
    let skippedTransactions = 0;
    let processedSignatures = 0;
    let lastSafeCursor = startCursor;
    let stoppedEarly = false;

    const contributorSet = new Set();

    for (const sigObj of batch) {
      if (sigObj.err !== null) {
        lastSafeCursor = sigObj.signature;
        processedSignatures += 1;
        continue;
      }

      attemptedTransactions += 1;

      const tx = await fetchSingleTransaction(sigObj);

      if (tx?.skipped) {
        skippedTransactions += 1;
        stoppedEarly = true;
        break;
      }

      if (!tx) {
        stoppedEarly = true;
        break;
      }

      processedTransactions += 1;

      if (tx.signature !== CREATION_SIGNATURE) {
        const transfers = extractSystemTransfers(tx);

        for (const transfer of transfers) {
          if (
            transfer.destination === FEE_WALLET &&
            isFeeLikeAmount(transfer.amountSol)
          ) {
            nextState.registrations.exactRegistrationCount += 1;
            nextState.registrations.feeLikeInboundSol = Number(
              (nextState.registrations.feeLikeInboundSol + transfer.amountSol).toFixed(6)
            );

            if (transfer.source) {
              contributorSet.add(transfer.source);
            }
          }

          if (transfer.source === FEE_WALLET) {
            const destinationLabel = labelDestination(transfer.destination);
            const suspicious = destinationLabel === "Unknown destination";

            nextState.outflows.totalOutflowCount += 1;
            nextState.outflows.totalOutflowSol = Number(
              (nextState.outflows.totalOutflowSol + transfer.amountSol).toFixed(6)
            );

            if (suspicious) {
              nextState.outflows.suspiciousCount += 1;
              nextState.outflows.suspiciousOutflowSol = Number(
                (nextState.outflows.suspiciousOutflowSol + transfer.amountSol).toFixed(6)
              );
            }
          }
        }
      }

      lastSafeCursor = sigObj.signature;
      processedSignatures += 1;

      await sleep(TX_DELAY_MS);
    }

    nextState.registrations.uniqueContributorCount += contributorSet.size;
    nextState.registrations.signaturesScanned += processedSignatures;
    nextState.outflows.signaturesScanned += processedSignatures;

    nextState.backfill.lastBackfilledSignature = lastSafeCursor;
    nextState.backfill.lastBackfilledAt = new Date().toISOString();
    nextState.backfill.runs += 1;
    nextState.backfill.completed = false;
    nextState.backfill.processedSignatures += processedSignatures;

    await saveState(nextState);

    return res.status(200).json({
      ok: true,
      message: stoppedEarly
        ? "Backfill ran partially and stopped early to avoid rate limits"
        : "Backfill completed one historical batch",
      processedTransactions,
      attemptedTransactions,
      skippedTransactions,
      processedSignatures,
      fetchedBatchSize: batch.length,
      nextBackfillCursor: nextState.backfill.lastBackfilledSignature,
      backfill: nextState.backfill,
      registrations: nextState.registrations,
      outflows: nextState.outflows,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Unknown backfill error",
    });
  }
}