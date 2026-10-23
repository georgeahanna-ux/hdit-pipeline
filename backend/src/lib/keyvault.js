"use strict";
/**
 * Key Vault access.
 * Secrets we keep here (all editable in the Azure portal without redeploying):
 *   - autotask-api-integration-code   (the API tracking identifier)
 *   - autotask-api-username           (the API-only user "key")
 *   - autotask-api-secret             (the API-only user "secret")
 *   - autotask-base-url               (e.g. https://webservicesNN.autotask.net/atservicesrest)
 *   - app-password                    (team password, while LEGACY_PASSWORD_LOGIN is on)
 *   - admin-resource-ids              (Autotask resource ids that are administrators, team-password sign-in)
 *   - app-totp-secret                 (optional shared authenticator seed, team-password sign-in)
 *
 * Values are cached in-process for 5 minutes so we are not hammering Key Vault
 * on every request while still picking up edits made in the portal.
 */
const { SecretClient } = require("@azure/keyvault-secrets");
const { credential } = require("./credential");

let _client = null;
function client() {
  if (!_client) {
    if (!process.env.KEY_VAULT_URI) { const e = new Error("KEY_VAULT_URI is not configured"); e.status = 500; throw e; }
    _client = new SecretClient(process.env.KEY_VAULT_URI, credential);
  }
  return _client;
}

const cache = new Map(); // name -> { value, expires }
const TTL = 5 * 60 * 1000, MISS_TTL = 30 * 1000;

/** A secret's value, or null when it doesn't exist. */
async function getSecret(name, { fresh = false } = {}) {
  const hit = cache.get(name);
  if (!fresh && hit && hit.expires > Date.now()) return hit.value;
  try {
    const s = await client().getSecret(name);
    cache.set(name, { value: s.value, expires: Date.now() + TTL });
    return s.value;
  } catch (e) {
    if (e.statusCode === 404 || e.code === "SecretNotFound") {
      cache.set(name, { value: null, expires: Date.now() + MISS_TTL });
      return null;
    }
    throw e;
  }
}

async function setSecret(name, value) {
  await client().setSecret(name, value);
  cache.set(name, { value, expires: Date.now() + TTL });
}

async function getAutotaskCreds() {
  const [integrationCode, username, secret, baseUrl] = await Promise.all([
    getSecret("autotask-api-integration-code"),
    getSecret("autotask-api-username"),
    getSecret("autotask-api-secret"),
    getSecret("autotask-base-url"),
  ]);
  if (!integrationCode || !username || !secret || !baseUrl) {
    const e = new Error("The Autotask connection isn't set up yet. An administrator needs to add the Autotask secrets to Key Vault (see docs/AZURE-SETUP.md)."); e.status = 503; throw e;
  }
  return { integrationCode, username, secret, baseUrl };
}

/** Which secrets exist (true/false), for /health. Never returns values. */
async function secretsStatus() {
  const names = ["app-password", "admin-resource-ids", "autotask-api-username", "autotask-api-secret", "autotask-api-integration-code", "autotask-base-url"];
  const out = {};
  await Promise.all(names.map(async n => { out[n] = !!(await getSecret(n, { fresh: true })); }));
  return out;
}

async function getAdminEmails({ fresh = false } = {}) {
  const raw = await getSecret("admin-emails", { fresh }).catch(() => "");
  return (raw || "").split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
}

/** The shared team password used to unlock the app. */
async function getAppPassword({ fresh = false } = {}) {
  return (await getSecret("app-password", { fresh }).catch(() => "")) || "";
}

/** Autotask resource ids granted the administrator role (comma-separated secret). */
async function getAdminResourceIds({ fresh = false } = {}) {
  const raw = await getSecret("admin-resource-ids", { fresh }).catch(() => "");
  return (raw || "").split(",").map(s => s.trim()).filter(Boolean);
}

module.exports = {
  getSecret, setSecret, getAutotaskCreds, getAdminEmails,
  getAppPassword, getAdminResourceIds, secretsStatus,
};
