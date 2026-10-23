"use strict";
/**
 * HD IT Pulse sign-in (Microsoft Entra ID). Shared by every app that runs inside Pulse.
 * Keep this file identical in each app (Pipeline, Marketing ROI, Whitespace Matrix).
 *
 * How it works
 *   Pulse signs people in with Entra ID and hands the app an access token for the "HD IT Pulse"
 *   app registration. Every request is checked here:
 *     - signature against Entra's published signing keys, issuer = our tenant,
 *       audience = Pulse, delegated scope "access_as_user", not expired;
 *     - app roles in the token decide access: <Prefix>.User, <Prefix>.Editor, <Prefix>.Admin,
 *       or Pulse.Admin (administrator in every app).
 *   The person is then matched to their Autotask resource, for attributing changes:
 *     1. a link they saved earlier (table "settings", partition "pulse-link", row = Entra object id);
 *     2. otherwise their Microsoft 365 email against active Autotask resources' email.
 *   If neither matches, the app asks them to pick their name once (GET /link/resources, POST /link).
 *
 * Function App settings
 *   ENTRA_TENANT_ID     tenant that issues the tokens
 *   ENTRA_CLIENT_ID     application (client) id of the HD IT Pulse app registration
 *   ENTRA_ROLE_PREFIX   this app's role prefix: Pipeline, MarketingROI or Whitespace
 *   PULSE_APP_NAME      friendly name for messages, e.g. "Whitespace Matrix"
 *   LEGACY_PASSWORD_LOGIN  "on" (default) keeps the team password working alongside Pulse; "off" turns it off
 * Entra sign-in is off until the first three are set, so the app keeps working as before.
 */
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const cfg = () => ({
  tenantId: String(process.env.ENTRA_TENANT_ID || "").trim().toLowerCase(),
  clientId: String(process.env.ENTRA_CLIENT_ID || "").trim().toLowerCase(),
  prefix: String(process.env.ENTRA_ROLE_PREFIX || "").trim(),
  appName: String(process.env.PULSE_APP_NAME || "this app"),
});
const enabled = () => { const c = cfg(); return !!(c.tenantId && c.clientId && c.prefix); };
const legacyEnabled = () => !/^(off|false|0|no)$/i.test(String(process.env.LEGACY_PASSWORD_LOGIN || "on").trim());

/** An error whose message and code are safe to show the person. */
function fail(status, message, code) {
  const e = new Error(message); e.status = status; e.expose = true; if (code) e.code = code; return e;
}
const json = (status, body) => ({ status, jsonBody: body });

function decodePart(token, i) {
  return JSON.parse(Buffer.from(String(token).split(".")[i] || "", "base64url").toString("utf8"));
}
/** Cheap check: a Microsoft-issued token (RS256 with a key id) rather than the app's own HS256 session. */
function looksLikeEntra(token) {
  try { const h = decodePart(token, 0); return h.alg === "RS256" && typeof h.kid === "string" && h.kid.length > 0; }
  catch { return false; }
}

/* ------------------------------ signing keys ------------------------------ */
let keys = new Map(), keysAt = 0, keysFetching = null;
const KEYS_TTL = 12 * 3600e3;          // refresh the key list twice a day
const KEYS_MIN_REFRESH = 5 * 60e3;     // an unknown key id refetches at most every 5 minutes

async function fetchKeys() {
  const url = `https://login.microsoftonline.com/${encodeURIComponent(cfg().tenantId)}/discovery/v2.0/keys`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw fail(503, "Couldn't reach Microsoft to check your sign-in. Try again in a minute.");
  const body = await res.json();
  const next = new Map();
  for (const k of body.keys || []) {
    if (k.kty !== "RSA" || !k.kid || (k.use && k.use !== "sig")) continue;
    try { next.set(k.kid, crypto.createPublicKey({ key: { kty: "RSA", n: k.n, e: k.e }, format: "jwk" })); } catch { /* skip a bad key */ }
  }
  keys = next; keysAt = Date.now();
}
async function keyFor(kid) {
  const age = Date.now() - keysAt;
  if (age > KEYS_TTL || (!keys.has(kid) && age > KEYS_MIN_REFRESH)) {
    try {
      keysFetching = keysFetching || fetchKeys().finally(() => { keysFetching = null; });
      await keysFetching;
    } catch (e) { if (!keys.size) throw e; /* keep using the keys we have */ }
  }
  return keys.get(kid) || null;
}

/** Verifies an Entra access token for Pulse. Returns its claims or throws 401. */
async function verifyToken(token) {
  const c = cfg();
  let header;
  try { header = decodePart(token, 0); } catch { throw fail(401, "Your sign-in couldn't be read. Reload Pulse and try again."); }
  const key = await keyFor(header.kid);
  if (!key) throw fail(401, "Your sign-in couldn't be verified. Reload Pulse and try again.");
  let claims;
  try {
    claims = jwt.verify(token, key, {
      algorithms: ["RS256"],
      audience: [c.clientId, `api://${c.clientId}`],
      issuer: [`https://login.microsoftonline.com/${c.tenantId}/v2.0`, `https://sts.windows.net/${c.tenantId}/`],
      clockTolerance: 120,
    });
  } catch (e) {
    throw fail(401, e && e.name === "TokenExpiredError"
      ? "Your sign-in has expired. Reload Pulse to continue."
      : "Your sign-in couldn't be verified. Reload Pulse and try again.");
  }
  if (String(claims.tid || "").toLowerCase() !== c.tenantId) throw fail(401, "That sign-in is from a different organisation.");
  const scopes = String(claims.scp || "").split(" ");
  if (!scopes.includes("access_as_user")) throw fail(401, "That sign-in isn't for a person using Pulse.");
  if (!claims.oid) throw fail(401, "That sign-in doesn't identify a person.");
  return claims;
}

/** What the token's app roles allow in this app. */
function accessFor(claims, prefix = cfg().prefix) {
  const roles = Array.isArray(claims.roles) ? claims.roles.map(String) : [];
  const platform = roles.includes("Pulse.Admin");
  const admin = platform || roles.includes(`${prefix}.Admin`);
  const editor = admin || roles.includes(`${prefix}.Editor`);
  const user = editor || roles.includes(`${prefix}.User`);
  return { roles, platform, admin, editor, user };
}

/* --------------------------- Autotask resource link --------------------------- */
const LINK_PK = "pulse-link";
let _links = null;
function linksTable() {
  if (!_links) {
    const { TableClient } = require("@azure/data-tables");
    const { credential } = require("./credential");
    const ep = String(process.env.TABLES_ENDPOINT || "").replace(/\/+$/, "");
    if (!ep) throw fail(500, "TABLES_ENDPOINT is not configured");
    _links = new TableClient(ep, "settings", credential);
  }
  return _links;
}
const store = {
  async get(oid) {
    try { const e = await linksTable().getEntity(LINK_PK, oid); return { resourceId: Number(e.resourceId), name: e.name || "" }; }
    catch (e) { if (e.statusCode === 404) return null; throw e; }
  },
  async list() {
    const out = [];
    for await (const e of linksTable().listEntities({ queryOptions: { filter: `PartitionKey eq '${LINK_PK}'` } })) out.push({ oid: e.rowKey, resourceId: Number(e.resourceId) });
    return out;
  },
  async save(oid, data) { await linksTable().upsertEntity({ partitionKey: LINK_PK, rowKey: oid, ...data }, "Replace"); },
};

const personName = r => (`${r.firstName || ""} ${r.lastName || ""}`).trim() || r.email || ("#" + r.id);
let resourceSource = async () => {
  const at = require("./autotask");
  return at.query("Resources", [{ op: "eq", field: "isActive", value: true }], { fields: ["id", "firstName", "lastName", "email"] });
};
let _byEmail = null, _byEmailExp = 0, _active = null;
async function activeResources() {
  if (_byEmail && _byEmailExp > Date.now()) return { byEmail: _byEmail, active: _active };
  const items = await resourceSource();
  _active = items.map(r => ({ id: Number(r.id), name: personName(r) })).sort((a, b) => a.name.localeCompare(b.name));
  _byEmail = new Map();
  for (const r of items) if (r.email) _byEmail.set(String(r.email).trim().toLowerCase(), { resourceId: Number(r.id), name: personName(r) });
  _byEmailExp = Date.now() + 10 * 60e3;
  return { byEmail: _byEmail, active: _active };
}

const emailsOf = claims => [claims.preferred_username, claims.email, claims.upn, claims.unique_name]
  .filter(Boolean).map(x => String(x).trim().toLowerCase());

const resolved = new Map();   // oid -> { value, exp }
async function resolveResource(claims) {
  const hit = resolved.get(claims.oid);
  if (hit && hit.exp > Date.now()) return hit.value;
  let value = null;
  const saved = await store.get(claims.oid);
  if (saved && saved.resourceId) value = { ...saved, source: "link" };
  if (!value) {
    try {
      const { byEmail } = await activeResources();
      for (const em of emailsOf(claims)) { const r = byEmail.get(em); if (r) { value = { ...r, source: "email" }; break; } }
    } catch (e) { if (e.status === 503) throw e; /* Autotask unreachable: fall through to linking */ }
  }
  resolved.set(claims.oid, { value, exp: Date.now() + (value ? 5 * 60e3 : 30e3) });
  return value;
}

/** Identity for a verified Pulse token, in the same shape the app's handlers already use. */
async function authenticateEntra(token) {
  const c = cfg();
  const claims = await verifyToken(token);
  const a = accessFor(claims, c.prefix);
  if (!a.user) throw fail(403, `You don't have access to ${c.appName}. Ask a Pulse administrator to add you to its group in Entra ID.`, "no-access");
  const who = await resolveResource(claims);
  const email = emailsOf(claims)[0] || "";
  return {
    via: "entra", oid: claims.oid, email,
    name: who ? who.name : (claims.name || email || "Signed-in user"),
    resourceId: who ? who.resourceId : null,
    role: a.admin ? "administrator" : "user",
    editor: a.editor, platformAdmin: a.platform, roles: a.roles,
    needsLink: !who, linkSource: who ? who.source : null,
  };
}

/* ------------------------------ link endpoints ------------------------------ */
function requireEntra(identity) {
  if (!identity || identity.via !== "entra") throw fail(400, "Linking is only for people signed in through HD IT Pulse.");
}
const canLink = identity => identity.needsLink || identity.linkSource === "link";

/** GET /link/resources — active Autotask resources nobody else has linked to. */
async function linkResources(identity) {
  requireEntra(identity);
  if (!canLink(identity)) throw fail(409, `You're already matched to ${identity.name} in Autotask by your email address.`);
  const [{ active }, links] = await Promise.all([activeResources(), store.list()]);
  const taken = new Set(links.filter(l => l.oid !== identity.oid).map(l => l.resourceId));
  return json(200, { email: identity.email, resources: active.filter(r => !taken.has(r.id)) });
}

/** POST /link { resourceId } — saves which Autotask resource this person is. */
async function link(identity, _id, body) {
  requireEntra(identity);
  if (!canLink(identity)) throw fail(409, `You're already matched to ${identity.name} in Autotask by your email address.`);
  const rid = Number(body && body.resourceId);
  const [{ active }, links] = await Promise.all([activeResources(), store.list()]);
  const r = active.find(x => x.id === rid);
  if (!r) throw fail(400, "Choose your name from the list.");
  if (links.some(l => l.oid !== identity.oid && l.resourceId === rid)) throw fail(409, `${r.name} is already linked to someone else. Ask a Pulse administrator if that's wrong.`);
  await store.save(identity.oid, { resourceId: rid, name: r.name, email: identity.email, linkedAt: new Date().toISOString() });
  resolved.delete(identity.oid);
  return json(200, { resourceId: rid, name: r.name });
}

/** Health summary (no secrets). */
const status = () => ({ entra: enabled(), legacyPasswordLogin: legacyEnabled() });

module.exports = {
  enabled, legacyEnabled, looksLikeEntra, verifyToken, accessFor, authenticateEntra,
  linkResources, link, status, fail,
  // test hooks
  _test: {
    setKeys(map) { keys = map; keysAt = Date.now(); },
    setResourceSource(fn) { resourceSource = fn; _byEmail = null; },
    setStore(s) { Object.assign(store, s); },
    reset() { resolved.clear(); _byEmail = null; },
  },
};
