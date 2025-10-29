// backend/utils/core.client.js
// Cliente robusto para VEX Core (Node 18+ con fetch global)
//
// ENV soportadas (se toma la primera definida):
// - CORE_URL
// - API_CORE_URL
// - CORE_BASE_URL
// - CORE_API_URL
// (fallback) https://vex-core-backend-production.up.railway.app
//
// También soporta token de servicio:
// - CORE_SERVICE_TOKEN o CORE_MACHINE_TOKEN
//
// Comportamiento:
// • Pasa Authorization del request si viene; si no, usa SERVICE_TOKEN.
// • Timeout defensivo y un reintento corto.
// • Cache en memoria 60s por (orgId + tipo de auth).
// • Soporta respuestas {items:[]}, {users:[]}, {data:[]} o array directo.
// • Fallback de rutas: /api/users?organizacion_id=... → /api/orgs/:id/users → /api/users

const RAW_BASE =
  (process.env.CORE_URL ||
    process.env.API_CORE_URL ||
    process.env.CORE_BASE_URL ||
    process.env.CORE_API_URL ||
    "https://vex-core-backend-production.up.railway.app")
    .toString()
    .trim();

const CORE_BASE_URL = RAW_BASE.replace(/\/+$/, ""); // sin trailing slash
const SERVICE_TOKEN =
  process.env.CORE_SERVICE_TOKEN || process.env.CORE_MACHINE_TOKEN || null;

// cache simple en memoria
const mem = {
  users: new Map(), // key: `${orgKey}|${authKind}`
};

// util: timeout con AbortController
function withTimeout(ms = 8000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, cancel: () => clearTimeout(id) };
}

async function coreGet(path, { headers = {}, retry = 1 } = {}) {
  const url = `${CORE_BASE_URL}${path.startsWith("/") ? "" : "/"}${path}`;
  const { signal, cancel } = withTimeout(8000);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...headers,
      },
      signal,
    });

    const ct = (res.headers.get("content-type") || "").toLowerCase();
    const data = ct.includes("application/json")
      ? await res.json().catch(() => null)
      : await res.text().catch(() => null);

    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    if (retry > 0) {
      // backoff pequeño
      await new Promise((r) => setTimeout(r, 150));
      return coreGet(path, { headers, retry: retry - 1 });
    }
    return { ok: false, status: 0, data: null };
  } finally {
    cancel();
  }
}

// normaliza usuarios para que aguas abajo sea más simple
function normalizeUsers(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((u) => {
      const email = String(u?.email || u?.usuario_email || "").toLowerCase().trim();
      const name =
        u?.name ||
        u?.nombre ||
        u?.full_name ||
        u?.display_name ||
        u?.email ||
        email ||
        "";
      const slack_user_id =
        u?.slack_id ||
        u?.slack_user_id ||
        (u?.slack && (u.slack.user_id || u.slack.id)) ||
        null;

      return { ...u, email, name, slack_user_id };
    })
    .filter((u) => u.email);
}

function pickArrayFrom(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    if (Array.isArray(data.items)) return data.items;
    if (Array.isArray(data.users)) return data.users;
    if (Array.isArray(data.data)) return data.data;
  }
  return [];
}

/**
 * Lista usuarios desde Core, opcionalmente filtrando por organización.
 * Compatible con rutas /api/users?organizacion_id=... | orgId=... | org_id=...
 * y fallback /api/orgs/:orgId/users. Si todo falla, intenta /api/users sin filtro.
 *
 * @param {number|string|null} orgId
 * @param {string|undefined} bearerFromReq  // ej: "Bearer eyJ..."
 * @returns {Promise<Array>}  // usuarios normalizados (email, name, slack_user_id)
 */
export async function coreListUsers(orgId, bearerFromReq) {
  // cache key distinta si es bearer de usuario o token de servicio
  const authKind = bearerFromReq ? "user" : (SERVICE_TOKEN ? "svc" : "none");
  const key = `${orgId ?? "none"}|${authKind}`;

  const hit = mem.users.get(key);
  if (hit && Date.now() - hit.ts < 60_000) return hit.data;

  const headers = {};
  if (bearerFromReq) headers.Authorization = bearerFromReq;
  else if (SERVICE_TOKEN) headers.Authorization = `Bearer ${SERVICE_TOKEN}`;

  // Intento principal: /api/users con múltiples nombres de query por compatibilidad
  const qs = new URLSearchParams();
  if (orgId !== null && orgId !== undefined && orgId !== "") {
    qs.set("organizacion_id", String(orgId));
    qs.set("orgId", String(orgId));
    qs.set("org_id", String(orgId));
  }
  qs.set("limit", "500");

  let res = await coreGet(`/api/users?${qs.toString()}`, { headers, retry: 1 });

  // Fallback 1: /api/orgs/:orgId/users (si hay orgId)
  if ((!res.ok || !res.data) && orgId) {
    res = await coreGet(`/api/orgs/${encodeURIComponent(orgId)}/users`, {
      headers,
      retry: 1,
    });
  }

  // Fallback 2: /api/users sin filtros (último recurso)
  if (!res.ok || !res.data) {
    res = await coreGet(`/api/users`, { headers, retry: 0 });
  }

  let items = [];
  if (res.ok && res.data) {
    items = pickArrayFrom(res.data);
  }

  const normalized = normalizeUsers(items);
  mem.users.set(key, { ts: Date.now(), data: normalized });
  return normalized;
}
