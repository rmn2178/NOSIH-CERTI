/**
 * Probes the RUNNING local system (file-based, read-only HTTP).
 *
 *   node scripts/probe-running.mjs
 *
 * Asserts the backend boots in its designed degraded mode when config is
 * missing (readable 503 + problem list, never a crash), the SPA serves, and
 * the CRA dev proxy wires /api to the backend.
 */
const BACKEND = "http://127.0.0.1:5000";
const FRONTEND = "http://127.0.0.1:3000";

let passed = 0;
let failed = 0;
const check = (label, cond, detail = "") => {
  if (cond) { passed++; console.log(`PASS  ${label}${detail ? " — " + detail : ""}`); }
  else { failed++; console.log(`FAIL  ${label}${detail ? " — " + detail : ""}`); }
};

async function poll(fn, timeoutMs, stepMs = 1000) {
  const start = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* not up yet */ }
    if (Date.now() - start > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// ── Backend ──
const health = await poll(async () => {
  const res = await fetch(`${BACKEND}/api/health`);
  return { status: res.status, body: await res.json() };
}, 30000);

check("backend answers /api/health", Boolean(health));
if (health) {
  const names = (health.body?.config?.problems || []).map((p) => p.name);
  check("health reports degraded (missing config), not a crash", health.status === 503 && health.body?.status === "degraded", `HTTP ${health.status}`);
  check("problem list names SUPABASE_SERVICE_ROLE_KEY", names.includes("SUPABASE_SERVICE_ROLE_KEY"), names.join(", "));
  check("every problem carries a hint", (health.body?.config?.problems || []).every((p) => p.hint));
}

const login = await fetch(`${BACKEND}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "probe@nosih.test", password: "probe-password" }),
}).then(async (res) => ({ status: res.status, body: await res.json() })).catch(() => null);
check("login route answers readable 503 envelope (never simulated success)", login?.status === 503 && Boolean(login?.body?.error || login?.body?.problems), `HTTP ${login?.status}`);

// ── Frontend (CRA first compile can take a while) ──
// Browser navigations send Accept: text/html — the CRA dev proxy only
// forwards non-HTML requests to the backend, so the probe must match that.
const HTML = { Accept: "text/html" };
const home = await poll(async () => {
  const res = await fetch(`${FRONTEND}/`, { headers: HTML });
  const text = await res.text();
  return res.status === 200 && /NOSIH/.test(text) ? { status: res.status, text } : null;
}, 180000);
check("SPA serves / with NOSIH branding", Boolean(home));

const verify = await fetch(`${FRONTEND}/verify`, { headers: HTML }).then((r) => r.status).catch(() => 0);
check("SPA serves the public /verify route", verify === 200, `HTTP ${verify}`);

const proxied = await fetch(`${FRONTEND}/api/health`).then(async (r) => ({ status: r.status, body: await r.json() })).catch(() => null);
check("dev proxy wires /api → backend", proxied?.status === 503 && proxied?.body?.status === "degraded", `HTTP ${proxied?.status}`);

console.log(`\n${passed}/${passed + failed} probes passed`);
console.log(failed ? "probe: FAIL" : "probe: PASS — system is running (degraded config is reported, not hidden)");
// No process.exit: on Windows it races undici's keep-alive socket teardown
// (libuv assertion). Let the loop drain naturally.
process.exitCode = failed ? 1 : 0;