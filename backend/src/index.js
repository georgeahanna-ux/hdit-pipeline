"use strict";
/**
 * Pipeline API — a SINGLE Azure Function (HTTP trigger, catch-all route).
 *
 * Auth: app-level. POST /resources and POST /login are public (they validate
 * the shared team password). Every other route requires a valid session token,
 * verified in ./lib/auth.
 *
 * Route table (all under /api):
 *   POST   /resources              (public — password -> resource picker list)
 *   POST   /login                  (public — password + resourceId -> token)
 *   GET    /me
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

async function readBody(request) { try { return await request.json(); } catch { return {}; } }

function match(method, segs) {
  const [a, b, c] = segs;
  // public (pre-auth)
  if (a === "resources" && method === "POST") return { fn: "loginResources", public: true };
  if (a === "login" && method === "POST") return { fn: "login", public: true };
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
      if (!route) return { status: 404, headers: cors, jsonBody: { message: "Not found" } };

      const body = ["POST", "PATCH", "PUT"].includes(request.method) ? await readBody(request) : null;

      let result;
      if (route.public) {
        result = await H[route.fn](body);
      } else {
        const identity = await authenticate(request);   // throws 401/403
        result = await H[route.fn](identity, route.id, body);
      }
      return { ...result, headers: { ...cors, ...(result.headers || {}) } };
    } catch (err) {
      const status = err.status || 500;
      context.error(err);
      return { status, headers: cors, jsonBody: { message: err.message || "Server error" } };
    }
  },
});
