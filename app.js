const FEE_WALLET = "DuX1wcoQrJ6XypxLNq3GRrmHFAAMgCqAKbzboabyCtzB";
const MULTISIG = "J9iWieFzB4GbV4LVfKJT4aPY2nByi3vYuKRBCwsjeZ4t";
const APPROVER = "6qrp8Pv3YM9uuP4Bi17rjEsS9E8crLpfMwVLGvNRQPPr";
const RPC = "https://mainnet.helius-rpc.com/?api-key=52da5414-0bf9-4d8a-a9a8-3484e52724c1";

let solPrice = 84;
let previousBalance = null;

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const data = await res.json();
  return data.result;
}

async function fetchSolPrice() {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    const data = await res.json();
    solPrice = data.solana.usd;
  } catch (e) {}
}

function shortenAddr(addr) {
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

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

function renderTxnRow(tx, flagUnusual = false) {
  const isUnusual = flagUnusual;
  const time = tx.blockTime ? timeAgo(tx.blockTime) : "--";
  return `
    <div class="flex items-center justify-between ${isUnusual ? 'bg-red-900 border border-red-600' : 'bg-gray-800'} rounded-xl px-4 py-2">
      <a href="https://solscan.io/tx/${tx.signature}" target="_blank"
         class="text-blue-400 hover:underline text-xs">${shortenSig(tx.signature)}</a>
      <span class="text-gray-400 text-xs">${time}</span>
      ${isUnusual ? '<span class="text-red-400 font-bold text-xs">⚠ UNUSUAL</span>' : '<span class="text-emerald-400 font-bold text-xs">0.075 SOL</span>'}
    </div>
  `;
}

function renderActivityRow(tx) {
  const time = tx.blockTime ? timeAgo(tx.blockTime) : "--";
  return `
    <div class="flex items-center justify-between bg-gray-800 rounded-xl px-4 py-2">
      <a href="https://solscan.io/tx/${tx.signature}" target="_blank"
         class="text-blue-400 hover:underline text-xs">${shortenSig(tx.signature)}</a>
      <span class="text-gray-400 text-xs">${time}</span>
      <span class="text-gray-300 text-xs">activity</span>
    </div>
  `;
}

async function checkOutgoing(sol) {
  if (previousBalance !== null && sol < previousBalance - 0.001) {
    const dropped = (previousBalance - sol).toFixed(4);
    document.getElementById("alert-box").classList.remove("hidden");
    document.getElementById("alert-msg").textContent =
      `Balance dropped by ${dropped} SOL. Money may have left the fee wallet. Check Solscan immediately.`;
  }
  previousBalance = sol;
}

async function updateDashboard() {
  try {
    const [balResult, feeSignatures, multisigSigs, approverSigs] = await Promise.all([
      rpc("getBalance", [FEE_WALLET]),
      rpc("getSignaturesForAddress", [FEE_WALLET, { limit: 10 }]),
      rpc("getSignaturesForAddress", [MULTISIG, { limit: 5 }]),
      rpc("getSignaturesForAddress", [APPROVER, { limit: 5 }])
    ]);

    const sol = balResult.value / 1_000_000_000;

    // Stats
    document.getElementById("balance").textContent = sol.toFixed(4) + " SOL";
    document.getElementById("raised-usd").textContent = "$" + (sol * solPrice).toLocaleString(undefined, {maximumFractionDigits: 2});
    document.getElementById("raised-sol").textContent = sol.toFixed(4) + " SOL collected";
    document.getElementById("count").textContent = Math.floor(sol / 0.075).toLocaleString();

    // Outgoing check
    await checkOutgoing(sol);

    // Fee txns
    const feeList = document.getElementById("txn-list");
    if (!feeSignatures || feeSignatures.length === 0) {
      feeList.innerHTML = '<p class="text-gray-500">No transactions found.</p>';
    } else {
      feeList.innerHTML = feeSignatures.map(tx => {
        const isUnusual = tx.err !== null;
        return renderTxnRow(tx, isUnusual);
      }).join("");
    }

    // Multisig activity
    const mList = document.getElementById("multisig-list");
    if (!multisigSigs || multisigSigs.length === 0) {
      mList.innerHTML = '<p class="text-gray-500">No recent activity.</p>';
    } else {
      mList.innerHTML = multisigSigs.map(tx => renderActivityRow(tx)).join("");
    }

    // Approver activity
    const aList = document.getElementById("approver-list");
    if (!approverSigs || approverSigs.length === 0) {
      aList.innerHTML = '<p class="text-gray-500">No recent activity.</p>';
    } else {
      aList.innerHTML = approverSigs.map(tx => renderActivityRow(tx)).join("");
    }

    document.getElementById("last-update").textContent = new Date().toLocaleTimeString();

  } catch (e) {
    console.error("Update failed:", e);
  }
}

async function searchWallet() {
  const input = document.getElementById("search-input").value.trim();
  const resultBox = document.getElementById("search-result");

  if (!input || input.length < 32) {
    resultBox.innerHTML = '<p class="text-red-400">Please enter a valid Solana wallet address.</p>';
    return;
  }

  resultBox.innerHTML = '<p class="text-gray-400">Searching...</p>';

  try {
    const sigs = await rpc("getSignaturesForAddress", [FEE_WALLET, { limit: 1000 }]);
    if (!sigs) {
      resultBox.innerHTML = '<p class="text-red-400">Could not fetch transactions.</p>';
      return;
    }

    // Check each txn to see if this wallet was involved
    // We use getTransaction on the most recent ones (limit to avoid rate limits)
    const recent = sigs.slice(0, 20);
    let found = false;

    for (const sig of recent) {
      const tx = await rpc("getTransaction", [sig.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
      if (!tx) continue;
      const accounts = tx.transaction?.message?.accountKeys?.map(k => k.pubkey || k) || [];
      if (accounts.includes(input)) {
        found = true;
        resultBox.innerHTML = `
          <div class="bg-emerald-900 border border-emerald-600 rounded-xl px-4 py-3">
            <p class="text-emerald-300 font-bold">✓ Wallet found — contributed to the fee wallet</p>
            <a href="https://solscan.io/tx/${sig.signature}" target="_blank" class="text-blue-400 text-xs hover:underline mt-1 block">View transaction on Solscan</a>
          </div>`;
        break;
      }
    }

    if (!found) {
      resultBox.innerHTML = `
        <div class="bg-gray-800 border border-gray-600 rounded-xl px-4 py-3">
          <p class="text-gray-300">No contribution found in the last 20 transactions for this wallet.</p>
          <p class="text-gray-500 text-xs mt-1">Note: only the most recent 20 txns are checked to avoid rate limits.</p>
        </div>`;
    }
  } catch (e) {
    resultBox.innerHTML = '<p class="text-red-400">Search failed. Try again.</p>';
  }
}

// Init
fetchSolPrice().then(() => {
  updateDashboard();
  setInterval(updateDashboard, 12000);
  setInterval(fetchSolPrice, 60000);
});