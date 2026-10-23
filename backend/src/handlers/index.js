"use strict";
/**
 * Route handlers. Each is a small, independent function. index.js maps
 * method+path to one of these. Two of them (loginResources, login) are PUBLIC
 * (pre-auth) — they take only the request body. The rest receive the verified
 * identity { resourceId, name, role } as their first argument.
 */
const at = require("../lib/autotask");
const { setSecret, getAdminResourceIds } = require("../lib/keyvault");
const { requireAdmin, checkPassword, issueSession, checkOtp, otpRequired } = require("../lib/auth");

const json = (status, body) => ({ status, jsonBody: body });

/* ---------------- public (pre-auth) ---------------- */

/** POST /resources  { password }  → active Autotask resources for the picker, + otpRequired flag */
async function loginResources(body) {
  if (!(await checkPassword(body && body.password))) return json(401, { message: "Incorrect password" });
  return json(200, { resources: await at.getResources(), otpRequired: await otpRequired() });
}

/** POST /login  { password, resourceId, name, otp }  → session token */
async function login(body) {
  if (!(await checkPassword(body && body.password))) return json(401, { message: "Incorrect password" });
  if (!(await checkOtp(body && body.otp))) return json(401, { message: "Invalid authenticator code" });
  const rid = Number(body && body.resourceId);
  if (!rid) return json(400, { message: "Please choose your name from the list" });
  const { token, role } = await issueSession({ resourceId: rid, name: body.name });
  return json(200, { token, name: body.name, role, resourceId: rid });
}

/* ---------------- authenticated ---------------- */

/** GET /me */
async function me(identity) {
  return json(200, { name: identity.name, role: identity.role, resourceId: identity.resourceId });
}

/** GET /stages */
async function stages() { return json(200, await at.getStages()); }

/** GET /opportunities */
async function opportunities() { return json(200, await at.getOpportunities()); }

/** GET /opportunities/:id/activities */
async function activities(identity, id) { return json(200, await at.getActivities(id)); }

/** POST /opportunities/:id/activities  { text, companyId? } */
async function addActivity(identity, id, body) {
  const text = ((body && body.text) || "").trim();
  if (!text) return json(400, { message: "Note text is required" });
  let companyId = body && body.companyId;
  if (!companyId) companyId = await at.getOppCompanyId(id);
  if (!companyId) return json(400, { message: "Could not determine the company for this opportunity" });
  const created = await at.addActivity(id, companyId, text, identity.name, identity.resourceId);
  return json(201, { id: created && created.itemId, text, author: identity.name, at: new Date().toISOString() });
}

/** PATCH /opportunities/:id/stage  { stageId } */
async function moveStage(identity, id, body) {
  await at.updateStage(id, body.stageId);
  return json(200, { ok: true });
}

/** PATCH /opportunities/:id  { title?, description?, closeDate? } */
async function patchOpp(identity, id, body) {
  await at.patchOpportunity(id, body);
  return json(200, { ok: true });
}

/** GET /opportunities/:id/company-tickets — tickets for this opp's company (for the associate picker) */
async function companyTickets(identity, id) {
  return json(200, await at.getCompanyTickets(id));
}

/** POST /opportunities/:id/tickets  { ticketId } — associate an existing ticket with this opportunity */
async function associateTicket(identity, id, body) {
  const ticketId = body && body.ticketId;
  if (!ticketId) return json(400, { message: "Pick a ticket to associate" });
  const ticket = await at.associateTicket(id, ticketId);
  return json(200, { ok: true, ticket });
}

/** GET /admins   (admin) — returns the admin resource-id list */
async function listAdmins(identity) {
  requireAdmin(identity);
  return json(200, await getAdminResourceIds({ fresh: true }));
}

/** PUT /admins  { admins:[resourceId,...] }   (admin) */
async function saveAdmins(identity, _id, body) {
  requireAdmin(identity);
  const list = (body.admins || []).map(x => String(x).trim()).filter(Boolean);
  await setSecret("admin-resource-ids", list.join(","));
  return json(200, { ok: true });
}

/** PUT /settings  { baseUrl?, apiKey? }   (admin) */
async function saveSettings(identity, _id, body) {
  requireAdmin(identity);
  if (body.baseUrl) await setSecret("autotask-base-url", body.baseUrl);
  if (body.apiKey) await setSecret("autotask-api-integration-code", body.apiKey);
  return json(200, { ok: true });
}

module.exports = {
  loginResources, login,
  me, stages, opportunities, activities, addActivity,
  moveStage, patchOpp, companyTickets, associateTicket, listAdmins, saveAdmins, saveSettings,
};
