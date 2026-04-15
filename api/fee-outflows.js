import { loadState } from "../lib/state";

const FEE_WALLET = "DuX1wcoQrJ6XypxLNq3GRrmHFAAMgCqAKbzboabyCtzB";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  try {
    const state = await loadState();

    const outflows = state.recent?.outflows || [];
    const suspiciousOutflows = state.recent?.suspiciousOutflows || [];
    const totals = state.outflows || {};

    return res.status(200).json({
      ok: true,
      wallet: FEE_WALLET,
      outflows,
      suspiciousOutflows,
      totalOutflowCount: totals.totalOutflowCount || 0,
      totalOutflowSol: totals.totalOutflowSol || 0,
      suspiciousCount: totals.suspiciousCount || 0,
      suspiciousOutflowSol: totals.suspiciousOutflowSol || 0,
      signaturesScanned: totals.signaturesScanned || 0,
      historyLimitReached: totals.historyLimitReached || false,
      lastSyncedAt: state.meta?.lastSyncedAt || null,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Unknown fee outflows error",
    });
  }
}