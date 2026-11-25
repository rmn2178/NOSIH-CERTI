#!/usr/bin/env node
/**
 * NOSIH first-institution onboarding (idempotent, database-only).
 *
 * Creates the first institution through the public apply endpoint and
 * approves it as the platform admin, so `npm run issuer:add -- --yes` has an
 * APPROVED institution to bind the MetaMask issuer wallet to. Re-running
 * finds the existing institution by registration number and only approves
 * it if still pending. No chain writes, no secrets in this file — admin
 * credentials come from the gitignored root .env (ADMIN_EMAIL/ADMIN_PASSWORD).
 *
 *   npm run setup:institution
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "backend", "package.json"));
require("dotenv").config({ path: path.join(root, ".env") });

const BASE = process.env.BACKEND_PUBLIC_URL || "http://localhost:5000";
const INSTITUTION = {
  name: "Meridian Institute of Technology",
  legalName: "Meridian Institute of Technology",
  registrationNumber: "MER-IT-2026-001",
  address: "Chennai, Tamil Nadu / India",
  adminEmail: "registrar@meridian-example.com",
  adminPassword: "Meridian@2026",
};

async function api(method, p, { token, body } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, data };
}

const login = await api("POST", "/api/auth/login", {
  body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD },
});
if (login.status !== 200) {
  console.error(`platform admin login failed (${login.status}): ${JSON.stringify(login.data)}`);
  console.error("Run npm --prefix backend run seed:admin first.");
  process.exit(1);
}
const token = login.data.token;

const list = await api("GET", "/api/institutions", { token });
if (list.status !== 200) {
  console.error(`institution list failed (${list.status}): ${JSON.stringify(list.data)}`);
  process.exit(1);
}
const rows = list.data.institutions ?? list.data ?? [];
let inst = rows.find((i) => i.registrationNumber === INSTITUTION.registrationNumber);

if (!inst) {
  const applied = await api("POST", "/api/institutions/apply", { body: INSTITUTION });
  if (applied.status !== 201) {
    console.error(`apply failed (${applied.status}): ${JSON.stringify(applied.data)}`);
    process.exit(1);
  }
  inst = applied.data.institution;
  console.log(`created institution ${inst.institutionId} (${inst.name}) — pending`);
} else {
  console.log(`institution ${inst.institutionId} already exists — ${inst.verificationStatus}`);
}

if (inst.verificationStatus !== "approved") {
  const approved = await api("PATCH", `/api/institutions/${inst.id}/status`, {
    token,
    body: { status: "approved", reason: "initial institution onboarding" },
  });
  if (approved.status !== 200) {
    console.error(`approve failed (${approved.status}): ${JSON.stringify(approved.data)}`);
    process.exit(1);
  }
  inst = approved.data.institution;
}

console.log(`\n✅ institution ready: ${inst.institutionId} — ${inst.verificationStatus}`);
console.log(`   institution admin login: ${INSTITUTION.adminEmail} / ${INSTITUTION.adminPassword}`);
console.log(`\nNext (LIVE chain write, run in your terminal):`);
console.log(`   npm run issuer:add -- --yes ${process.env.ISSUER_ADDRESS} ${inst.institutionId}\n`);