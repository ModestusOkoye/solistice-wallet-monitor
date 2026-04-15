const FEE_WALLET = "DuX1wcoQrJ6XypxLNq3GRrmHFAAMgCqAKbzboabyCtzB";
const RPC = "https://rpc.ankr.com/solana";

let solPrice = 84;

async function fetchSolPrice() {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    const data = await res.json();
    solPrice = data.solana.usd;
  } catch (e) {}
}

async function fetchBalance() {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1,
      method: "getBalance",
      params: [FEE_WALLET]
    })
  });
  const data = await res.json();
  return data.result.value / 1_000_000_000;
}

async function fetchRecentTxns() {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 2,
      method: "getSignaturesForAddress",
      params: [FEE_WALLET, { limit: 10 }]
    })
  });
  const data = await res.json();
  return data.result || [];
}

function shortenSig(sig) {
  return sig.slice(0, 8) + "..." + sig.slice(-6);
}

function timeAgo(ts) {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return diff + "s ago";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  return Math.floor(diff / 3600) + "h ago";
}

async function updateDashboard() {
  try {
    const [sol, txns] = await Promise.all([fetchBalance(), fetchRecentTxns()]);

    document.getElementById("balance").textContent = sol.toFixed(4) + " SOL";

    const usd = (sol * solPrice).toFixed(2);
    document.getElementById("raised-usd").textContent = "$" + Number(usd).toLocaleString();
    document.getElementById("raised-sol").textContent = sol.toFixed(4) + " SOL collected";

    const count = Math.floor(sol / 0.075);
    document.getElementById("count").textContent = count.toLocaleString();

    const list = document.getElementById("txn-list");
    if (txns.length === 0) {
      list.innerHTML = '<p class="text-gray-500">No transactions found.</p>';
    } else {
      list.innerHTML = txns.map(tx => `
        <div class="flex items-center justify-between bg-gray-800 rounded-xl px-4 py-2">
          <a href="https://solscan.io/tx/${tx.signature}" target="_blank"
             class="text-blue-400 hover:underline text-xs">${shortenSig(tx.signature)}</a>
          <span class="text-gray-400 text-xs">${tx.blockTime ? timeAgo(tx.blockTime) : "--"}</span>
          <span class="text-emerald-400 font-bold text-xs">0.075 SOL</span>
        </div>
      `).join("");
    }

    document.getElementById("last-update").textContent = new Date().toLocaleTimeString();

  } catch (e) {
    console.error("Update failed:", e);
  }
}

fetchSolPrice().then(() => {
  updateDashboard();
  setInterval(updateDashboard, 12000);
  setInterval(fetchSolPrice, 60000);
});