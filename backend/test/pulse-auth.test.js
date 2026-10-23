"use strict";
// Tests for the HD IT Pulse (Entra ID) sign-in check. Shared, identical in every app.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const TENANT = "0b1e12e5-f6cd-4ae7-a9ff-4562637a0c44";
const CLIENT = "11111111-2222-3333-4444-555555555555";
process.env.ENTRA_TENANT_ID = TENANT;
process.env.ENTRA_CLIENT_ID = CLIENT;
process.env.ENTRA_ROLE_PREFIX = "Whitespace";
process.env.PULSE_APP_NAME = "Whitespace Matrix";

const pulse = require("../src/lib/pulse-auth");
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
pulse._test.setKeys(new Map([["k1", publicKey]]));

const links = new Map();
pulse._test.setStore({
  async get(oid) { return links.get(oid) || null; },
  async list() { return [...links].map(([oid, v]) => ({ oid, resourceId: v.resourceId })); },
  async save(oid, d) { links.set(oid, { resourceId: d.resourceId, name: d.name }); },
});
pulse._test.setResourceSource(async () => [
  { id: 101, firstName: "George", lastName: "Hanna", email: "George.Hanna@hdit.com.au" },
  { id: 102, firstName: "Taylor", lastName: "Reid", email: "taylor@hdit.com.au" },
  { id: 103, firstName: "Alex", lastName: "Doran", email: "" },
]);

function token(claims = {}, { key = privateKey, kid = "k1", expiresIn = "1h" } = {}) {
  return jwt.sign({
    aud: CLIENT, iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, tid: TENANT,
    oid: "oid-george", scp: "access_as_user", name: "George Hanna",
    preferred_username: "george.hanna@hdit.com.au", roles: ["Whitespace.User"], ...claims,
  }, key, { algorithm: "RS256", keyid: kid, expiresIn });
}
const rejects = (p, status) => assert.rejects(p, e => e.status === status);

test("recognises Entra tokens and leaves the app's own sessions alone", () => {
  assert.equal(pulse.looksLikeEntra(token()), true);
  assert.equal(pulse.looksLikeEntra(jwt.sign({ rid: 1 }, "secret")), false);
  assert.equal(pulse.looksLikeEntra("not a token"), false);
});

test("a valid token signs in and matches the Autotask resource by email (case-insensitive)", async () => {
  pulse._test.reset();
  const id = await pulse.authenticateEntra(token());
  assert.equal(id.via, "entra");
  assert.equal(id.resourceId, 101);
  assert.equal(id.name, "George Hanna");
  assert.equal(id.role, "user");
  assert.equal(id.editor, false);
  assert.equal(id.needsLink, false);
  assert.equal(id.linkSource, "email");
});

test("roles: Editor edits, app Admin and Pulse.Admin are administrators", async () => {
  pulse._test.reset();
  assert.equal((await pulse.authenticateEntra(token({ roles: ["Whitespace.Editor"] }))).editor, true);
  assert.equal((await pulse.authenticateEntra(token({ roles: ["Whitespace.Admin"] }))).role, "administrator");
  const p = await pulse.authenticateEntra(token({ roles: ["Pulse.Admin"] }));
  assert.equal(p.role, "administrator"); assert.equal(p.platformAdmin, true);
});

test("no role for this app is refused with 403, even with another app's role", async () => {
  await rejects(pulse.authenticateEntra(token({ roles: ["MarketingROI.Admin"] })), 403);
  await rejects(pulse.authenticateEntra(token({ roles: [] })), 403);
  await rejects(pulse.authenticateEntra(token({ roles: undefined })), 403);
});

test("rejects forged, foreign, expired and app-only tokens", async () => {
  await rejects(pulse.verifyToken(token({}, { key: other.privateKey })), 401);                 // wrong signature
  await rejects(pulse.verifyToken(token({ aud: "api://someone-else" })), 401);                  // wrong audience
  await rejects(pulse.verifyToken(token({ iss: "https://login.microsoftonline.com/evil/v2.0" })), 401);
  await rejects(pulse.verifyToken(token({ tid: "another-tenant" })), 401);
  await rejects(pulse.verifyToken(token({}, { expiresIn: -600 })), 401);                        // expired
  await rejects(pulse.verifyToken(token({ scp: undefined })), 401);                             // app-only token
  // alg confusion: HS256 signed with the public key must not pass
  const pem = publicKey.export({ type: "spki", format: "pem" });
  const hs = jwt.sign({ aud: CLIENT, iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, tid: TENANT, oid: "x", scp: "access_as_user", roles: ["Pulse.Admin"] }, pem, { algorithm: "HS256", keyid: "k1" });
  await rejects(pulse.verifyToken(hs), 401);
});

test("someone without an email match links once, then is remembered", async () => {
  pulse._test.reset();
  const t = token({ oid: "oid-test", preferred_username: "tester@hdittestingtenancy.onmicrosoft.com", name: "Test User" });
  const before = await pulse.authenticateEntra(t);
  assert.equal(before.needsLink, true);
  assert.equal(before.resourceId, null);

  const list = (await pulse.linkResources(before)).jsonBody.resources.map(r => r.id);
  assert.deepEqual(list.sort(), [101, 102, 103]);
  await assert.rejects(pulse.link(before, null, { resourceId: 999 }), e => e.status === 400);
  assert.equal((await pulse.link(before, null, { resourceId: 103 })).jsonBody.name, "Alex Doran");

  const after = await pulse.authenticateEntra(t);
  assert.equal(after.resourceId, 103);
  assert.equal(after.linkSource, "link");

  // nobody else can take that resource, and it drops out of their list
  const someone = await pulse.authenticateEntra(token({ oid: "oid-2", preferred_username: "x@hdittestingtenancy.onmicrosoft.com" }));
  assert.ok(!(await pulse.linkResources(someone)).jsonBody.resources.some(r => r.id === 103));
  await assert.rejects(pulse.link(someone, null, { resourceId: 103 }), e => e.status === 409);
});

test("people matched by email can't re-link to someone else", async () => {
  pulse._test.reset();
  const id = await pulse.authenticateEntra(token());
  await assert.rejects(pulse.link(id, null, { resourceId: 102 }), e => e.status === 409);
});

test("Entra sign-in stays off until tenant, client and prefix are all set", () => {
  const keep = process.env.ENTRA_CLIENT_ID;
  process.env.ENTRA_CLIENT_ID = "";
  assert.equal(pulse.enabled(), false);
  process.env.ENTRA_CLIENT_ID = keep;
  assert.equal(pulse.enabled(), true);
  assert.equal(pulse.legacyEnabled(), true);
  process.env.LEGACY_PASSWORD_LOGIN = "off";
  assert.equal(pulse.legacyEnabled(), false);
  delete process.env.LEGACY_PASSWORD_LOGIN;
});
