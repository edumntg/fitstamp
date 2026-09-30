// Runs on linkedin.com/in/*. Does nothing unless this tab was opened by the
// "Import my LinkedIn profile" button, in which case it reads the profile text
// and hands it to the background worker, which stores it locally.
(async () => {
  const { capture } = await chrome.runtime.sendMessage({ type: "is-import-tab" }).catch(() => ({}));
  if (!capture) return;

  const note = document.createElement("div");
  note.textContent = "FitStamp is reading your profile… keep this tab open.";
  Object.assign(note.style, {
    position: "fixed", top: "12px", left: "50%", transform: "translateX(-50%)", zIndex: 99999,
    padding: "10px 16px", borderRadius: "999px", background: "#1d2226", color: "#fff",
    font: "600 14px system-ui, sans-serif", boxShadow: "0 6px 24px rgba(0,0,0,.25)",
  });
  document.body.appendChild(note);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  for (let i = 0; i < 40 && !document.querySelector("main h1, main h2"); i++) await sleep(250);

  // Sections below the fold load lazily, so walk down the page first.
  for (let y = 0; y < document.body.scrollHeight; y += window.innerHeight * 0.8) {
    window.scrollTo(0, y);
    await sleep(350);
  }
  window.scrollTo(0, 0);
  await sleep(500);

  const NOISE = [
    /^show all\b/i, /^see more$/i, /^…?see more$/i, /^show more$/i, /^show less$/i,
    /^(message|more|connect|follow|following|pending)$/i, /^open to$/i, /^add (profile )?section$/i,
    /^enhance profile$/i, /^resources$/i, /^private to you$/i, /^endorse$/i, /^contact info$/i,
    /^\d+(\+)? (connections|followers)$/i, /^·$/, /^(1st|2nd|3rd\+?)$/,
  ];
  const main = document.querySelector("main") || document.body;
  const lines = [];
  for (const raw of main.innerText.split("\n")) {
    const line = raw.trim();
    if (!line || NOISE.some((re) => re.test(line))) continue;
    // Screen-reader copies make most lines appear twice in a row.
    if (lines[lines.length - 1] === line) continue;
    lines.push(line);
  }
  const text = lines.join("\n").slice(0, 12000);

  await chrome.runtime.sendMessage({ type: "profile-captured", url: location.href.split("?")[0], text });
  note.textContent = `FitStamp saved your profile (${text.length.toLocaleString()} characters). This tab will close.`;
})();
