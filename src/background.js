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

// `apiKey` is the OpenRouter key (its name predates TypeSafe support).
async function settings() {
  const s = await chrome.storage.local.get(["provider", "apiKey", "typesafeKey", "resume", "profile", "enabled"]);
  const provider = s.provider === "typesafe" ? "typesafe" : "openrouter";
  return { ...s, auth: { provider, apiKey: provider === "typesafe" ? s.typesafeKey : s.apiKey } };
}

async function handleScore(job) {
  const s = await settings();
  if (s.enabled === false) return { ok: false, reason: "disabled" };
  if (!s.auth.apiKey) return { ok: false, reason: "no-key" };
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
      scoreJob(s.auth, candidate, job).finally(() => inflight.delete(flightKey))
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

// Profile import: open the user's profile in a tab, then walk it through one
// /details/<section>/ page per section. profile.js reads each page and reports
// back with "profile-part"; the parts are joined into one text at the end.
const DETAIL_SECTIONS = [
  ["experience", "Experience"],
  ["education", "Education"],
  ["certifications", "Licenses & certifications"],
  ["skills", "Skills"],
  ["projects", "Projects"],
  ["courses", "Courses"],
  ["languages", "Languages"],
];
const PROFILE_ORDER = [
  "About", "Top skills", "Experience", "Education", "Licenses & certifications", "Skills", "Projects",
  "Courses", "Languages", "Honors & awards", "Volunteering", "Volunteer experience", "Publications",
  "Test scores", "Services", "Featured",
];
const MAX_PROFILE_CHARS = 12000;
const MAX_FEATURED_CHARS = 2500;
const STEP_TIMEOUT = 25000;

async function importProfile(url) {
  const tab = await chrome.tabs.create({ url, active: true });
  await chrome.storage.session.set({
    profileImport: { tabId: tab.id, step: 0, section: "main", heading: null, top: [], sections: {}, base: null, url },
  });
  armWatchdog(0);
}

// If a page never reports (it failed to load, or LinkedIn showed something
// unexpected), skip it rather than leaving the import stuck.
let watchdog = null;
function armWatchdog(step) {
  clearTimeout(watchdog);
  watchdog = setTimeout(async () => {
    const { profileImport: st } = await chrome.storage.session.get("profileImport");
    if (st && st.step === step) await advance(st);
  }, STEP_TIMEOUT);
}

function importJob(st) {
  const total = DETAIL_SECTIONS.length + 1;
  if (st.section === "main") return { capture: true, section: "main", label: "profile", step: 1, total };
  const [, heading] = DETAIL_SECTIONS.find(([s]) => s === st.section);
  return { capture: true, section: st.section, heading, label: heading, step: st.step + 1, total };
}

async function onProfilePart(tabId, part) {
  const { profileImport: st } = await chrome.storage.session.get("profileImport");
  if (!st || st.tabId !== tabId || part.section !== st.section) return;
  if (part.section === "main") {
    st.top = part.top || [];
    st.sections = part.sections || {};
    const m = part.url.match(/^https:\/\/www\.linkedin\.com\/in\/[^/]+\//);
    st.base = m ? m[0] : null;
    st.url = st.base || part.url;
  } else if (part.lines?.length) {
    const [, heading] = DETAIL_SECTIONS.find(([s]) => s === part.section);
    // The details page has the full list; the main page only had the first few.
    st.sections[heading] = part.lines;
  }
  await advance(st);
}

async function advance(st) {
  const next = st.base ? DETAIL_SECTIONS[st.step] : null; // no base url: can't reach details pages
  if (next) {
    st.step += 1;
    st.section = next[0];
    await chrome.storage.session.set({ profileImport: st });
    armWatchdog(st.step);
    await chrome.tabs.update(st.tabId, { url: `${st.base}details/${next[0]}/` }).catch(() => finishImport(st));
    return;
  }
  await finishImport(st);
}

function assembleProfile(st) {
  const parts = [st.top.join("\n")];
  for (const heading of PROFILE_ORDER) {
    const lines = st.sections[heading];
    if (!lines?.length) continue;
    let body = lines.join("\n");
    if (heading === "Featured" && body.length > MAX_FEATURED_CHARS) body = body.slice(0, MAX_FEATURED_CHARS) + " …";
    parts.push(`## ${heading}\n${body}`);
  }
  return parts.filter(Boolean).join("\n\n").slice(0, MAX_PROFILE_CHARS);
}

async function finishImport(st) {
  clearTimeout(watchdog);
  await chrome.storage.session.remove("profileImport");
  const text = assembleProfile(st);
  if (text.trim()) {
    await chrome.storage.local.set({ profile: { url: st.url, text, capturedAt: Date.now() }, profileImportError: null });
  } else {
    // Usually the login wall: the tab never reached a profile page.
    await chrome.storage.local.set({ profileImportError: Date.now() });
  }
  const opts = await chrome.tabs.query({ url: chrome.runtime.getURL("src/options/options.html") });
  if (opts[0]) await chrome.tabs.update(opts[0].id, { active: true });
  setTimeout(() => chrome.tabs.remove(st.tabId).catch(() => {}), 1000);
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
        const { profileImport: st } = await chrome.storage.session.get("profileImport");
        return st && st.tabId === sender.tab?.id ? importJob(st) : { capture: false };
      }
      case "profile-part":
        await onProfilePart(sender.tab?.id, msg);
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
