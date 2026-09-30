// Runs on linkedin.com/jobs/*. Finds job cards, and as each one scrolls into
// view it fetches the full posting, asks the background worker for a Jev score
// and stamps the card.
(() => {
  const CONCURRENCY = 3;
  const results = new Map(); // jobId -> { state: "loading" | "done" | "error", data }
  const queue = [];
  let running = 0;
  let pausedUntil = 0;
  let blocked = null; // "no-key" | "no-resume" | "disabled" | "bad-key" | "no-credits"

  // ---------- finding cards ----------

  const ID_FROM_HREF = [/\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})/, /[?&]currentJobId=(\d{6,})/];

  function idFromHref(href) {
    for (const re of ID_FROM_HREF) {
      const m = href && href.match(re);
      if (m) return m[1];
    }
    return null;
  }

  // LinkedIn renames classes often, so cards are found by data attributes first
  // and by links to /jobs/view/<id> as a fallback.
  function findCards() {
    const cards = new Map();
    const add = (el, id) => {
      if (!id || !el || cards.has(el)) return;
      if (el.parentElement?.closest("[data-fitstamp-id]")) return; // nested inside a stamped card
      cards.set(el, id);
    };
    document.querySelectorAll("li[data-occludable-job-id]").forEach((el) => add(el, el.dataset.occludableJobId));
    document.querySelectorAll("[data-job-id]").forEach((el) => {
      if (!el.closest("li[data-occludable-job-id]")) add(el, el.dataset.jobId);
    });
    document.querySelectorAll('[data-entity-urn*="jobPosting:"]').forEach((el) => {
      add(el, (el.getAttribute("data-entity-urn").match(/jobPosting:(\d+)/) || [])[1]);
    });
    document.querySelectorAll('a[href*="/jobs/view/"], a[href*="currentJobId="]').forEach((a) => {
      if (a.closest("li[data-occludable-job-id], [data-job-id], [data-entity-urn*='jobPosting:']")) return;
      if (a.closest(".jobs-search__job-details, .jobs-details, .job-view-layout")) return;
      add(a.closest("li") || a, idFromHref(a.getAttribute("href")));
    });
    return cards;
  }

  function cardText(card) {
    const pick = (sels) => {
      for (const s of sels) {
        const t = card.querySelector(s)?.innerText?.trim();
        if (t) return t.split("\n")[0];
      }
      return "";
    };
    return {
      title: pick([".job-card-list__title", ".job-card-list__title--link", ".base-search-card__title", "a[href*='/jobs/view/'] strong", "a[href*='/jobs/view/']"]),
      company: pick([".artdeco-entity-lockup__subtitle", ".job-card-container__primary-description", ".base-search-card__subtitle"]),
      location: pick([".job-card-container__metadata-item", ".artdeco-entity-lockup__caption", ".job-search-card__location"]),
    };
  }

  // ---------- job description via the public guest endpoint ----------

  // credentials: "omit" matters: with the session cookie attached LinkedIn
  // answers the guest route with 999 instead of the posting.
  async function fetchPosting(id) {
    const res = await fetch(`/jobs-guest/jobs/api/jobPosting/${id}`, { credentials: "omit" });
    if (res.status === 429 || res.status === 999) {
      const err = new Error("rate-limited");
      err.rateLimited = true;
      throw err;
    }
    if (!res.ok) return null;
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const text = (sel) => doc.querySelector(sel)?.textContent.replace(/\s+/g, " ").trim() || "";
    const descEl = doc.querySelector(".show-more-less-html__markup, .description__text");
    if (!descEl) return null;
    const criteria = [...doc.querySelectorAll(".description__job-criteria-item")]
      .map((li) => `${li.querySelector("h3")?.textContent.trim()}: ${li.querySelector("span")?.textContent.trim()}`)
      .join("; ");
    return {
      title: text(".top-card-layout__title, .topcard__title"),
      company: text(".topcard__org-name-link, .topcard__flavor"),
      location: text(".topcard__flavor--bullet"),
      criteria,
      description: descEl.innerText?.trim() || descEl.textContent.replace(/\s+/g, " ").trim(),
    };
  }

  // ---------- queue ----------

  function enqueue(id, card) {
    if (results.has(id)) return;
    results.set(id, { state: "loading" });
    queue.push({ id, card });
    pump();
  }

  function pump() {
    if (blocked) return;
    const wait = pausedUntil - Date.now();
    if (wait > 0) return void setTimeout(pump, wait);
    while (running < CONCURRENCY && queue.length) {
      const job = queue.shift();
      running++;
      process(job).finally(() => {
        running--;
        pump();
      });
    }
  }

  async function process({ id, card }, attempt = 0) {
    let posting = null;
    try {
      posting = await fetchPosting(id);
    } catch (e) {
      if (e.rateLimited && attempt < 2) {
        pausedUntil = Date.now() + 20000 * (attempt + 1);
        await new Promise((r) => setTimeout(r, pausedUntil - Date.now()));
        return process({ id, card }, attempt + 1);
      }
    }
    const fromCard = cardText(card);
    const job = {
      id,
      title: posting?.title || fromCard.title,
      company: posting?.company || fromCard.company,
      location: posting?.location || fromCard.location,
      criteria: posting?.criteria || "",
      description: posting?.description || "",
    };

    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: "score", job });
    } catch {
      res = { ok: false, reason: "error", message: "Extension was reloaded. Refresh this page." };
    }
    if (res.ok) {
      results.set(id, { state: "done", data: res.result, partial: !job.description });
    } else if (["no-key", "no-resume", "disabled", "bad-key", "no-credits"].includes(res.reason)) {
      block(res.reason);
    } else {
      results.set(id, { state: "error", message: res.message });
    }
    renderAll();
  }

  function block(reason) {
    blocked = reason;
    for (const { id } of queue) results.delete(id);
    queue.length = 0;
    for (const [id, r] of results) if (r.state === "loading") results.delete(id);
    renderAll();
    showBanner(reason);
  }

  // ---------- rendering ----------

  const pct = (x) => `${Math.round(x * 100)}%`;
  const LABEL = { good: "Good match", partial: "Partial match", weak: "Weak match" };

  function badgeFor(r) {
    const el = document.createElement("div");
    el.className = "fitstamp-badge";
    if (r.state === "loading") {
      el.classList.add("fitstamp-loading");
      el.textContent = "Scoring…";
      return el;
    }
    if (r.state === "error") {
      el.classList.add("fitstamp-error");
      el.textContent = "FitStamp: error";
      el.title = r.message || "";
      return el;
    }
    const d = r.data;
    el.classList.add(`fitstamp-${d.verdict}`);
    el.innerHTML = `<b>${d.match}%</b><span>${LABEL[d.verdict]}</span><i>conf ${pct(d.confidence)}</i>`;
    el.title = [
      `Fit: ${d.fitLevel} (${d.fitScore.toFixed(2)} / 3)`,
      `Meets hard requirements: ${pct(d.requirements)}`,
      `Seniority fits: ${pct(d.seniority)}`,
      `Confidence: ${pct(d.confidence)}`,
      r.partial ? "Scored from the card only: the full posting could not be read." : "",
    ].filter(Boolean).join("\n");
    if (r.partial) el.classList.add("fitstamp-cardonly");
    return el;
  }

  function render(card, id) {
    const r = results.get(id);
    const old = card.querySelector(":scope > .fitstamp-badge");
    if (!r) return void old?.remove();
    const key = `${r.state}:${r.data?.match ?? ""}`;
    if (old && old.dataset.key === key) return;
    const badge = badgeFor(r);
    badge.dataset.key = key;
    old ? old.replaceWith(badge) : card.appendChild(badge);
  }

  function renderAll() {
    for (const [card, id] of registered()) render(card, id);
  }

  function registered() {
    return [...document.querySelectorAll("[data-fitstamp-id]")].map((el) => [el, el.dataset.fitstampId]);
  }

  let bannerEl = null;
  function showBanner(reason) {
    const msg = {
      "no-key": "add your OpenRouter API key",
      "no-resume": "upload your resume",
      "bad-key": "your OpenRouter API key was rejected, check it",
      "no-credits": "your OpenRouter account is out of credits",
      disabled: null,
    }[reason];
    bannerEl?.remove();
    if (!msg) return;
    bannerEl = document.createElement("div");
    bannerEl.className = "fitstamp-banner";
    bannerEl.innerHTML = `<b>FitStamp</b> can't score jobs yet: ${msg}. <button type="button">Open settings</button>`;
    bannerEl.querySelector("button").onclick = () => chrome.runtime.sendMessage({ type: "open-options" });
    document.body.appendChild(bannerEl);
  }

  // ---------- wiring ----------

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const id = e.target.dataset.fitstampId;
        if (!blocked) enqueue(id, e.target);
        render(e.target, id);
      }
    },
    { rootMargin: "200px 0px" }
  );

  function scan() {
    for (const [card, id] of findCards()) {
      if (card.dataset.fitstampId !== id) {
        card.dataset.fitstampId = id;
        io.observe(card);
      }
      // Virtualised lists empty and refill cards on scroll; put the stamp back.
      if (results.has(id)) render(card, id);
    }
  }

  let scanTimer = null;
  new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 250);
  }).observe(document.body, { childList: true, subtree: true });
  scan();

  // New resume / profile / key / toggle / cleared cache: drop every stamp and start over.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!["apiKey", "resume", "profile", "enabled", "cacheEpoch"].some((k) => k in changes)) return;
    blocked = null;
    bannerEl?.remove();
    queue.length = 0;
    results.clear();
    for (const [card] of registered()) {
      card.querySelector(":scope > .fitstamp-badge")?.remove();
      io.unobserve(card);
      io.observe(card);
    }
  });
})();
