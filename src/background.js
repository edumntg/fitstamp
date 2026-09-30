import { scoreJob } from "./lib/jev.js";

const CACHE_TTL = 7 * 24 * 3600 * 1000;
const MAX_CACHED = 1500;
const inflight = new Map();

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

async function settings() {
  return chrome.storage.local.get(["apiKey", "resume", "profile", "enabled"]);
}

async function handleScore(job) {
  const s = await settings();
  if (s.enabled === false) return { ok: false, reason: "disabled" };
  if (!s.apiKey) return { ok: false, reason: "no-key" };
  if (!s.resume?.text) return { ok: false, reason: "no-resume" };

  const candidate = { resume: s.resume.text, profile: s.profile?.text || "" };
  // A new resume or profile changes the hash, so old stamps are recomputed.
  const version = fnv1a(candidate.resume + "\u0000" + candidate.profile);
  const key = `job:${job.id}`;
  const cached = (await chrome.storage.local.get(key))[key];
  if (cached && cached.version === version && cached.hasDescription >= !!job.description && Date.now() - cached.at < CACHE_TTL) {
    return { ok: true, result: cached.result, cached: true };
  }

  const flightKey = `${job.id}:${version}`;
  if (!inflight.has(flightKey)) {
    inflight.set(
      flightKey,
      scoreJob(s.apiKey, candidate, job).finally(() => inflight.delete(flightKey))
    );
  }
  try {
    const result = await inflight.get(flightKey);
    await chrome.storage.local.set({
      [key]: { version, result, at: Date.now(), hasDescription: !!job.description },
    });
    await bumpStats(result.cost);
    pruneSoon();
    return { ok: true, result, cached: false };
  } catch (e) {
    const reason = e.status === 401 ? "bad-key" : e.status === 402 ? "no-credits" : "error";
    return { ok: false, reason, message: e.message };
  }
}

async function bumpStats(cost) {
  const { stats = { scored: 0, cost: 0 } } = await chrome.storage.local.get("stats");
  stats.scored += 1;
  stats.cost += cost || 0;
  await chrome.storage.local.set({ stats });
}

let pruneTimer = null;
function pruneSoon() {
  clearTimeout(pruneTimer);
  pruneTimer = setTimeout(async () => {
    const all = await chrome.storage.local.get(null);
    const jobs = Object.entries(all).filter(([k]) => k.startsWith("job:"));
    if (jobs.length <= MAX_CACHED) return;
    jobs.sort((a, b) => a[1].at - b[1].at);
    await chrome.storage.local.remove(jobs.slice(0, jobs.length - MAX_CACHED).map(([k]) => k));
  }, 5000);
}

async function clearCache() {
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith("job:")));
  await chrome.storage.local.set({ cacheEpoch: Date.now() }); // tells open LinkedIn tabs to re-score
}

// Profile import: open the user's own profile in a tab; profile.js asks whether
// it is that tab, reads the page, and sends the text back.
async function importProfile(url) {
  const tab = await chrome.tabs.create({ url, active: true });
  await chrome.storage.session.set({ importTabId: tab.id });
}

async function onProfileCaptured(tabId, payload) {
  const { importTabId } = await chrome.storage.session.get("importTabId");
  if (tabId !== importTabId) return;
  await chrome.storage.local.set({
    profile: { url: payload.url, text: payload.text, capturedAt: Date.now() },
  });
  await chrome.storage.session.remove("importTabId");
  const opts = await chrome.tabs.query({ url: chrome.runtime.getURL("src/options/options.html") });
  if (opts[0]) await chrome.tabs.update(opts[0].id, { active: true });
  setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 1500);
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    switch (msg.type) {
      case "score":
        return handleScore(msg.job);
      case "import-profile":
        await importProfile(msg.url);
        return { ok: true };
      case "is-import-tab": {
        const { importTabId } = await chrome.storage.session.get("importTabId");
        return { capture: sender.tab?.id === importTabId };
      }
      case "profile-captured":
        await onProfileCaptured(sender.tab?.id, msg);
        return { ok: true };
      case "open-options":
        await chrome.runtime.openOptionsPage();
        return { ok: true };
      case "clear-cache":
        await clearCache();
        return { ok: true };
      default:
        return { ok: false, reason: "unknown" };
    }
  })().then(reply, (e) => reply({ ok: false, reason: "error", message: String(e) }));
  return true;
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});
