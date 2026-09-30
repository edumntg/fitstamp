const $ = (id) => document.getElementById(id);

chrome.storage.local.get(["apiKey", "resume", "profile", "enabled", "stats"]).then((s) => {
  $("hasKey").classList.toggle("done", !!s.apiKey);
  $("hasResume").classList.toggle("done", !!s.resume?.text);
  $("hasProfile").classList.toggle("done", !!s.profile?.text);
  $("enabled").checked = s.enabled !== false;
  const st = s.stats || { scored: 0, cost: 0 };
  $("stats").textContent = `${st.scored.toLocaleString()} jobs scored · $${st.cost.toFixed(4)} spent`;
});

$("enabled").onchange = (e) => chrome.storage.local.set({ enabled: e.target.checked });
$("jobs").onclick = () => chrome.tabs.create({ url: "https://www.linkedin.com/jobs/collections/recommended/" });
$("settings").onclick = () => chrome.runtime.openOptionsPage();
