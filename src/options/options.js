import * as pdfjs from "../../vendor/pdfjs/pdf.min.mjs";
import { testKey, PROVIDERS } from "../lib/jev.js";

pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdfjs/pdf.worker.min.mjs");

const $ = (id) => document.getElementById(id);
const store = chrome.storage.local;

function status(el, text, kind = "") {
  el.textContent = text;
  el.dataset.kind = kind;
}

const fmtDate = (t) => new Date(t).toLocaleString();

// ---------- API key ----------

// The OpenRouter key is stored as `apiKey` (its name predates TypeSafe support).
const KEY_FIELD = { openrouter: { input: "openrouterKey", store: "apiKey" }, typesafe: { input: "typesafeKey", store: "typesafeKey" } };

const selectedProvider = () => document.querySelector('input[name="provider"]:checked').value;

function showProvider(provider) {
  document.querySelectorAll("[data-provider]").forEach((el) => (el.hidden = el.dataset.provider !== provider));
}

document.querySelectorAll('input[name="provider"]').forEach((r) => {
  r.onchange = () => {
    showProvider(r.value);
    status($("keyStatus"), "");
  };
});

$("saveKey").onclick = async () => {
  const provider = selectedProvider();
  const key = $(KEY_FIELD[provider].input).value.trim();
  if (!key) return status($("keyStatus"), "Paste a key first.", "error");
  await store.set({ provider, [KEY_FIELD[provider].store]: key });
  status($("keyStatus"), `Saved. Jobs are now scored through ${PROVIDERS[provider].label}.`, "ok");
};

$("testKey").onclick = async () => {
  const provider = selectedProvider();
  const apiKey = $(KEY_FIELD[provider].input).value.trim();
  if (!apiKey) return status($("keyStatus"), "Paste a key first.", "error");
  status($("keyStatus"), "Testing…");
  try {
    await testKey({ provider, apiKey });
    status($("keyStatus"), `The key works and Jev answered through ${PROVIDERS[provider].label}.`, "ok");
  } catch (e) {
    status($("keyStatus"), `Jev call through ${PROVIDERS[provider].label} failed: ${e.message}`, "error");
  }
};

// ---------- resume ----------

async function pdfToText(file) {
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    let line = "";
    const lines = [];
    for (const item of content.items) {
      line += item.str;
      if (item.hasEOL) {
        lines.push(line);
        line = "";
      } else if (item.str && !item.str.endsWith(" ")) {
        line += " ";
      }
    }
    if (line) lines.push(line);
    pages.push(lines.map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n"));
  }
  return pages.join("\n\n");
}

let resumeName = "";

$("resumeFile").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  resumeName = file.name;
  status($("resumeStatus"), `Reading ${file.name}…`);
  try {
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    const text = isPdf ? await pdfToText(file) : await file.text();
    $("resumeText").value = text.trim();
    if (text.trim().length < 200) {
      status($("resumeStatus"), "Very little text came out. If the PDF is a scanned image, paste the text instead.", "error");
    } else {
      status($("resumeStatus"), `${text.length.toLocaleString()} characters extracted. Review, then save.`);
    }
  } catch (err) {
    status($("resumeStatus"), `Could not read the file: ${err.message}`, "error");
  }
};

$("saveResume").onclick = async () => {
  const text = $("resumeText").value.trim();
  if (text.length < 50) return status($("resumeStatus"), "The resume text is empty or too short.", "error");
  await store.set({ resume: { name: resumeName || "pasted text", text, updatedAt: Date.now() } });
  status($("resumeStatus"), "Saved. Open LinkedIn Jobs and scroll.", "ok");
};

// ---------- LinkedIn profile ----------

$("importProfile").onclick = async () => {
  let url = $("profileUrl").value.trim();
  if (url && !/^https:\/\/(www\.)?linkedin\.com\/in\/[^/?#]+/i.test(url)) {
    return status($("profileStatus"), "That doesn't look like a linkedin.com/in/… profile link.", "error");
  }
  url = url ? url.replace(/^https:\/\/linkedin\.com/i, "https://www.linkedin.com") : "https://www.linkedin.com/in/me/";
  await store.set({ profileUrl: $("profileUrl").value.trim(), profileImportError: null });
  status($("profileStatus"), "Opening your profile… this tab will come back when it's done.");
  await chrome.runtime.sendMessage({ type: "import-profile", url });
};

$("clearProfile").onclick = async () => {
  await store.remove("profile");
};

// ---------- usage ----------

$("clearCache").onclick = async () => {
  await chrome.runtime.sendMessage({ type: "clear-cache" });
  status($("stats"), "Cache cleared. Jobs will be scored again as you scroll.");
};

// ---------- load + live refresh ----------

let refreshed = false;

async function refresh() {
  const s = await store.get(["provider", "apiKey", "typesafeKey", "resume", "profile", "profileUrl", "profileImportError", "stats"]);
  if (!refreshed) {
    const provider = s.provider === "typesafe" ? "typesafe" : "openrouter";
    document.querySelector(`input[name="provider"][value="${provider}"]`).checked = true;
    showProvider(provider);
    refreshed = true;
  }
  if (s.apiKey && !$("openrouterKey").value) $("openrouterKey").value = s.apiKey;
  if (s.typesafeKey && !$("typesafeKey").value) $("typesafeKey").value = s.typesafeKey;
  if (s.resume && !$("resumeText").value) {
    $("resumeText").value = s.resume.text;
    resumeName = s.resume.name;
    status($("resumeStatus"), `Saved: ${s.resume.name}, ${fmtDate(s.resume.updatedAt)}`, "ok");
  }
  if (s.profileUrl && !$("profileUrl").value) $("profileUrl").value = s.profileUrl;
  if (s.profileImportError) {
    status($("profileStatus"), "Couldn't read your profile. Check that you're logged in to LinkedIn in this browser and that the link is right, then try again.", "error");
  } else if (s.profile) {
    status($("profileStatus"), `Captured ${s.profile.text.length.toLocaleString()} characters from ${s.profile.url} on ${fmtDate(s.profile.capturedAt)}.`, "ok");
    $("profileText").textContent = s.profile.text;
    $("profileDetails").hidden = false;
  } else {
    if ($("profileStatus").dataset.kind === "ok") status($("profileStatus"), "");
    $("profileDetails").hidden = true;
  }
  const st = s.stats || { scored: 0, cost: 0 };
  $("stats").textContent = `${st.scored.toLocaleString()} jobs scored, $${st.cost.toFixed(4)} spent on Jev.`;
}

chrome.storage.onChanged.addListener((_, area) => area === "local" && refresh());
refresh();
