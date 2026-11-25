/**
 * P8 rendered-UI failure proof (file-based, no external browser).
 *
 * Loads the production bundle into jsdom (shipped by CRA in
 * frontend/node_modules), stubs XMLHttpRequest so every /api call answers
 * 500 with the platform error envelope, and asserts the RENDERED DOM shows
 * readable errors instead of a blank React tree (React #31 regression).
 *
 * Scenarios:
 *   1. /login          — submit the form → .alert-error with the server message
 *   2. /verify?certificateId=CERT-8A91F203 — public verify renders readable failure
 *   3. / (protected)   — failed /auth/me redirects to /login
 *
 * Run: node scripts/check-ui-render.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
// jsdom ships with CRA's jest toolchain — reuse it, no new dependency.
const { JSDOM } = require(path.resolve("frontend/node_modules/jsdom"));

const BUILD = path.resolve("frontend/build");
const html = readFileSync(path.join(BUILD, "index.html"), "utf8");
const jsDir = path.join(BUILD, "static", "js");
const mainBundle = readdirSync(jsDir).find((f) => /^main\..+\.js$/.test(f));
if (!mainBundle) {
  console.error("FAIL: no main bundle in frontend/build — run the CI build first");
  process.exit(1);
}
const bundle = readFileSync(path.join(jsDir, mainBundle), "utf8");

const ENVELOPE = JSON.stringify({ error: { code: "500", message: "A server error has occurred" } });

let passed = 0;
let failed = 0;
function check(label, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail ? " — " + detail : ""}`);
  }
}

/** Minimal XMLHttpRequest stand-in: every request → 500 platform envelope. */
function installXhr(window) {
  class FakeXHR {
    constructor() {
      this.readyState = 0;
      this.status = 0;
      this.responseText = "";
      this.response = "";
      this.responseType = "";
      this.onreadystatechange = null;
      this.onload = null;
      this.onloadend = null;
      this.onerror = null;
      this.ontimeout = null;
      this.onabort = null;
      this.upload = { addEventListener() {}, removeEventListener() {} };
      this._headers = {};
    }
    open(method, url) {
      this._method = method;
      this._url = url;
      this.readyState = 1;
    }
    setRequestHeader(k, v) {
      this._headers[k] = v;
    }
    getAllResponseHeaders() {
      return "content-type: application/json\r\n";
    }
    getResponseHeader() {
      return "application/json";
    }
    addEventListener(type, fn) {
      this["on" + type] = fn;
    }
    removeEventListener() {}
    abort() {}
    send() {
      setTimeout(() => {
        this.readyState = 4;
        this.status = 500;
        this.statusText = "Internal Server Error";
        if (this.responseType === "blob") {
          this.response = new window.Blob([ENVELOPE], { type: "application/json" });
        } else {
          this.responseText = ENVELOPE;
          this.response = ENVELOPE;
        }
        this.onreadystatechange?.();
        this.onload?.();
        this.onloadend?.();
      }, 5);
    }
  }
  window.XMLHttpRequest = FakeXHR;
}

async function poll(fn, timeoutMs = 8000, stepMs = 50) {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function boot(urlPath) {
  const dom = new JSDOM(html, {
    url: "http://localhost" + urlPath,
    runScripts: "outside-only",
    pretendToBeVisual: true,
    resources: undefined,
  });
  const { window } = dom;
  // jsdom 16 lacks matchMedia; some libs probe it at import time.
  if (!window.matchMedia) {
    window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  }
  window.scrollTo = () => {};
  installXhr(window);
  window.eval(bundle);
  return dom;
}

/** React controlled inputs ignore direct .value writes — use the native setter. */
function setInput(window, el, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
}

const results = [];

// ── Scenario 1: /login form submission shows the readable server message ──
{
  const dom = boot("/login");
  const { window } = dom;
  const email = await poll(() => window.document.querySelector('input[type="email"]'));
  check("login page renders the sign-in form", Boolean(email));
  if (email) {
    const password = window.document.querySelector('input[type="password"]');
    setInput(window, email, "admin@nosih.test");
    setInput(window, password, "wrong-password");
    const form = email.closest("form");
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    const alert = await poll(() => {
      const el = window.document.querySelector(".alert-error");
      return el && el.textContent.trim() ? el.textContent.trim() : null;
    });
    check(
      "login failure renders readable error (no React #31 blank tree)",
      Boolean(alert && alert.includes("A server error has occurred")),
      `rendered: ${JSON.stringify(alert)}`
    );
    check("root still has a rendered tree after failure", window.document.getElementById("root").children.length > 0);
    results.push(alert);
  }
  window.close();
}

// ── Scenario 2: public verify with ?certificateId renders readable failure ──
{
  const dom = boot("/verify?certificateId=CERT-8A91F203");
  const { window } = dom;
  const body = await poll(() => {
    const root = window.document.getElementById("root");
    const text = root ? root.textContent : "";
    // Wait until the auto-verify request has resolved into visible output.
    return /error|unavailable|failed|could not|try again/i.test(text) && text.length > 80 ? text : null;
  });
  check(
    "public verify renders a readable failure state",
    Boolean(body),
    body ? "" : `root text: ${JSON.stringify((window.document.getElementById("root")?.textContent || "").slice(0, 200))}`
  );
  window.close();
}

// ── Scenario 3: protected route with failing /auth/me lands on /login ──
{
  const dom = boot("/");
  const { window } = dom;
  // Give ProtectedRoute a token so it actually calls /auth/me (which 500s).
  window.sessionStorage.setItem("token", "stale-token");
  window.sessionStorage.setItem("user", JSON.stringify({ id: "u1", role: "issuer" }));
  // Re-bootstrapping is not needed: navigate via history is SPA-internal, so
  // instead evaluate the redirect outcome by waiting for the login form.
  const loginInput = await poll(() => window.document.querySelector('input[type="email"]'), 10000);
  check(
    "protected route redirects to /login when session validation fails",
    Boolean(loginInput) && window.location.pathname === "/login",
    `pathname: ${window.location.pathname}`
  );
  window.close();
}

console.log(`\n${passed}/${passed + failed} rendered-UI checks passed`);
if (failed > 0) {
  console.log("P8 rendered-UI proof: FAIL");
  process.exit(1);
}
console.log("P8 rendered-UI proof: PASS");
process.exit(0);