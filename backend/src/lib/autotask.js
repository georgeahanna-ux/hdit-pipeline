"use strict";
/**
 * Thin Autotask REST API client.
 *
 * Authentication uses the three documented headers on a single API-only user:
 *     ApiIntegrationCode, UserName, Secret
 *
 * Per-user attribution: Autotask has no per-user OAuth and your tenant uses
 * Entra ID SSO, so individual salespeople cannot present Autotask API
 * credentials. Instead we authenticate them with Entra ID, map their email to
 * their Autotask Resource, and send the `ImpersonationResourceId` header so any
 * create operation (e.g. an activity note) is recorded as that salesperson.
 * The API-only user's security level must allow impersonation of the entity.
 *
 * Reference entities used:
 *   - Opportunities            (cards)
 *   - OpportunityCategoryList / picklist on Opportunities.stage  (column names)
 *   - CompanyNotes             (activity log; note OpportunityID + actionType)
 *   - Resources                (email -> resource id mapping)
 */
const { getAutotaskCreds } = require("./keyvault");

async function authHeaders(impersonateResourceId) {
  const { integrationCode, username, secret } = await getAutotaskCreds();
  const h = {
    "ApiIntegrationCode": integrationCode,
    "UserName": username,
    "Secret": secret,
    "Content-Type": "application/json",
  };
  if (impersonateResourceId) h["ImpersonationResourceId"] = String(impersonateResourceId);
  return h;
}

async function base() { return (await getAutotaskCreds()).baseUrl.replace(/\/+$/, ""); }

async function atFetch(path, { method = "GET", body, impersonate } = {}) {
  const url = (await base()) + path;
  const res = await fetch(url, {
    method,
    headers: await authHeaders(impersonate),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429) { const e = new Error("Autotask rate limit reached, try again shortly"); e.status = 429; throw e; }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    const e = new Error(`Autotask error ${res.status}: ${txt.slice(0, 300)}`);
    e.status = res.status >= 500 ? 502 : res.status;
    throw e;
  }
  return res.status === 204 ? null : res.json();
}

/** POST /Entity/query with a filter array. Handles paging. */
async function query(entity, filter, { fields } = {}) {
  let items = [], page = `/V1.0/${entity}/query`;
  let payload = { filter, MaxRecords: 500 };
  if (fields) payload.IncludeFields = fields;
  // Autotask returns pageDetails.nextPageUrl as a full URL; follow until null.
  let res = await atFetch(page, { method: "POST", body: payload });
  items = items.concat(res.items || []);
  let next = res.pageDetails && res.pageDetails.nextPageUrl;
  while (next) {
    const r = await fetch(next, { headers: await authHeaders() });
    const j = await r.json();
    items = items.concat(j.items || []);
    next = j.pageDetails && j.pageDetails.nextPageUrl;
  }
  return items;
}

/** Map a signed-in email to an Autotask Resource id (cached per-process). */
const resourceCache = new Map();
async function resolveResourceId(email) {
  const key = email.toLowerCase();
  if (resourceCache.has(key)) return resourceCache.get(key);
  const items = await query("Resources",
    [{ op: "eq", field: "email", value: email }], { fields: ["id", "email"] });
  const id = items[0] ? items[0].id : null;
  resourceCache.set(key, id);
  return id;
}

/** Active resources (salespeople) for the login picker: [{ id, name }]. */
async function getResources() {
  const items = await query("Resources",
    [{ op: "eq", field: "isActive", value: true }],
    { fields: ["id", "firstName", "lastName", "email"] });
  return items
    .map(r => ({ id: r.id, name: (`${r.firstName || ""} ${r.lastName || ""}`).trim() || r.email || ("Resource " + r.id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Company id for an opportunity (needed when logging a note). */
async function getOppCompanyId(oppId) {
  const items = await query("Opportunities",
    [{ op: "eq", field: "id", value: Number(oppId) }], { fields: ["id", "companyID"] });
  return items[0] ? items[0].companyID : null;
}

/** Cached map of resource id -> display name (all resources, active or not). */
let _resMap = null, _resMapExp = 0;
async function getResourceMap() {
  if (_resMap && _resMapExp > Date.now()) return _resMap;
  const items = await query("Resources",
    [{ op: "gte", field: "id", value: 0 }],
    { fields: ["id", "firstName", "lastName", "email"] });
  const m = new Map();
  for (const r of items) {
    m.set(Number(r.id), (`${r.firstName || ""} ${r.lastName || ""}`).trim() || r.email || ("Resource " + r.id));
  }
  _resMap = m; _resMapExp = Date.now() + 5 * 60 * 1000;
  return m;
}
function nameFor(map, id) {
  if (id == null) return "Unassigned";
  return map.get(Number(id)) || ("Resource " + id);
}

/** Map company id -> companyName for a set of ids (batched, fault-tolerant). */
async function getCompanyMap(ids) {
  const unique = [...new Set(ids.map(Number).filter(Boolean))];
  const m = new Map();
  try {
    for (let i = 0; i < unique.length; i += 200) {
      const chunk = unique.slice(i, i + 200);
      const items = await query("Companies",
        [{ op: "in", field: "id", value: chunk }], { fields: ["id", "companyName"] });
      for (const c of items) m.set(Number(c.id), c.companyName);
    }
  } catch (e) { /* companies unavailable — leave names blank */ }
  return m;
}

/** Map opportunity id -> its primary quote { id, number, name } (batched, fault-tolerant). */
async function getQuoteMap(oppIds) {
  const unique = [...new Set(oppIds.map(Number).filter(Boolean))];
  const m = new Map();
  try {
    for (let i = 0; i < unique.length; i += 200) {
      const chunk = unique.slice(i, i + 200);
      const items = await query("Quotes",
        [{ op: "in", field: "opportunityID", value: chunk }],
        { fields: ["id", "quoteNumber", "name", "opportunityID", "primaryQuote", "isActive"] });
      for (const q of items) {
        const oid = Number(q.opportunityID);
        const existing = m.get(oid);
        if (!existing || q.primaryQuote) m.set(oid, { id: q.id, number: q.quoteNumber, name: q.name });
      }
    }
  } catch (e) { /* quotes unavailable — leave quote links off */ }
  return m;
}

/** Map opportunity id -> array of its linked tickets [{ id, number, title }] (batched, fault-tolerant). */
async function getTicketMap(oppIds) {
  const unique = [...new Set(oppIds.map(Number).filter(Boolean))];
  const m = new Map();
  try {
    for (let i = 0; i < unique.length; i += 200) {
      const chunk = unique.slice(i, i + 200);
      const items = await query("Tickets",
        [{ op: "in", field: "opportunityID", value: chunk }],
        { fields: ["id", "ticketNumber", "title", "opportunityID"] });
      for (const t of items) {
        const oid = Number(t.opportunityID);
        if (!m.has(oid)) m.set(oid, []);
        m.get(oid).push({ id: t.id, number: t.ticketNumber, title: t.title });
      }
    }
  } catch (e) { /* tickets unavailable — leave ticket links off */ }
  return m;
}

/** Map opportunity id -> its latest human note { author, text, at } (actionType 1 only). */
async function getLastHumanNoteMap(oppIds) {
  const unique = [...new Set(oppIds.map(Number).filter(Boolean))];
  const m = new Map();
  try {
    const resMap = await getResourceMap();
    for (let i = 0; i < unique.length; i += 200) {
      const chunk = unique.slice(i, i + 200);
      const items = await query("CompanyNotes",
        [{ op: "in", field: "opportunityID", value: chunk }, { op: "eq", field: "actionType", value: 1 }],
        { fields: ["id", "name", "note", "assignedResourceID", "opportunityID", "createDateTime"] });
      for (const n of items) {
        const oid = Number(n.opportunityID);
        const existing = m.get(oid);
        if (!existing || new Date(n.createDateTime || 0) > new Date(existing.at || 0)) {
          const stamped = (n.name || "").startsWith(NOTE_PREFIX);
          m.set(oid, {
            author: stamped ? n.name.slice(NOTE_PREFIX.length) : nameFor(resMap, n.assignedResourceID),
            text: n.note || "",
            at: n.createDateTime,
          });
        }
      }
    }
  } catch (e) { /* notes unavailable — cards show the add-a-note prompt */ }
  return m;
}

/** Stage picklist labels for the Opportunities.stage field (ascending by value). */
async function getStages() {
  const info = await atFetch(`/V1.0/Opportunities/entityInformation/fields`);
  const field = (info.fields || []).find(f => f.name === "stage");
  const values = (field && field.picklistValues || [])
    .filter(v => v.isActive)
    .map(v => ({ id: Number(v.value), name: v.label }))
    .sort((a, b) => a.id - b.id);
  return values;
}

/** Active opportunities mapped to the shape the board expects. */
async function getOpportunities() {
  const [opps, resMap] = await Promise.all([
    query("Opportunities", [{ op: "eq", field: "status", value: 1 }]), // 1 = Active
    getResourceMap(),
  ]);
  const [companyMap, quoteMap, ticketMap, lastNoteMap] = await Promise.all([
    getCompanyMap(opps.map(o => o.companyID)),
    getQuoteMap(opps.map(o => o.id)),
    getTicketMap(opps.map(o => o.id)),
    getLastHumanNoteMap(opps.map(o => o.id)),
  ]);
  return opps.map(o => {
    const q = quoteMap.get(Number(o.id));
    const tickets = ticketMap.get(Number(o.id)) || [];
    return {
      id: o.id,
      title: o.title,
      description: o.description || "",
      stageId: Number(o.stage),
      company: companyMap.get(Number(o.companyID)) || "",
      companyId: o.companyID ? Number(o.companyID) : null,  // Autotask account id (for the associate-ticket popup)
      owner: nameFor(resMap, o.ownerResourceID),
      oneOff: o.onetimeRevenue ?? o.amount ?? 0,
      mrr: o.monthlyRevenue ?? 0,
      closeDate: o.projectedCloseDate ? String(o.projectedCloseDate).slice(0, 10) : null,
      quoteId: q ? q.id : null,          // Quote entity id (for the hyperlink)
      quoteNumber: q ? q.number : null,  // user-facing quote number (for display)
      quoteName: q ? q.name : null,
      tickets,                           // [{ id, number, title }] — all linked tickets
      lastNote: lastNoteMap.get(Number(o.id)) || null, // latest human note for the card
      probability: o.probability ?? 0,
    };
  });
}

async function updateStage(oppId, stageId) {
  return atFetch(`/V1.0/Opportunities`, {
    method: "PATCH",
    body: { id: Number(oppId), stage: Number(stageId) },
  });
}

async function patchOpportunity(oppId, changes) {
  const body = { id: Number(oppId) };
  if (changes.title != null) body.title = changes.title;
  if (changes.description != null) body.description = changes.description;
  if (changes.closeDate != null) body.projectedCloseDate = changes.closeDate;
  if (changes.probability != null) body.probability = Number(changes.probability);
  return atFetch(`/V1.0/Opportunities`, { method: "PATCH", body });
}

// Notes are created by the API user, so we stamp the acting person's name into
// the note title (with this marker) and read it back as the author. That keeps
// per-person attribution on notes without needing impersonation.
const NOTE_PREFIX = "Pipeline: ";

/** Activity = CompanyNote linked to the opportunity. */
async function getActivities(oppId) {
  let notes;
  try {
    notes = await query("CompanyNotes", [
      { op: "eq", field: "opportunityID", value: Number(oppId) },
      { op: "eq", field: "actionType", value: 1 },   // human notes only — exclude system/audit entries
    ]);
  } catch (e) { return []; }
  const resMap = await getResourceMap();
  return notes
    .sort((a, b) => new Date(b.createDateTime || 0) - new Date(a.createDateTime || 0))
    .slice(0, 5)
    .map(n => {
      const stamped = (n.name || "").startsWith(NOTE_PREFIX);
      return {
        id: n.id,
        text: n.note || "",
        author: stamped ? n.name.slice(NOTE_PREFIX.length) : nameFor(resMap, n.assignedResourceID),
        at: n.createDateTime,
      };
    });
}

async function addActivity(oppId, companyId, text, authorName, resourceId) {
  const now = new Date().toISOString();
  // CompanyNotes are a child of Company: created via the parent URL, with the
  // text in `note` and the title in `name`. startDateTime/endDateTime/
  // assignedResourceID are required.
  return atFetch(`/V1.0/Companies/${Number(companyId)}/Notes`, {
    method: "POST",
    body: {
      companyID: Number(companyId),
      opportunityID: Number(oppId),
      actionType: 1,
      assignedResourceID: Number(resourceId),
      name: (NOTE_PREFIX + (authorName || "Pipeline")).slice(0, 250),
      note: text,
      startDateTime: now,
      endDateTime: now,
    },
  });
}

/**
 * Ticket statuses whose label looks "completed/resolved" — resolved from Autotask field
 * metadata so it works regardless of this instance's custom status ids. Cached after first read.
 */
let _excludedTicketStatusIds = null;
async function getExcludedTicketStatusIds() {
  if (_excludedTicketStatusIds) return _excludedTicketStatusIds;
  try {
    const info = await atFetch("/V1.0/Tickets/entityInformation/fields");
    const f = (info.fields || []).find(x => x.name === "status");
    const ids = ((f && f.picklistValues) || [])
      .filter(v => /complete|resolved/i.test(v.label || ""))
      .map(v => Number(v.value))
      .filter(n => Number.isFinite(n));
    _excludedTicketStatusIds = ids;
    return ids;
  } catch (e) { return []; }   // don't cache failures — retry next time
}

/**
 * Tickets for this opportunity's company, for the associate picker. Excludes completed/resolved
 * tickets and anything created more than 6 months ago, and tickets already on this opportunity.
 * Sorted by ticket number, descending.
 */
async function getCompanyTickets(oppId) {
  const companyId = await getOppCompanyId(oppId);
  if (!companyId) return [];
  const since = new Date();
  since.setMonth(since.getMonth() - 6);
  const items = [
    { op: "eq", field: "companyID", value: Number(companyId) },
    { op: "gte", field: "createDate", value: since.toISOString() },
  ];
  const excluded = await getExcludedTicketStatusIds();
  if (excluded.length) items.push({ op: "notIn", field: "status", value: excluded });
  let rows = [];
  try {
    rows = await query("Tickets", [{ op: "and", items }],
      { fields: ["id", "ticketNumber", "title", "opportunityID"] });
  } catch (e) { return []; }
  return rows
    .filter(t => Number(t.opportunityID || 0) !== Number(oppId))
    .map(t => ({ id: Number(t.id), number: t.ticketNumber, title: t.title || "", linkedElsewhere: !!t.opportunityID }))
    .sort((a, b) => String(b.number).localeCompare(String(a.number), undefined, { numeric: true }))
    .slice(0, 300);
}

/** Associate an existing ticket with this opportunity by setting the ticket's opportunityID. */
async function associateTicket(oppId, ticketId) {
  await atFetch("/V1.0/Tickets", {
    method: "PATCH",
    body: { id: Number(ticketId), opportunityID: Number(oppId) },
  });
  const items = await query("Tickets",
    [{ op: "eq", field: "id", value: Number(ticketId) }],
    { fields: ["id", "ticketNumber", "title"] });
  const t = items[0];
  return t ? { id: Number(t.id), number: t.ticketNumber, title: t.title || "" } : { id: Number(ticketId) };
}

module.exports = {
  resolveResourceId, getResources, getOppCompanyId, getStages, getOpportunities,
  updateStage, patchOpportunity, getActivities, addActivity,
  getCompanyTickets, associateTicket,
};
