import { loadState } from "../lib/state";

function formatLabel(dayKey) {
  const date = new Date(`${dayKey}T00:00:00Z`);

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  try {
    const state = await loadState();
    const daily = state.history?.daily || {};

    const sortedDays = Object.keys(daily).sort();

    const labels = [];
    const dailySol = [];
    const dailyWalletsContributing = [];

    for (const dayKey of sortedDays) {
      const bucket = daily[dayKey] || {};
      const contributorAddresses = Array.isArray(bucket.contributorAddresses)
        ? bucket.contributorAddresses
        : [];

      labels.push(formatLabel(dayKey));
      dailySol.push(Number(bucket.feeSol || 0));
      dailyWalletsContributing.push(contributorAddresses.length);
    }

    return res.status(200).json({
      ok: true,
      labels,
      dailySol,
      dailyWalletsContributing,
      dayCount: sortedDays.length,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Unknown fee history error",
    });
  }
}