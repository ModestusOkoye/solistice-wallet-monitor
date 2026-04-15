import { loadState, saveState } from "../lib/state";

const FEE_WALLET = "DuX1wcoQrJ6XypxLNq3GRrmHFAAMgCqAKbzboabyCtzB";
const MULTISIG = "J9iWieFzB4GbV4LVfKJT4aPY2nByi3vYuKRBCwsjeZ4t";
const APPROVER = "6qrp8Pv3YM9uuP4Bi17rjEsS9E8crLpfMwVLGvNRQPPr";
const FUNDING_SOURCE = "EY7yPT1nJr7AWiXApcnuMyPqba9NM5MgyzFZKscPXzxE";
const CREATION_SIGNATURE =
  "4Q8JY8eswgGqmGc4E4btwJ9VPHoAgi7gPLFxx4SngauPsXSKsMm5UHkzfz4SY8fs8VM79Pozfp947c2s7xaUXy2s";

const EXPECTED_FEE_SOL = 0.075;
const FEE_TOLERANCE_SOL = 0.001;

const SIGNATURE_PAGE_SIZE = 25;
const MAX_PAGES = 2;
const MAX_TXS_PER_SYNC = 20;
const TX_DELAY_MS = 400;

const RECENT_FEE_TX_LIMIT = 10;
const RECENT_OUTFLOW_LIMIT = 15;

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

function buildRecentFeeTxRow(tx) {
  return {
    signature: tx.signature,
    blockTime: tx.blockTime || null,
    err: null,
  };
}

function buildOutflowRow(tx, transfer) {
  const destinationLabel = labelDestination(transfer.destination);
  const suspicious = destinationLabel === "Unknown destination";

  return {
    signature: tx.signature,
    blockTime: tx.blockTime || null,
    source: transfer.source,
    destination: transfer.destination,
    amountSol: Number(transfer.amountSol.toFixed(6)),
    destinationLabel,
    suspicious,
  };
}

async function fetchNewSignatureObjects(lastProcessedSignature) {
  let before = undefined;
  const collected = [];
  let hitCursor = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const options = before
      ? { limit: SIGNATURE_PAGE_SIZE, before }
      : { limit: SIGNATURE_PAGE_SIZE };

    const batch = await heliusRpc("getSignaturesForAddress", [FEE_WALLET, options]);

    if (!batch || batch.length === 0) break;

    for (const sigObj of batch) {
      if (lastProcessedSignature && sigObj.signature === lastProcessedSignature) {
        hitCursor = true;
        break;
      }
      collected.push(sigObj);
    }

    if (hitCursor) break;
    if (batch.length < SIGNATURE_PAGE_SIZE) break;

    before = batch[batch.length - 1].signature;
    await sleep(300);
  }

  return collected.reverse();
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

async function fetchTransactionsFromSignatures(signatureObjects) {
  const successful = signatureObjects
    .filter((sig) => sig.err === null)
    .slice(0, MAX_TXS_PER_SYNC);

  const transactions = [];
  let skippedCount = 0;

  for (const sigObj of successful) {
    const tx = await fetchSingleTransaction(sigObj);

    if (tx?.skipped) {
      skippedCount += 1;
    } else if (tx) {
      transactions.push(tx);
    }

    await sleep(TX_DELAY_MS);
  }

  return {
    transactions,
    skippedCount,
    attemptedCount: successful.length,
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  try {
    const currentState = loadState();
    const lastProcessedSignature = currentState.meta.lastProcessedSignature;

    const newSignatureObjects = await fetchNewSignatureObjects(lastProcessedSignature);

    if (newSignatureObjects.length === 0) {
      const unchangedState = {
        ...currentState,
        meta: {
          ...currentState.meta,
          lastSyncedAt: new Date().toISOString(),
        },
      };

      saveState(unchangedState);

      return res.status(200).json({
        ok: true,
        message: "No new fee-wallet transactions found",
        processedTransactions: 0,
        attemptedTransactions: 0,
        skippedTransactions: 0,
        state: unchangedState,
      });
    }

    const { transactions, skippedCount, attemptedCount } =
      await fetchTransactionsFromSignatures(newSignatureObjects);

    const nextState = loadState();
    const contributorSet = new Set();

    for (const tx of transactions) {
      if (tx.signature === CREATION_SIGNATURE) {
        continue;
      }

      const transfers = extractSystemTransfers(tx);
      let feeLikeInboundSeen = false;

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

          if (!feeLikeInboundSeen) {
            nextState.recent.feeTxs.unshift(buildRecentFeeTxRow(tx));
            feeLikeInboundSeen = true;
          }
        }

        if (transfer.source === FEE_WALLET) {
          const outflowRow = buildOutflowRow(tx, transfer);

          nextState.recent.outflows.unshift(outflowRow);
          nextState.outflows.totalOutflowCount += 1;
          nextState.outflows.totalOutflowSol = Number(
            (nextState.outflows.totalOutflowSol + outflowRow.amountSol).toFixed(6)
          );

          if (outflowRow.suspicious) {
            nextState.recent.suspiciousOutflows.unshift(outflowRow);
            nextState.outflows.suspiciousCount += 1;
            nextState.outflows.suspiciousOutflowSol = Number(
              (nextState.outflows.suspiciousOutflowSol + outflowRow.amountSol).toFixed(6)
            );
          }
        }
      }
    }

    nextState.registrations.uniqueContributorCount += contributorSet.size;
    nextState.registrations.signaturesScanned += newSignatureObjects.length;

    nextState.recent.feeTxs = nextState.recent.feeTxs.slice(0, RECENT_FEE_TX_LIMIT);
    nextState.recent.outflows = nextState.recent.outflows.slice(0, RECENT_OUTFLOW_LIMIT);
    nextState.recent.suspiciousOutflows = nextState.recent.suspiciousOutflows.slice(
      0,
      RECENT_OUTFLOW_LIMIT
    );

    nextState.meta.lastProcessedSignature =
      newSignatureObjects[newSignatureObjects.length - 1]?.signature ||
      lastProcessedSignature;
    nextState.meta.lastSyncedAt = new Date().toISOString();
    nextState.meta.syncRuns += 1;

    saveState(nextState);

    return res.status(200).json({
      ok: true,
      message:
        skippedCount > 0
          ? "Sync completed with some rate-limited transaction fetches skipped"
          : "Sync completed",
      processedTransactions: transactions.length,
      attemptedTransactions: attemptedCount,
      skippedTransactions: skippedCount,
      newSignatures: newSignatureObjects.length,
      lastProcessedSignature: nextState.meta.lastProcessedSignature,
      state: nextState,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Unknown sync error",
    });
  }
}