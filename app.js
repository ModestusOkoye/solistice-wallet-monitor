const SUMMARY_API = "/api/summary";
const FEE_HISTORY_API = "/api/fee-history";
const SEARCH_WALLET_API = "/api/search-wallet";
const WALLET_ACTIVITY_API = "/api/wallet-activity";

let solChart = null;
let walletChart = null;

function shortenSig(sig) {
  return sig.slice(0, 8) + "..." + sig.slice(-6);
}

function shortenAddress(address) {
  return address.slice(0, 8) + "..." + address.slice(-6);
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

async function fetchFeeHistory() {
  const response = await fetch(FEE_HISTORY_API);
  if (!response.ok) {
    throw new Error(`Fee history API failed with status ${response.status}`);
  }
  const data = await response.json();
  if (!data.ok) {
    throw new Error(data.error || "Fee history API returned an error");
  }
  return data;
}

async function fetchWalletSearch(address) {
  const response = await fetch(
    `${SEARCH_WALLET_API}?address=${encodeURIComponent(address)}`
  );
  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(data.error || `Wallet search failed with status ${response.status}`);
  }

  return data;
}

async function fetchWalletActivity() {
  const response = await fetch(WALLET_ACTIVITY_API);
  if (!response.ok) {
    throw new Error(`Wallet activity API failed with status ${response.status}`);
  }
  const data = await response.json();
  if (!data.ok) {
    throw new Error(data.error || "Wallet activity API returned an error");
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

function renderSearchMatches(matches) {
  if (!matches || matches.length === 0) {
    return "";
  }

  return `
    <div class="mt-4 space-y-2">
      <p class="text-sm text-gray-400">Recent matching contributions</p>
      ${matches
        .map(
          (match) => `
          <div class="flex items-center justify-between bg-gray-800 rounded-xl px-4 py-2">
            <a href="https://solscan.io/tx/${match.signature}" target="_blank"
               class="text-blue-400 hover:underline text-xs">${shortenSig(match.signature)}</a>
            <span class="text-gray-400 text-xs">${timeAgo(match.blockTime)}</span>
            <span class="text-emerald-400 font-bold text-xs">+${match.amountSol} SOL</span>
          </div>
        `
        )
        .join("")}
    </div>
  `;
}

function renderActivityRow(item) {
  let badge = `<span class="text-gray-500 text-xs">${item.label}</span>`;

  if (item.type === "sent") {
    badge = `<span class="text-red-400 text-xs font-bold">▲ Sent ${item.amountSol} SOL</span>`;
  } else if (item.type === "received") {
    badge = `<span class="text-emerald-400 text-xs font-bold">▼ Received ${item.amountSol} SOL</span>`;
  } else if (item.type === "squads") {
    badge = `<span class="text-blue-400 text-xs font-bold">${item.label}</span>`;
  }

  return `
    <div class="flex items-center justify-between bg-gray-800 rounded-xl px-4 py-2">
      <a href="https://solscan.io/tx/${item.signature}" target="_blank"
         class="text-blue-400 hover:underline text-xs">${shortenSig(item.signature)}</a>
      <span class="text-gray-400 text-xs">${timeAgo(item.blockTime)}</span>
      ${badge}
    </div>
  `;
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

async function searchWallet() {
  const input = document.getElementById("search-input");
  const resultBox = document.getElementById("search-result");

  if (!input || !resultBox) return;

  const address = input.value.trim();

  if (!address) {
    resultBox.innerHTML = `
      <div class="bg-gray-800 border border-gray-700 rounded-xl px-4 py-3">
        <p class="text-gray-300 text-sm">Please paste a Solana wallet address first.</p>
      </div>
    `;
    return;
  }

  resultBox.innerHTML = `
    <div class="bg-gray-800 border border-gray-700 rounded-xl px-4 py-3">
      <p class="text-gray-300 text-sm">Searching wallet contributions...</p>
    </div>
  `;

  try {
    const data = await fetchWalletSearch(address);

    if (!data.found) {
      resultBox.innerHTML = `
        <div class="bg-gray-800 border border-gray-700 rounded-xl px-4 py-3">
          <p class="text-gray-300 text-sm">No contribution found for this wallet in the current search window.</p>
          <p class="text-gray-500 text-xs mt-1">Scanned ${data.scannedSignatures} wallet signatures.</p>
        </div>
      `;
      return;
    }

    resultBox.innerHTML = `
      <div class="bg-emerald-950 border border-emerald-700 rounded-xl px-4 py-3">
        <p class="text-emerald-300 font-bold text-sm">Wallet contribution found</p>
        <div class="mt-2 space-y-1 text-sm">
          <p class="text-gray-200"><span class="text-gray-400">Wallet:</span> ${shortenAddress(
            data.searchedWallet
          )}</p>
          <p class="text-gray-200"><span class="text-gray-400">Matches:</span> ${data.contributionCount}</p>
          <p class="text-gray-200"><span class="text-gray-400">Total contributed:</span> ${data.totalContributedSol} SOL</p>
          <p class="text-gray-200"><span class="text-gray-400">First contribution:</span> ${timeAgo(
            data.firstContributionAt
          )}</p>
          <p class="text-gray-200"><span class="text-gray-400">Latest contribution:</span> ${timeAgo(
            data.lastContributionAt
          )}</p>
        </div>
      </div>
      ${renderSearchMatches(data.matches)}
    `;
  } catch (error) {
    resultBox.innerHTML = `
      <div class="bg-red-950 border border-red-700 rounded-xl px-4 py-3">
        <p class="text-red-300 text-sm">${error.message}</p>
      </div>
    `;
  }
}

function renderCharts(labels, dailySol, dailyWalletsContributing) {
  if (typeof Chart === "undefined") {
    console.error("Chart.js is not loaded");
    return;
  }

  const solCtx = document.getElementById("sol-chart");
  const walletCtx = document.getElementById("wallet-chart");

  if (!solCtx || !walletCtx) {
    return;
  }

  const sharedOptions = {
    responsive: true,
    plugins: {
      legend: {
        display: false,
      },
    },
    scales: {
      x: {
        ticks: {
          color: "#9ca3af",
          font: {
            size: 10,
          },
        },
        grid: {
          color: "rgba(255,255,255,0.05)",
        },
      },
      y: {
        beginAtZero: true,
        ticks: {
          color: "#9ca3af",
          font: {
            size: 10,
          },
        },
        grid: {
          color: "rgba(255,255,255,0.05)",
        },
      },
    },
  };

  if (solChart) {
    solChart.data.labels = labels;
    solChart.data.datasets[0].data = dailySol;
    solChart.update();
  } else {
    solChart = new Chart(solCtx.getContext("2d"), {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "SOL",
            data: dailySol,
            backgroundColor: "rgba(52, 211, 153, 0.7)",
            borderColor: "rgba(52, 211, 153, 1)",
            borderWidth: 1,
            borderRadius: 6,
            borderSkipped: false,
          },
        ],
      },
      options: {
        ...sharedOptions,
        plugins: {
          ...sharedOptions.plugins,
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.parsed.y} SOL`,
            },
          },
        },
      },
    });
  }

  if (walletChart) {
    walletChart.data.labels = labels;
    walletChart.data.datasets[0].data = dailyWalletsContributing;
    walletChart.update();
  } else {
    walletChart = new Chart(walletCtx.getContext("2d"), {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "Wallets",
            data: dailyWalletsContributing,
            backgroundColor: "rgba(96, 165, 250, 0.7)",
            borderColor: "rgba(96, 165, 250, 1)",
            borderWidth: 1,
            borderRadius: 6,
            borderSkipped: false,
          },
        ],
      },
      options: {
        ...sharedOptions,
        plugins: {
          ...sharedOptions.plugins,
          tooltip: {
            callbacks: {
              label: (ctx) => `${ctx.parsed.y} payments`,
            },
          },
        },
      },
    });
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

async function updateCharts() {
  try {
    const data = await fetchFeeHistory();
    renderCharts(data.labels, data.dailySol, data.dailyWalletsContributing);
  } catch (error) {
    console.error("Chart update failed:", error);
  }
}

async function updateWalletActivity() {
  const multisigList = document.getElementById("multisig-list");
  const approverList = document.getElementById("approver-list");

  try {
    const data = await fetchWalletActivity();

    if (multisigList) {
      multisigList.innerHTML =
        data.multisig && data.multisig.length
          ? data.multisig.map(renderActivityRow).join("")
          : '<p class="text-gray-500">No recent multisig activity found.</p>';
    }

    if (approverList) {
      approverList.innerHTML =
        data.approver && data.approver.length
          ? data.approver.map(renderActivityRow).join("")
          : '<p class="text-gray-500">No recent approver activity found.</p>';
    }
  } catch (error) {
    console.error("Wallet activity update failed:", error);

    if (multisigList) {
      multisigList.innerHTML =
        '<p class="text-red-400">Failed to load multisig activity.</p>';
    }

    if (approverList) {
      approverList.innerHTML =
        '<p class="text-red-400">Failed to load approver wallet activity.</p>';
    }
  }
}

updateDashboard();
updateCharts();
updateWalletActivity();

setInterval(updateDashboard, 12000);
setInterval(updateCharts, 60000);
setInterval(updateWalletActivity, 30000);