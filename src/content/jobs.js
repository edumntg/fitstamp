// Runs on linkedin.com/jobs/*. Finds job cards, and as each one scrolls into
// view it fetches the full posting, asks the background worker for a Jev score
// and stamps the card.
//
// The jobs page is a long-lived SPA with a virtualised list: LinkedIn destroys
// and re-creates cards on every scroll and mutates the DOM constantly. Nothing
// here may grow with time. The queue holds job ids, never cards, so a card
// LinkedIn dropped can be collected; cards are unobserved as soon as they leave
// the DOM; scans are rate-limited and ignore our own changes; and the scores
// remembered per tab are capped.
(() => {
  const CONCURRENCY = 3;
  const MAX_RESULTS = 3000; // scores kept in this tab; a LinkedIn tab stays open for hours
  const SCAN_INTERVAL = 300; // ms between scans while the page keeps changing
  const MAX_STRIPS = 5; // stamps LinkedIn's renderer may throw out of one slot per STRIP_WINDOW before we leave it alone
  const STRIP_WINDOW = 60000;
  const results = new Map(); // jobId -> { state: "loading" | "done" | "error", data }
  const queue = []; // job ids waiting for a score
  let running = 0;
  let pausedUntil = 0;
  let blocked = null; // "no-key" | "no-resume" | "disabled" | "bad-key" | "no-credits"
  let generation = 0; // bumped when settings change, so in-flight scores from before are dropped

  // ---------- finding cards ----------

  // Only /jobs/view/<id> links identify a job. `currentJobId=` is NOT used: on the
  // search page nearly every link (feedback, footer, chips) carries the id of the
  // job that is open, which would stamp all of them.
  const idFromHref = (href) => (href?.match(/\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})/) || [])[1] || null;

  // The open job's pane, in the 2026 layout, the older logged-in layout and the
  // logged-out page.
  const DETAIL_ROOTS =
    '[data-sdui-screen*="JobDetails"], .jobs-search__job-details, .jobs-details, .job-view-layout, .details-pane__content, .top-card-layout';

  // Card selectors, newest layout first:
  //   2026 layout: div[role=button][componentkey="job-card-component-ref-<id>"], no links inside
  //   older logged-in layout: li[data-occludable-job-id] / [data-job-id]
  //   logged-out page: [data-entity-urn="urn:li:jobPosting:<id>"]
  function findCards() {
    const cards = new Map();
    const add = (el, id) => {
      if (!id || !el || cards.has(el)) return;
      if (el.parentElement?.closest("[data-fitstamp-id]")) return; // nested inside a stamped card
      cards.set(el, id);
    };
    document.querySelectorAll('[role="button"][componentkey^="job-card-component-ref-"]').forEach((el) => {
      add(el, el.getAttribute("componentkey").slice("job-card-component-ref-".length).match(/^\d+/)?.[0]);
    });
    document.querySelectorAll("li[data-occludable-job-id]").forEach((el) => add(el, el.dataset.occludableJobId));
    document.querySelectorAll("[data-job-id]").forEach((el) => {
      if (!el.closest("li[data-occludable-job-id]")) add(el, el.dataset.jobId);
    });
    document.querySelectorAll('[data-entity-urn*="jobPosting:"]').forEach((el) => {
      add(el, (el.getAttribute("data-entity-urn").match(/jobPosting:(\d+)/) || [])[1]);
    });
    document.querySelectorAll('a[href*="/jobs/view/"]').forEach((a) => {
      if (a.closest("[data-fitstamp-id], li[data-occludable-job-id], [data-job-id], [data-entity-urn*='jobPosting:'], [componentkey^='job-card-component-ref-']")) return;
      if (a.closest(DETAIL_ROOTS)) return;
      add(a.closest("li") || a, idFromHref(a.getAttribute("href")));
    });
    return cards;
  }

  // The open job: its id and the element its stamp goes right after (the title).
  function findDetail() {
    for (const root of document.querySelectorAll(DETAIL_ROOTS)) {
      const link = root.querySelector('a[href*="/jobs/view/"]');
      const id = idFromHref(link?.getAttribute("href"));
      if (!id) continue;
      // Title links sit inside a <p>/<h1>/<h2> in some layouts and wrap the <h2> in others.
      const after = /^(P|H1|H2|H3)$/.test(link.parentElement.tagName) ? link.parentElement : link;
      return { id, after };
    }
    return null;
  }

  const cardsFor = (id) => document.querySelectorAll(`[data-fitstamp-id="${CSS.escape(id)}"]`);

  // In the 2026 layout the card is a wrapper around one flex column; the stamp
  // goes at the end of that column so it sits under "Posted … · Easy Apply".
  function slotFor(card) {
    if (card.matches("[componentkey^='job-card-component-ref-']")) {
      return card.querySelector(":scope > [componentkey^='job-card-component-ref-']") || card;
    }
    return card;
  }

  function cardText(card) {
    if (!card) return {};
    const pick = (sels) => {
      for (const s of sels) {
        const t = card.querySelector(s)?.innerText?.trim();
        if (t) return t.split("\n")[0];
      }
      return "";
    };
    return {
      title: pick([".job-card-list__title", ".job-card-list__title--link", ".base-search-card__title", "a[href*='/jobs/view/'] strong", "a[href*='/jobs/view/']", "p"]),
      company: pick([".artdeco-entity-lockup__subtitle", ".job-card-container__primary-description", ".base-search-card__subtitle"]),
      location: pick([".job-card-container__metadata-item", ".artdeco-entity-lockup__caption", ".job-search-card__location"]),
    };
  }

  // ---------- job description via the public guest endpoint ----------

  // Postings are parsed in one inert scratch document, reused for every fetch,
  // instead of a new DOMParser document each time: a Blink Document is heavy and
  // only goes away at a major GC, and a tab downloads thousands of postings. It
  // has no browsing context, so nothing in it loads, runs or renders.
  let scratchDoc = null;
  const scratch = () => (scratchDoc ||= document.implementation.createHTMLDocument(""));

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
    // Filled and read with no await in between, so concurrent fetches never share it.
    const html = await res.text();
    const doc = scratch();
    doc.body.innerHTML = html;
    try {
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
    } finally {
      doc.body.replaceChildren();
    }
  }

  // ---------- queue ----------

  function enqueue(id) {
    if (results.has(id)) return;
    remember(id, { state: "loading" });
    queue.push(id);
    pump();
  }

  // Map keeps insertion order, so once full the oldest finished scores go first.
  function remember(id, r) {
    results.delete(id);
    results.set(id, r);
    for (const [oldId, old] of results) {
      if (results.size <= MAX_RESULTS) break;
      if (old.state !== "loading") results.delete(oldId);
    }
  }

  let pumpTimer = null;
  function pump() {
    if (blocked) return;
    const wait = pausedUntil - Date.now();
    if (wait > 0) {
      // One timer per pause, however many times pump() is called meanwhile.
      if (!pumpTimer) pumpTimer = setTimeout(() => { pumpTimer = null; pump(); }, wait);
      return;
    }
    while (running < CONCURRENCY && queue.length) {
      const id = queue.shift();
      running++;
      process(id).finally(() => {
        running--;
        pump();
      });
    }
  }

  async function process(id, attempt = 0) {
    const gen = generation;
    let posting = null;
    try {
      posting = await fetchPosting(id);
    } catch (e) {
      if (e.rateLimited && attempt < 2) {
        pausedUntil = Date.now() + 20000 * (attempt + 1);
        await new Promise((r) => setTimeout(r, pausedUntil - Date.now()));
        return process(id, attempt + 1);
      }
    }
    // No posting: score from the card itself, if LinkedIn still shows it.
    const fromCard = posting ? {} : cardText(cardsFor(id)[0]);
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
    if (gen !== generation) return; // settings changed while scoring: this result is for the old resume or key
    if (res.ok) {
      remember(id, { state: "done", data: res.result, partial: !job.description });
    } else if (["no-key", "no-resume", "disabled", "bad-key", "no-credits"].includes(res.reason)) {
      return block(res.reason);
    } else {
      remember(id, { state: "error", message: res.message });
    }
    for (const card of cardsFor(id)) render(card, id);
    renderDetail();
  }

  // Nothing can be scored until the settings change, which re-arms everything
  // in the storage listener below; until then the page is left alone.
  function block(reason) {
    blocked = reason;
    for (const id of queue) results.delete(id);
    queue.length = 0;
    for (const [id, r] of results) if (r.state === "loading") results.delete(id);
    unwatch();
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

  // Marks a stamp (or the banner) as removed by us, so the mutation observer can
  // tell it apart from one LinkedIn's renderer threw away (which needs putting back).
  function drop(el) {
    el.dataset.gone = "1";
    el.remove();
  }

  // Puts the stamp for `id` into `old`'s place, or hands a new one to `insert`.
  function place(old, id, insert, extraClass) {
    const r = results.get(id);
    if (!r) return void (old && drop(old));
    const key = `${id}:${r.state}:${r.data?.match ?? ""}`;
    if (old && old.dataset.key === key) return;
    const badge = badgeFor(r);
    badge.dataset.key = key;
    if (extraClass) badge.classList.add(extraClass);
    if (old) {
      old.dataset.gone = "1";
      old.replaceWith(badge);
    } else {
      insert(badge);
    }
  }

  // Slots whose stamp LinkedIn's renderer keeps removing. Re-stamping such a slot
  // every time would make the two of us fight over the DOM, so after MAX_STRIPS
  // in a minute the slot is left alone until the minute is up.
  const strips = new WeakMap(); // slot element -> { n, since }
  function stripped(slot) {
    const now = Date.now();
    let s = strips.get(slot);
    if (!s || now - s.since > STRIP_WINDOW) strips.set(slot, (s = { n: 0, since: now }));
    s.n++;
  }
  function hostile(slot) {
    const s = strips.get(slot);
    return !!s && s.n >= MAX_STRIPS && Date.now() - s.since <= STRIP_WINDOW;
  }

  function render(card, id) {
    const slot = slotFor(card);
    if (hostile(slot)) return;
    const inline = slot !== card ? "fitstamp-inline" : "";
    place(slot.querySelector(":scope > .fitstamp-badge"), id, (b) => slot.appendChild(b), inline);
  }

  function renderDetail() {
    const d = findDetail();
    const old = document.querySelector(".fitstamp-detail");
    if (!d) return void (old && drop(old));
    if (old && old.previousElementSibling !== d.after) drop(old);
    if (hostile(d.after.parentElement)) return;
    const current = document.querySelector(".fitstamp-detail");
    if (!results.has(d.id) && !blocked) enqueue(d.id);
    place(current, d.id, (b) => d.after.after(b), "fitstamp-detail");
  }

  function renderAll() {
    for (const [card, id] of registered()) render(card, id);
    renderDetail();
  }

  function registered() {
    return [...document.querySelectorAll("[data-fitstamp-id]")].map((el) => [el, el.dataset.fitstampId]);
  }

  let bannerEl = null;
  function showBanner(reason) {
    const msg = {
      "no-key": "add your OpenRouter or TypeSafe API key",
      "no-resume": "upload your resume",
      "bad-key": "your API key was rejected, check it",
      "no-credits": "your account is out of credits",
      disabled: null,
    }[reason];
    if (bannerEl) drop(bannerEl);
    bannerEl = null;
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
        if (!blocked) enqueue(id);
        render(e.target, id);
      }
    },
    { rootMargin: "200px 0px" }
  );
  const observed = new WeakSet(); // cards currently handed to `io`

  function scan() {
    for (const [card, id] of findCards()) {
      if (card.dataset.fitstampId !== id) card.dataset.fitstampId = id;
      if (!observed.has(card)) {
        observed.add(card);
        io.observe(card);
      }
      // Virtualised lists empty and refill cards on scroll; put the stamp back.
      if (results.has(id)) render(card, id);
    }
    renderDetail();
  }

  // A card LinkedIn took out of the page: let go of it so it can be collected.
  function forget(node) {
    if (node.isConnected) return; // moved, not removed
    const cards = node.matches("[data-fitstamp-id]") ? [node] : node.querySelectorAll("[data-fitstamp-id]");
    for (const card of cards) {
      io.unobserve(card);
      observed.delete(card);
    }
  }

  // At most one scan per SCAN_INTERVAL, and never starved: a page that mutates
  // non-stop still gets scanned. Hidden tabs wait until they're shown again.
  let scanTimer = null;
  let scanWhenVisible = false;
  function requestScan() {
    if (document.hidden) return void (scanWhenVisible = true);
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, SCAN_INTERVAL);
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && scanWhenVisible) {
      scanWhenVisible = false;
      requestScan();
    }
  });

  // Our own stamps and banner are skipped: the page changing is what calls for a
  // scan, not us stamping it. Text-only churn (counters, timestamps) is skipped too.
  const OURS = ".fitstamp-badge, .fitstamp-banner";
  const mo = new MutationObserver((mutations) => {
    let changed = false;
    for (const m of mutations) {
      for (const n of m.addedNodes) if (n.nodeType === 1 && !n.matches(OURS)) changed = true;
      for (const n of m.removedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches(OURS)) {
          if (n.dataset.gone) continue;
          // LinkedIn's renderer threw a stamp away: put it back, unless this slot keeps doing it.
          stripped(m.target);
          if (!hostile(m.target)) changed = true;
          continue;
        }
        forget(n);
      }
    }
    if (changed) requestScan();
  });
  function watch() {
    mo.observe(document.body, { childList: true, subtree: true });
    scan();
  }
  function unwatch() {
    mo.disconnect();
    clearTimeout(scanTimer);
    scanTimer = null;
    scanWhenVisible = false;
  }
  watch();

  // New resume / profile / key / toggle / cleared cache: drop every stamp and start over.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!["provider", "apiKey", "typesafeKey", "resume", "profile", "enabled", "cacheEpoch"].some((k) => k in changes)) return;
    generation++;
    blocked = null;
    if (bannerEl) drop(bannerEl);
    bannerEl = null;
    queue.length = 0;
    results.clear();
    document.querySelectorAll(".fitstamp-badge").forEach(drop);
    for (const [card] of registered()) {
      io.unobserve(card);
      io.observe(card);
    }
    unwatch();
    watch();
  });
})();
