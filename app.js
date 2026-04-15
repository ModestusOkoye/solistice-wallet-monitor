const SUMMARY_API = "/api/summary";

function shortenSig(sig) {
  return sig.slice(0, 8) + "..." + sig.slice(-6);
}

function timeAgo(ts) {
  if (!ts) return "--";

  const diff = Math.floor(Date.now() / 1000) - ts;

  if (diff < 60) return diff + "s ago";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return Math.floor(diff / 86400) + "d ago";
}

async function fetchSummary() {
  const response = await fetch(SUMMARY_API);

  if (!response.ok) {
    throw new Error(`Summary API failed with status ${response.status}`);
  }

  const data = await response.json();

  if (!data.ok) {
    throw new Error(data.error || "Summary API returned an error");
  }

  return data;
}

function renderFeeRow(tx) {
  const time = tx.blockTime ? timeAgo(tx.blockTime) : "--";
  const failed = tx.err !== null && tx.err !== undefined;

  return `
    <div class="flex items-center justify-between ${
      failed ? "bg-red-950 border border-red-700" : "bg-gray-800"
    } rounded-xl px-4 py-2">
      <a href="https://solscan.io/tx/${tx.signature}" target="_blank"
         class="text-blue-400 hover:underline text-xs">${shortenSig(tx.signature)}</a>
      <span class="text-gray-400 text-xs">${time}</span>
      ${
        failed
          ? '<span class="text-red-400 font-bold text-xs">⚠ FAILED TX</span>'
          : '<span class="text-emerald-400 font-bold text-xs">+0.075 SOL</span>'
      }
    </div>
  `;
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function initializePlaceholders() {
  const solChart = document.getElementById("sol-chart");
  const walletChart = document.getElementById("wallet-chart");

  if (solChart && solChart.parentElement) {
    solChart.parentElement.innerHTML = `
      <h2 class="text-sm font-semibold text-gray-300 mb-4">Daily SOL Contributed</h2>
      <p class="text-sm text-gray-500">This chart will be wired in the next step using a server-side API route.</p>
    `;
  }

  if (walletChart && walletChart.parentElement) {
    walletChart.parentElement.innerHTML = `
      <h2 class="text-sm font-semibold text-gray-300 mb-4">Daily Wallets Contributing</h2>
      <p class="text-sm text-gray-500">This chart will be wired in the next step using a server-side API route.</p>
    `;
  }

  const multisigList = document.getElementById("multisig-list");
  if (multisigList) {
    multisigList.innerHTML =
      '<p class="text-gray-500">Multisig activity will be connected in the next step.</p>';
  }

  const approverList = document.getElementById("approver-list");
  if (approverList) {
    approverList.innerHTML =
      '<p class="text-gray-500">Approver wallet activity will be connected in the next step.</p>';
  }
}

async function searchWallet() {
  const resultBox = document.getElementById("search-result");
  if (resultBox) {
    resultBox.innerHTML = `
      <div class="bg-gray-800 border border-gray-700 rounded-xl px-4 py-3">
        <p class="text-gray-300 text-sm">Wallet search will be connected in the next step.</p>
      </div>
    `;
  }
}

async function updateDashboard() {
  try {
    const data = await fetchSummary();

    setText("balance", `${data.balanceSol.toFixed(4)} SOL`);
    setText(
      "raised-usd",
      data.totalCollectedUsd !== null
        ? `$${Number(data.totalCollectedUsd).toLocaleString()}`
        : "N/A"
    );
    setText("raised-sol", `${data.totalCollectedSol.toFixed(4)} SOL collected`);
    setText("count", Number(data.registrationsEstimate).toLocaleString());
    setText("last-update", new Date(data.fetchedAt).toLocaleTimeString());

    const feeList = document.getElementById("txn-list");
    if (feeList) {
      if (!data.recentTxs || data.recentTxs.length === 0) {
        feeList.innerHTML = '<p class="text-gray-500">No transactions found.</p>';
      } else {
        feeList.innerHTML = data.recentTxs.map(renderFeeRow).join("");
      }
    }

    const alertBox = document.getElementById("alert-box");
    if (alertBox) {
      alertBox.classList.add("hidden");
    }
  } catch (error) {
    console.error("Dashboard update failed:", error);

    const feeList = document.getElementById("txn-list");
    if (feeList) {
      feeList.innerHTML =
        '<p class="text-red-400">Failed to load summary data from /api/summary.</p>';
    }

    setText("balance", "--");
    setText("raised-usd", "--");
    setText("raised-sol", "unable to load");
    setText("count", "--");
    setText("last-update", "--");
  }
}

initializePlaceholders();

updateDashboard();
setInterval(updateDashboard, 12000);