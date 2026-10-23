"use strict";
/**
 * Pipeline API — a SINGLE Azure Function (HTTP trigger, catch-all route).
 *
 * Auth: app-level. POST /resources and POST /login are public (they validate
 * the shared team password). Every other route requires a valid session token,
 * verified in ./lib/auth.
 *
 * Route table (all under /api):
 *   GET    /health                 (public — version + whether secrets are configured)
 *   POST   /resources              (public — password -> resource picker list)
 *   POST   /login                  (public — password + resourceId -> token)
 *   GET    /me
 *   GET    /link/resources         (Pulse sign-in — Autotask names to link to, when email didn't match)
 *   POST   /link                   (Pulse sign-in — save which Autotask resource you are)
 *   GET    /stages
 *   GET    /opportunities
 *   GET    /opportunities/{id}/activities
 *   POST   /opportunities/{id}/activities
 *   PATCH  /opportunities/{id}/stage
 *   PATCH  /opportunities/{id}
 *   GET    /admins                 (admin)
 *   PUT    /admins                 (admin)
 *   PUT    /settings               (admin)
 */
const { app } = require("@azure/functions");
const { authenticate } = require("./lib/auth");
const pulse = require("./lib/pulse-auth");
const H = require("./handlers");

// CORS is owned by the Azure Functions PLATFORM, not this code. The host answers the OPTIONS
// preflight itself and only attaches Access-Control-Allow-Origin when the request's origin is
// registered in platform CORS (set via `az functionapp cors add` / provision.sh). So we do NOT
// set Access-Control-Allow-Origin here — doing so would duplicate the platform's header on real
// responses, which browsers reject. We only declare the allowed headers/methods.
const cors = {
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, OPTIONS",
};

const security = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

async function readBody(request) { try { return await request.json(); } catch { return {}; } }

function match(method, segs) {
  const [a, b, c] = segs;
  // public (pre-auth)
  if (a === "health" && !b && method === "GET") return { fn: "health", public: true };
  if (a === "resources" && method === "POST") return { fn: "loginResources", public: true };
  if (a === "login" && method === "POST") return { fn: "login", public: true };
  // HD IT Pulse: link your Autotask name (only when your email didn't match)
  if (a === "link" && b === "resources" && !c && method === "GET") return { fn: "linkResources", pulse: true };
  if (a === "link" && !b && method === "POST") return { fn: "link", pulse: true };
  // authenticated
  if (method === "GET" && a === "me") return { fn: "me" };
  if (method === "GET" && a === "stages") return { fn: "stages" };
  if (a === "opportunities" && !b) return method === "GET" ? { fn: "opportunities" } : null;
  if (a === "opportunities" && b && c === "activities")
    return { fn: method === "POST" ? "addActivity" : "activities", id: b };
  if (a === "opportunities" && b && c === "company-tickets" && method === "GET")
    return { fn: "companyTickets", id: b };
  if (a === "opportunities" && b && c === "tickets" && method === "POST")
    return { fn: "associateTicket", id: b };
  if (a === "opportunities" && b && c === "stage" && method === "PATCH")
    return { fn: "moveStage", id: b };
  if (a === "opportunities" && b && !c && method === "PATCH")
    return { fn: "patchOpp", id: b };
  if (a === "admins") return method === "GET" ? { fn: "listAdmins" } : (method === "PUT" ? { fn: "saveAdmins" } : null);
  if (a === "settings" && method === "PUT") return { fn: "saveSettings" };
  return null;
}

app.http("api", {
  methods: ["GET", "POST", "PATCH", "PUT", "OPTIONS"],
  authLevel: "anonymous",
  route: "{*path}",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") return { status: 204, headers: cors };

    const path = (request.params.path || "").replace(/^api\/?/, "").replace(/^\/+|\/+$/g, "");
    const segs = path.split("/").filter(Boolean);

    try {
      const route = match(request.method, segs);
      if (!route) return { status: 404, headers: { ...cors, ...security }, jsonBody: { message: "Not found" } };

      const body = ["POST", "PATCH", "PUT"].includes(request.method) ? await readBody(request) : null;

      let result;
      if (route.public) {
        result = await H[route.fn](body);
      } else {
        const identity = await authenticate(request);   // throws 401/403
        // Signed in through Pulse but not yet matched to an Autotask resource: only /me and /link work.
        if (identity.needsLink && !route.pulse && route.fn !== "me") throw pulse.fail(409, "Link your Autotask name to continue.", "link-required");
        result = route.pulse
          ? await pulse[route.fn](identity, route.id, body)
          : await H[route.fn](identity, route.id, body);
      }
      return { ...result, headers: { ...cors, ...security, ...(result.headers || {}) } };
    } catch (err) {
      const status = err.status || 500;
      context.error(err);
      const message = status >= 500 && !err.status ? "Something went wrong on the server. Check Application Insights for details." : (err.message || "Server error");
      return { status, headers: { ...cors, ...security }, jsonBody: err.expose && err.code ? { message, code: err.code } : { message } };
    }
  },
});

module.exports = { match };
