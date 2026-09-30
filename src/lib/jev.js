// Jev is a decision model: it never writes text, it answers typed questions
// (score / noul / choice) about a `state` with calibrated probabilities.
// Docs: https://docs.typesafe.ai/api and https://openrouter.ai/docs/guides/community/typesafe-sdk
//
// Both providers take the same request and return the same answers; only the
// URL, the model name and the error body differ.
export const PROVIDERS = {
  openrouter: {
    label: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1/systemone",
    model: "jev-1.13",
    headers: { "HTTP-Referer": "https://github.com/edumntg/fitstamp", "X-Title": "FitStamp" },
  },
  typesafe: {
    label: "TypeSafe",
    endpoint: "https://api.typesafe.ai/v1/systemone",
    model: "jev-1.13.0",
    headers: {},
  },
};

// TypeSafe doesn't report cost; Jev 1.13 bills $0.042 per million input tokens.
const USD_PER_INPUT_TOKEN = 0.042 / 1e6;

// Jev's context is 32k tokens. These caps keep resume + profile + job well under it.
const MAX_RESUME = 14000;
const MAX_PROFILE = 8000;
const MAX_JOB = 9000;

const FIT_LEVELS = [
  "No meaningful overlap with the job",
  "Adjacent: some transferable experience, but most core requirements are missing",
  "Solid: meets most core requirements",
  "Strong: meets nearly all requirements and the seniority fits",
];

const QUESTIONS = {
  fit: {
    type: "score",
    instructions:
      "How well does `candidate` match `job`, judging skills, experience, domain and seniority?",
    criteria: FIT_LEVELS,
  },
  requirements: {
    type: "noul",
    instructions:
      "Does `candidate` meet the hard requirements `job` lists (years of experience, required technologies, degrees, certifications, languages)?",
  },
  seniority: {
    type: "noul",
    instructions: "Is `candidate`'s seniority right for `job`, neither far too junior nor far too senior?",
  },
};

const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + " …" : s || "");

export function buildState(candidate, job) {
  const c = { resume: clip(candidate.resume, MAX_RESUME) };
  if (candidate.profile) c.linkedin_profile = clip(candidate.profile, MAX_PROFILE);
  const j = { title: job.title || "", company: job.company || "", location: job.location || "" };
  if (job.criteria) j.criteria = job.criteria;
  j.description = job.description ? clip(job.description, MAX_JOB) : "(not available, judge from the title)";
  return { candidate: c, job: j };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `auth` is { provider: "openrouter" | "typesafe", apiKey }.
async function call(auth, state, questions, attempt = 0) {
  const p = PROVIDERS[auth.provider] || PROVIDERS.openrouter;
  const res = await fetch(p.endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${auth.apiKey}`, "Content-Type": "application/json", ...p.headers },
    body: JSON.stringify({ model: p.model, state, questions }),
  });
  // 429 = rate limited, 529 = TypeSafe overloaded: both ask for a retry with backoff.
  if ((res.status === 429 || res.status === 529) && attempt < 3) {
    const retryAfter = Number(res.headers.get("retry-after")) * 1000;
    await sleep(retryAfter || 1000 * 2 ** attempt);
    return call(auth, state, questions, attempt + 1);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // OpenRouter: { error: { message } }. TypeSafe: { detail: { message } } or { detail: "..." }.
    const detail = body?.detail;
    const msg = body?.error?.message || detail?.message || (typeof detail === "string" ? detail : "") || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return body;
}

const costOf = (usage) => usage?.cost ?? (usage?.input_tokens != null ? usage.input_tokens * USD_PER_INPUT_TOKEN : null);

// Weights live in code on purpose (the "composite scoring" pattern): the model
// answers narrow questions, we decide how much each one matters.
export function combine(answers) {
  const fit = answers.fit;
  const fitNorm = fit.score / (FIT_LEVELS.length - 1);
  const req = answers.requirements.noul;
  const sen = answers.seniority.noul;
  const match = Math.round((0.6 * fitNorm + 0.25 * req + 0.15 * sen) * 100);
  return {
    match,
    confidence: fit.confidence,
    verdict: match >= 70 ? "good" : match >= 45 ? "partial" : "weak",
    fitLevel: FIT_LEVELS[Math.round(fit.score)],
    fitScore: fit.score,
    requirements: req,
    seniority: sen,
  };
}

export async function scoreJob(auth, candidate, job) {
  const body = await call(auth, buildState(candidate, job), QUESTIONS);
  return { ...combine(body.answers), cost: costOf(body.usage) };
}

export async function testKey(auth) {
  const body = await call(auth, "Hello", {
    ok: { type: "noul", instructions: "Is this a greeting?" },
  });
  return costOf(body.usage) ?? 0;
}
