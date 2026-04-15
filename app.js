const FEE_WALLET = "DuX1wcoQrJ6XypxLNq3GRrmHFAAMgCqAKbzboabyCtzB";
const MULTISIG = "J9iWieFzB4GbV4LVfKJT4aPY2nByi3vYuKRBCwsjeZ4t";
const APPROVER = "6qrp8Pv3YM9uuP4Bi17rjEsS9E8crLpfMwVLGvNRQPPr";
const RPC = "https://mainnet.helius-rpc.com/?api-key=52da5414-0bf9-4d8a-a9a8-3484e52724c1";

let solPrice = 84;
let previousBalance = null;

// ─── Core RPC call ───────────────────────────────────────────────
async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const data = await res.json();
  return data.result;
}

// ─── Fetch full transaction details for a list of signatures ─────
async function fetchTxDetails(signatures, walletAddress) {
  const results = await Promise.all(
    signatures.map(s =>
      rpc("getTransaction", [
        s.signature,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }
      ])
        .then(tx => ({ ...tx, signature: s.signature, blockTime: s.blockTime }))
        .catch(() => ({ signature: s.signature, blockTime: s.blockTime }))
    )
  );
  return results;
}

// ─── SOL price ───────────────────────────────────────────────────
async function fetchSolPrice() {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
    );
    const data = await res.json();
    solPrice = data.solana.usd;
  } catch (e) {}
}

// ─── Helpers ─────────────────────────────────────────────────────
function shortenSig(sig) {
  return sig.slice(0, 8) + "..." + sig.slice(-6);
}

function timeAgo(ts) {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return diff + "s ago";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return Math.floor(diff / 86400) + "d ago";
}

// ─── Row renderers ───────────────────────────────────────────────
function renderFeeRow(tx) {
  const time = tx.blockTime ? timeAgo(tx.blockTime) : "--";
  const failed = tx.err !== null && tx.err !== undefined;
  return `
    <div class="flex items-center justify-between ${failed ? "bg-red-950 border border-red-700" : "bg-gray-800"} rounded-xl px-4 py-2">
      <a href="https://solscan.io/tx/${tx.signature}" target="_blank"
         class="text-blue-400 hover:underline text-xs">${shortenSig(tx.signature)}</a>
      <span class="text-gray-400 text-xs">${time}</span>
      ${failed
        ? '<span class="text-red-400 font-bold text-xs">⚠ FAILED TX</span>'
        : '<span class="text-emerald-400 font-bold text-xs">+0.075 SOL</span>'
      }
    </div>`;
}

function renderActivityRow(tx, walletAddress) {
  const time = tx.blockTime ? timeAgo(tx.blockTime) : "--";
  let action = '<span class="text-gray-500 text-xs">Program interaction</span>';

  try {
    const preBalances = tx.meta?.preBalances || [];
    const postBalances = tx.meta?.postBalances || [];
    const keys = tx.transaction?.message?.accountKeys || [];
    const accounts = keys.map(k => (typeof k === "string" ? k : k.pubkey));
    const idx = accounts.indexOf(walletAddress);

    if (idx !== -1 && preBalances[idx] !== undefined) {
      const diff = (postBalances[idx] - preBalances[idx]) / 1_000_000_000;
      if (diff > 0.0001) {
        action = `<span class="text-emerald-400 text-xs font-bold">▼ Received ${diff.toFixed(4)} SOL</span>`;
      } else if (diff < -0.0001) {
        action = `<span class="text-red-400 text-xs font-bold">▲ Sent ${Math.abs(diff).toFixed(4)} SOL</span>`;
      }
    }
  } catch (e) {}

  return `
    <div class="flex items-center justify-between bg-gray-800 rounded-xl px-4 py-2">
      <a href="https://solscan.io/tx/${tx.signature}" target="_blank"
         class="text-blue-400 hover:underline text-xs">${shortenSig(tx.signature)}</a>
      <span class="text-gray-400 text-xs">${time}</span>
      ${action}
    </div>`;
}

// ─── Outgoing alert ──────────────────────────────────────────────
function checkOutgoing(sol) {
  if (previousBalance !== null && sol < previousBalance - 0.001) {
    const dropped = (previousBalance - sol).toFixed(4);
    document.getElementById("alert-box").classList.remove("hidden");
    document.getElementById("alert-msg").textContent =
      `Balance dropped by ${dropped} SOL. Money may have left the fee wallet. Check Solscan immediately.`;
  }
  previousBalance = sol;
}

// ─── Wallet search ───────────────────────────────────────────────
async function searchWallet() {
  const input = document.getElementById("search-input").value.trim();
  const resultBox = document.getElementById("search-result");

  if (!input || input.length < 32) {
    resultBox.innerHTML = '<p class="text-red-400">Please enter a valid Solana wallet address.</p>';
    return;
  }

  resultBox.innerHTML = '<p class="text-gray-400 text-sm">Searching last 20 transactions...</p>';

  try {
    const sigs = await rpc("getSignaturesForAddress", [FEE_WALLET, { limit: 20 }]);
    if (!sigs) {
      resultBox.innerHTML = '<p class="text-red-400">Could not fetch transactions.</p>';
      return;
    }

    let found = false;
    let foundSig = null;

    for (const sig of sigs) {
      const tx = await rpc("getTransaction", [
        sig.signature,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }
      ]);
      if (!tx) continue;
      const keys = tx.transaction?.message?.accountKeys || [];
      const accounts = keys.map(k => (typeof k === "string" ? k : k.pubkey));
      if (accounts.includes(input)) {
        found = true;
        foundSig = sig.signature;
        break;
      }
    }

    if (found) {
      resultBox.innerHTML = `
        <div class="bg-emerald-900 border border-emerald-600 rounded-xl px-4 py-3">
          <p class="text-emerald-300 font-bold">✓ Wallet found — contributed to the fee wallet</p>
          <a href="https://solscan.io/tx/${foundSig}" target="_blank"
             class="text-blue-400 text-xs hover:underline mt-1 block">View transaction on Solscan</a>
        </div>`;
    } else {
      resultBox.innerHTML = `
        <div class="bg-gray-800 border border-gray-700 rounded-xl px-4 py-3">
          <p class="text-gray-300 text-sm">No contribution found in the last 20 transactions.</p>
          <p class="text-gray-500 text-xs mt-1">Only the most recent 20 txns are checked to avoid rate limits.</p>
        </div>`;
    }
  } catch (e) {
    resultBox.innerHTML = '<p class="text-red-400">Search failed. Try again.</p>';
  }
}

// ─── Main dashboard update ───────────────────────────────────────
async function updateDashboard() {
  try {
    // Fetch balance + signature lists in parallel
    const [balResult, feeSigs, multisigSigs, approverSigs] = await Promise.all([
      rpc("getBalance", [FEE_WALLET]),
      rpc("getSignaturesForAddress", [FEE_WALLET, { limit: 10 }]),
      rpc("getSignaturesForAddress", [MULTISIG, { limit: 5 }]),
      rpc("getSignaturesForAddress", [APPROVER, { limit: 5 }])
    ]);

    const sol = balResult.value / 1_000_000_000;

    // Stats
    document.getElementById("balance").textContent = sol.toFixed(4) + " SOL";
    document.getElementById("raised-usd").textContent =
      "$" + (sol * solPrice).toLocaleString(undefined, { maximumFractionDigits: 2 });
    document.getElementById("raised-sol").textContent = sol.toFixed(4) + " SOL collected";
    document.getElementById("count").textContent = Math.floor(sol / 0.075).toLocaleString();

    // Outgoing check
    checkOutgoing(sol);

    // Fee wallet txns (use signature list only — no need for full tx details here)
    const feeList = document.getElementById("txn-list");
    feeList.innerHTML = feeSigs && feeSigs.length
      ? feeSigs.map(tx => renderFeeRow(tx)).join("")
      : '<p class="text-gray-500">No transactions found.</p>';

    // Multisig full tx details
    const mList = document.getElementById("multisig-list");
    if (!multisigSigs || multisigSigs.length === 0) {
      mList.innerHTML = '<p class="text-gray-500">No recent activity.</p>';
    } else {
      const multisigTxs = await fetchTxDetails(multisigSigs, MULTISIG);
      mList.innerHTML = multisigTxs.map(tx => renderActivityRow(tx, MULTISIG)).join("");
    }

    // Approver full tx details
    const aList = document.getElementById("approver-list");
    if (!approverSigs || approverSigs.length === 0) {
      aList.innerHTML = '<p class="text-gray-500">No recent activity.</p>';
    } else {
      const approverTxs = await fetchTxDetails(approverSigs, APPROVER);
      aList.innerHTML = approverTxs.map(tx => renderActivityRow(tx, APPROVER)).join("");
    }

    document.getElementById("last-update").textContent = new Date().toLocaleTimeString();

  } catch (e) {
    console.error("Dashboard update failed:", e);
  }
}

// ─── Init ────────────────────────────────────────────────────────
fetchSolPrice().then(() => {
  updateDashboard();
  setInterval(updateDashboard, 12000);
  setInterval(fetchSolPrice, 60000);
});