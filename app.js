const SUMMARY_API = "/api/summary";
const SEARCH_WALLET_API = "/api/search-wallet";
const WALLET_ACTIVITY_API = "/api/wallet-activity";
const FEE_OUTFLOWS_API = "/api/fee-outflows";

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

async function fetchFeeOutflows() {
  const response = await fetch(FEE_OUTFLOWS_API);
  if (!response.ok) {
    throw new Error(`Fee outflows API failed with status ${response.status}`);
  }

  const data = await response.json();
  if (!data.ok) {
    throw new Error(data.error || "Fee outflows API returned an error");
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

function renderOutflowRow(item) {
  const destinationBadge = item.suspicious
    ? '<span class="text-red-400 text-xs font-bold">Unknown destination</span>'
    : `<span class="text-emerald-400 text-xs font-bold">${item.destinationLabel}</span>`;

  return `
    <div class="bg-gray-800 rounded-xl px-4 py-3">
      <div class="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div class="space-y-1">
          <a href="https://solscan.io/tx/${item.signature}" target="_blank"
             class="text-blue-400 hover:underline text-xs">${shortenSig(item.signature)}</a>
          <div class="text-xs text-gray-400">
            To
            <a href="https://solscan.io/account/${item.destination}" target="_blank"
               class="text-blue-400 hover:underline">${shortenAddress(item.destination)}</a>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <span class="text-gray-400 text-xs">${timeAgo(item.blockTime)}</span>
          ${destinationBadge}
          <span class="text-red-400 text-xs font-bold">-${item.amountSol} SOL</span>
        </div>
      </div>
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

    setText(
      "count",
      Number(data.registrationsEstimate || 0).toLocaleString()
    );

    setText(
      "count-note",
      `exact synced so far: ${Number(data.exactRegistrationCount || 0).toLocaleString()}`
    );

    setText("last-update", new Date(data.fetchedAt).toLocaleTimeString());

    const feeList = document.getElementById("txn-list");
    if (feeList) {
      if (!data.recentTxs || data.recentTxs.length === 0) {
        feeList.innerHTML = '<p class="text-gray-500">No transactions found.</p>';
      } else {
        feeList.innerHTML = data.recentTxs.map(renderFeeRow).join("");
      }
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
    setText("count-note", "unable to load registration estimate");
    setText("last-update", "--");
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

async function updateFeeOutflows() {
  const summaryEl = document.getElementById("outflow-summary");
  const listEl = document.getElementById("outflow-list");
  const alertBox = document.getElementById("alert-box");
  const alertMsg = document.getElementById("alert-msg");

  try {
    const data = await fetchFeeOutflows();

    if (summaryEl) {
      if (data.totalOutflowCount === 0) {
        summaryEl.innerHTML =
          '<span class="text-emerald-400">No fee-wallet outflows detected in the latest scan.</span>';
      } else {
        summaryEl.innerHTML = `
          <span class="text-gray-300">Detected ${data.totalOutflowCount} outflow(s) totaling ${data.totalOutflowSol} SOL.</span>
          ${
            data.suspiciousCount > 0
              ? `<span class="text-red-400 font-bold"> ${data.suspiciousCount} suspicious / unknown destination(s), totaling ${data.suspiciousOutflowSol} SOL.</span>`
              : '<span class="text-emerald-400 font-bold"> All detected destinations are known internal labels.</span>'
          }
        `;
      }
    }

    if (listEl) {
      listEl.innerHTML =
        data.outflows && data.outflows.length
          ? data.outflows.map(renderOutflowRow).join("")
          : '<p class="text-gray-500">No outflows found in the latest scan.</p>';
    }

    if (alertBox && alertMsg) {
      if (data.suspiciousCount > 0) {
        alertBox.classList.remove("hidden");
        alertMsg.textContent = `Suspicious fee-wallet outflows detected: ${data.suspiciousCount} unknown destination(s), totaling ${data.suspiciousOutflowSol} SOL.`;
      } else {
        alertBox.classList.add("hidden");
      }
    }
  } catch (error) {
    console.error("Fee outflow update failed:", error);

    if (summaryEl) {
      summaryEl.innerHTML =
        '<span class="text-red-400">Failed to load fee-wallet outflow summary.</span>';
    }

    if (listEl) {
      listEl.innerHTML =
        '<p class="text-red-400">Failed to load fee-wallet outflows.</p>';
    }
  }
}

window.searchWallet = searchWallet;

updateDashboard();
updateWalletActivity();
updateFeeOutflows();

setInterval(updateDashboard, 12000);
setInterval(updateWalletActivity, 30000);
setInterval(updateFeeOutflows, 30000);