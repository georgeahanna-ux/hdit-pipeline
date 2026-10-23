"use strict";
/**
 * Key Vault access.
 * Secrets we keep here (all editable in the Azure portal without redeploying):
 *   - autotask-api-integration-code   (the API tracking identifier)
 *   - autotask-api-username           (the API-only user "key")
 *   - autotask-api-secret             (the API-only user "secret")
 *   - autotask-base-url               (e.g. https://webservicesNN.autotask.net/atservicesrest)
 *   - admin-emails                    (comma-separated list of admin emails)
 *
 * Values are cached in-process for 5 minutes so we are not hammering Key Vault
 * on every request while still picking up edits made in the portal.
 */
const { SecretClient } = require("@azure/keyvault-secrets");
const { DefaultAzureCredential } = require("@azure/identity");

const client = new SecretClient(process.env.KEY_VAULT_URI, new DefaultAzureCredential());

const cache = new Map(); // name -> { value, expires }
const TTL = 5 * 60 * 1000;

async function getSecret(name, { fresh = false } = {}) {
  const hit = cache.get(name);
  if (!fresh && hit && hit.expires > Date.now()) return hit.value;
  const s = await client.getSecret(name);
  cache.set(name, { value: s.value, expires: Date.now() + TTL });
  return s.value;
}

async function setSecret(name, value) {
  await client.setSecret(name, value);
  cache.set(name, { value, expires: Date.now() + TTL });
}

async function getAutotaskCreds() {
  const [integrationCode, username, secret, baseUrl] = await Promise.all([
    getSecret("autotask-api-integration-code"),
    getSecret("autotask-api-username"),
    getSecret("autotask-api-secret"),
    getSecret("autotask-base-url"),
  ]);
  return { integrationCode, username, secret, baseUrl };
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
  getAppPassword, getAdminResourceIds,
};
