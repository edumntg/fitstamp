import * as pdfjs from "../../vendor/pdfjs/pdf.min.mjs";
import { testKey } from "../lib/jev.js";

pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdfjs/pdf.worker.min.mjs");

const $ = (id) => document.getElementById(id);
const store = chrome.storage.local;

function status(el, text, kind = "") {
  el.textContent = text;
  el.dataset.kind = kind;
}

const fmtDate = (t) => new Date(t).toLocaleString();

// ---------- API key ----------

$("saveKey").onclick = async () => {
  const apiKey = $("apiKey").value.trim();
  if (!apiKey) return status($("keyStatus"), "Paste a key first.", "error");
  await store.set({ apiKey });
  status($("keyStatus"), "Saved.", "ok");
};

$("testKey").onclick = async () => {
  const apiKey = $("apiKey").value.trim();
  if (!apiKey) return status($("keyStatus"), "Paste a key first.", "error");
  status($("keyStatus"), "Testing…");
  try {
    await testKey(apiKey);
    status($("keyStatus"), "The key works and Jev answered.", "ok");
  } catch (e) {
    status($("keyStatus"), `Jev call failed: ${e.message}`, "error");
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
  await store.set({ profileUrl: $("profileUrl").value.trim() });
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

async function refresh() {
  const s = await store.get(["apiKey", "resume", "profile", "profileUrl", "stats"]);
  if (s.apiKey && !$("apiKey").value) $("apiKey").value = s.apiKey;
  if (s.resume && !$("resumeText").value) {
    $("resumeText").value = s.resume.text;
    resumeName = s.resume.name;
    status($("resumeStatus"), `Saved: ${s.resume.name}, ${fmtDate(s.resume.updatedAt)}`, "ok");
  }
  if (s.profileUrl && !$("profileUrl").value) $("profileUrl").value = s.profileUrl;
  if (s.profile) {
    status($("profileStatus"), `Captured ${s.profile.text.length.toLocaleString()} characters from ${s.profile.url} on ${fmtDate(s.profile.capturedAt)}.`, "ok");
    $("profileText").textContent = s.profile.text;
    $("profileDetails").hidden = false;
  } else {
    if ($("profileStatus").dataset.kind === "ok") status($("profileStatus"), "");
    $("profileDetails").hidden = true;
  }
  const st = s.stats || { scored: 0, cost: 0 };
  $("stats").textContent = `${st.scored.toLocaleString()} jobs scored, $${st.cost.toFixed(4)} spent on OpenRouter.`;
}

chrome.storage.onChanged.addListener((_, area) => area === "local" && refresh());
refresh();
