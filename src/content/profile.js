// Runs on linkedin.com/in/*. Does nothing unless this tab was opened by the
// "Import profile" button. The import visits the profile page and then one
// /details/<section>/ page per section (the main page truncates lists behind
// "Show all" and lazy-loads them); on each page this script keeps only the
// sections that describe the person and hands them to the background worker.
(async () => {
  const job = await chrome.runtime.sendMessage({ type: "is-import-tab" }).catch(() => ({}));
  if (!job?.capture) return;

  const note = document.createElement("div");
  note.textContent = `FitStamp is reading your profile: ${job.label} (${job.step}/${job.total})… keep this tab open.`;
  Object.assign(note.style, {
    position: "fixed", top: "12px", left: "50%", transform: "translateX(-50%)", zIndex: 99999,
    padding: "10px 16px", borderRadius: "999px", background: "#1d2226", color: "#fff",
    font: "600 14px system-ui, sans-serif", boxShadow: "0 6px 24px rgba(0,0,0,.25)",
  });
  document.body.appendChild(note);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const main = () => document.querySelector("main") || document.body;

  for (let i = 0; i < 40 && !main().querySelector("h1, h2"); i++) await sleep(250);

  // Lazy sections load on scroll, and in the 2026 layout the page scrolls inside
  // an inner container rather than the window, so scroll whatever is scrollable.
  const scrollers = () =>
    [document.scrollingElement, ...main().querySelectorAll("*")].filter(
      (el) => el && el.scrollHeight > el.clientHeight + 100 && (el === document.scrollingElement || /auto|scroll/.test(getComputedStyle(el).overflowY))
    );
  for (let pass = 0; pass < 2; pass++) {
    for (const el of scrollers()) {
      for (let y = 0; y < el.scrollHeight; y += el.clientHeight * 0.8) {
        el.scrollTop = y;
        await sleep(300);
      }
    }
  }
  // Expand "… more" / "see more" so About and post texts aren't cut off.
  for (const b of main().querySelectorAll("button")) {
    if (/^(…|\.\.\.)?\s*(see )?more$/i.test(b.innerText.trim())) b.click();
  }
  await sleep(500);
  window.scrollTo(0, 0);

  // Sections worth sending to the matcher, and the ones that end a kept section.
  const KEEP = [
    "About", "Top skills", "Featured", "Services", "Experience", "Education", "Licenses & certifications",
    "Skills", "Projects", "Courses", "Languages", "Honors & awards", "Volunteering", "Volunteer experience",
    "Publications", "Test scores",
  ];
  const DROP = [
    "Suggested for you", "Analytics", "Resources", "Activity", "Recommendations", "Interests", "Causes",
    "People also viewed", "Who your viewers also viewed", "People you may know", "You might like",
    "Pages for you", "Profile language", "Public profile & URL", "More profiles for you",
    "Explore Premium profiles", "Explore collaborative articles", "Select language",
  ];
  const KEEP_LC = new Map(KEEP.map((h) => [h.toLowerCase(), h]));
  const DROP_LC = new Set(DROP.map((h) => h.toLowerCase()));

  const NOISE = [
    /^(…|\.\.\.)\s*more$/i, /^see (more|less)$/i, /^show (all|more|less)\b/i, /^show details$/i,
    /^(get started|view|message|connect|follow|following|pending|more|endorse|open to|edit)$/i,
    /^(?!(19|20)\d\d$)\d+(\.\d+)?[km]?$/i, // lone counts ("10" reactions), but not years /^\d[\d,]* (reactions?|comments?|reposts?|followers|connections)$/i, /^[\d,]+\+? (followers|connections)$/i,
    /^·$/, /^•?\s*(1st|2nd|3rd\+?)$/, /^share that you.re hiring/i, /^tell non-profits/i,
    /endorsements?$/i, /^endorsed by /i, /^passed linkedin skill assessment$/i,
    /^(all|industry knowledge|tools & technologies|interpersonal skills|other skills|\s)+$/i, // skills page tabs
    /^add (profile )?(section|skill|position|education|experience|certification|project|course|language)/i,
    /^enhance profile$/i, /^private to you$/i, /^reactivate premium/i, /^enjoy 24\/7 support/i,
    /logo$/i, /^company logo/i, /^(post|link|article|document|newsletter)$/i,
  ];

  // Text of main without sidebars, nav and footer (present inside main in the new layout).
  let text = main().innerText;
  for (const el of main().querySelectorAll("aside, footer, nav, [role='complementary']")) {
    const t = el.innerText?.trim();
    if (t) text = text.replace(t, "");
  }
  const raw = text.split("\n").map((l) => l.trim()).filter(Boolean);

  // Walk the lines, switching section on known headings. Each kept heading counts
  // once (the footer repeats "About"), and the footer's "About / Accessibility" pair ends the page.
  const top = [];
  const sections = {};
  const seen = new Set();
  let current = "top";
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    const lc = line.toLowerCase();
    if (lc === "about" && raw[i + 1]?.toLowerCase() === "accessibility") break;
    if (/^linkedin corporation ©/i.test(line)) break;
    if (KEEP_LC.has(lc) && !seen.has(lc)) {
      seen.add(lc);
      current = KEEP_LC.get(lc);
      sections[current] = sections[current] || [];
      continue;
    }
    if (DROP_LC.has(lc)) {
      current = null;
      continue;
    }
    if (!current || NOISE.some((re) => re.test(line))) continue;
    const bucket = current === "top" ? top : sections[current];
    // Screen-reader copies make many lines appear twice in a row.
    if (bucket[bucket.length - 1] === line) continue;
    bucket.push(line);
  }

  let payload;
  if (job.section === "main") {
    payload = { top, sections };
  } else if (!location.pathname.includes("/details/")) {
    payload = { lines: [] }; // LinkedIn sent us back to the profile: the section doesn't exist
  } else {
    payload = { lines: sections[job.heading] || [] };
  }

  note.textContent = `FitStamp: ${job.label} read.`;
  await chrome.runtime.sendMessage({ type: "profile-part", section: job.section, url: location.href.split("?")[0], ...payload });
})();
