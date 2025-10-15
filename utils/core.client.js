// backend/utils/core.client.js
const CORE_URL = (process.env.CORE_URL || process.env.API_CORE_URL || "https://vex-core-backend-production.up.railway.app").replace(/\/+$/,"");
const SERVICE_TOKEN = process.env.CORE_SERVICE_TOKEN || process.env.CORE_MACHINE_TOKEN || null;

// cache simple en memoria
const mem = { users: new Map() }; // key = orgId

export async function coreListUsers(orgId, bearerFromReq) {
  const key = String(orgId || "none");
  const hit = mem.users.get(key);
  if (hit && Date.now() - hit.ts < 60_000) return hit.data;

  const headers = { "Content-Type": "application/json" };
  if (bearerFromReq) headers.Authorization = bearerFromReq;
  else if (SERVICE_TOKEN) headers.Authorization = `Bearer ${SERVICE_TOKEN}`;

  // 1) /api/users?org_id=...
  let res = await fetch(`${CORE_URL}/api/users?org_id=${encodeURIComponent(orgId || "")}`, { headers });
  // 2) fallback: /api/orgs/:orgId/users
  if (!res.ok && orgId) res = await fetch(`${CORE_URL}/api/orgs/${orgId}/users`, { headers });

  let items = [];
  if (res.ok) {
    const data = await res.json().catch(() => ({}));
    items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
  }

  mem.users.set(key, { ts: Date.now(), data: items });
  return items;
}
