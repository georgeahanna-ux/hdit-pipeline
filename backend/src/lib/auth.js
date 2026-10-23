"use strict";
/**
 * App-level authentication — Autotask-native model (no Microsoft/Entra).
 *
 * Flow:
 *   1. The user enters a single shared team password (Key Vault: app-password).
 *   2. They pick their name from the live Autotask resource list.
 *   3. We issue a signed session token (HS256). The chosen resource id rides in
 *      the token and drives ImpersonationResourceId, so notes and stage changes
 *      are still attributed to the right salesperson.
 *
 * The signing key is derived from the shared password, so no extra secret is
 * needed and rotating the password invalidates outstanding sessions.
 *
 * HD IT Pulse: inside Pulse, requests carry an Entra ID access token instead, checked by
 * pulse-auth.js (roles Pipeline.User / Pipeline.Admin / Pulse.Admin). The team password keeps
 * working alongside it until LEGACY_PASSWORD_LOGIN is set to "off".
 *
 * Role model: "administrator" if the resource id is listed in the Key Vault
 * admin-resource-ids secret, otherwise "user".
 */
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { authenticator } = require("otplib");
const { getAppPassword, getAdminResourceIds, getSecret } = require("./keyvault");
const pulse = require("./pulse-auth");

// Allow ±1 time-step (±30s) so a slightly fast/slow clock or a code typed right on the
// boundary still validates.
authenticator.options = { window: 1 };

const SESSION_TTL = "12h";

async function sessionKey() {
  const pw = await getAppPassword();
  if (!pw) { const e = new Error("The team password hasn't been set yet. An administrator needs to add it to Key Vault (see docs/AZURE-SETUP.md)."); e.status = 503; throw e; }
  return crypto.createHash("sha256").update(String(pw) + "|" + (process.env.APP_SESSION_SALT || "pipeline-session-v1")).digest("hex");
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** True if the supplied password matches the shared app password. */
async function checkPassword(pw) {
  if (!pulse.legacyEnabled()) throw pulse.fail(403, "Pipeline now signs in through HD IT Pulse.", "pulse-only");
  const real = await getAppPassword();
  if (!real) { const e = new Error("The team password hasn't been set yet. An administrator needs to add it to Key Vault (see docs/AZURE-SETUP.md)."); e.status = 503; throw e; }
  return safeEqual(pw == null ? "" : pw, real);
}

/**
 * Shared team second factor (TOTP, RFC 6238). The secret seed lives in Key Vault as
 * `app-totp-secret` (and in LastPass, which generates the rolling code). OTP is OPT-IN:
 * if the secret is absent, OTP is not enforced — so the app never hard-locks if it's
 * misconfigured. Add the secret to turn it on; remove it to turn it off. No redeploy needed.
 */
async function getOtpSecret() {
  try { return (await getSecret("app-totp-secret")) || ""; }
  catch { return ""; }   // secret not present -> OTP disabled
}

/** True if a shared OTP secret is configured (i.e. OTP is required to sign in). */
async function otpRequired() {
  return !!(await getOtpSecret());
}

/** Validates the 6-digit authenticator code. Returns true when OTP is not configured. */
async function checkOtp(code) {
  const secret = await getOtpSecret();
  if (!secret) return true;                              // OTP disabled
  const clean = String(code == null ? "" : code).replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  try { return authenticator.check(clean, secret); }
  catch { return false; }
}

/** Issues a signed session for a chosen Autotask resource. */
async function issueSession({ resourceId, name }) {
  const admins = await getAdminResourceIds();
  const role = admins.includes(String(resourceId)) ? "administrator" : "user";
  const token = jwt.sign(
    { rid: Number(resourceId), name: name || ("Resource " + resourceId), role },
    await sessionKey(), { expiresIn: SESSION_TTL });
  return { token, role };
}

/** Verifies the bearer session token. Returns { resourceId, name, role } or throws 401. */
async function authenticate(request) {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) { const e = new Error("Missing session token"); e.status = 401; throw e; }
  if (pulse.enabled() && pulse.looksLikeEntra(token)) return pulse.authenticateEntra(token);
  if (!pulse.legacyEnabled()) throw pulse.fail(401, "Sign in through HD IT Pulse.", "pulse-only");
  let claims;
  try { claims = jwt.verify(token, await sessionKey()); }
  catch { const e = new Error("Your session has expired. Please sign in again."); e.status = 401; throw e; }
  return { via: "password", resourceId: claims.rid, name: claims.name, role: claims.role };
}

function requireAdmin(identity) {
  if (identity.role !== "administrator") {
    const e = new Error("Administrator role required"); e.status = 403; throw e;
  }
}

module.exports = { authenticate, requireAdmin, checkPassword, issueSession, checkOtp, otpRequired };
