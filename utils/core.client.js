// backend/utils/core.client.js
// Cliente robusto para VEX Core (Node 18+ con fetch global)
//
// ENV soportadas (se toma la primera definida):
// - CORE_URL
// - API_CORE_URL
// - CORE_BASE_URL
// - CORE_API_URL
// (fallback) https://vex-core-backend-production.up.railway.app  ← confirmar si es correcto
//
// Token de servicio (opcional):
// - CORE_SERVICE_TOKEN o CORE_MACHINE_TOKEN
//
// Comportamiento:
// • Si viene Authorization en el request, se usa tal cual; si no, se usa SERVICE_TOKEN (si existe).
// • Timeout defensivo y un reintento corto ante errores de red.
// • Cache en memoria (TTL configurable por CORE_CACHE_MS; por defecto 60s) por (orgId + tipo de auth).
// • Soporta respuestas {items:[]}, {users:[]}, {data:[]} o array directo.
// • Fallback de rutas: /api/users?organizacion_id=... → /api/orgs/:id/users → /api/users
//
// Extra:
// • Header x-org-id (cuando hay org) para servicios que lo soporten.
// • Fallback opcional a SERVICE_TOKEN si el bearer de usuario responde 401/403 (require allowSvcFallback=true).

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

const CACHE_MS = Number(process.env.CORE_CACHE_MS || 60_000);

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
  } catch (_e) {
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
 * @param {object} [opts]
 * @param {boolean} [opts.allowSvcFallback=false] // si 401/403 con bearer, reintenta con SERVICE_TOKEN (si existe)
 * @param {boolean} [opts.passOrgHeader=true] // envía x-org-id junto con los query params
 * @returns {Promise<Array>}  // usuarios normalizados (email, name, slack_user_id)
 */
export async function coreListUsers(orgId, bearerFromReq, opts = {}) {
  const { allowSvcFallback = false, passOrgHeader = true } = opts;

  // cache key distinta si es bearer de usuario o token de servicio
  const authKind = bearerFromReq ? "user" : (SERVICE_TOKEN ? "svc" : "none");
  const key = `${orgId ?? "none"}|${authKind}`;

  const hit = mem.users.get(key);
  if (hit && Date.now() - hit.ts < CACHE_MS) return hit.data;

  const baseHeaders = {};
  if (passOrgHeader && orgId !== null && orgId !== undefined && orgId !== "") {
    baseHeaders["x-org-id"] = String(orgId);
  }

  // Construcción de query con aliases
  const makeQS = (id) => {
    const qs = new URLSearchParams();
    if (id !== null && id !== undefined && id !== "") {
      qs.set("organizacion_id", String(id));
      qs.set("orgId", String(id));
      qs.set("org_id", String(id));
    }
    qs.set("limit", "500");
    return qs.toString();
  };

  // Helper para intentar con header dado
  const tryList = async (authHeader) => {
    const headers = { ...baseHeaders };
    if (authHeader) headers.Authorization = authHeader;

    // Intento principal: /api/users
    let res = await coreGet(`/api/users?${makeQS(orgId)}`, { headers, retry: 1 });

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

    return res;
  };

  // 1) Intento con el bearer de usuario o con SERVICE_TOKEN si no hay bearer
  const primaryAuth =
    bearerFromReq || (SERVICE_TOKEN ? `Bearer ${SERVICE_TOKEN}` : undefined);
  let res = await tryList(primaryAuth);

  // 2) Fallback opcional: si vino bearer de usuario y falló por 401/403, reintento con SERVICE_TOKEN
  if (
    allowSvcFallback &&
    bearerFromReq &&
    SERVICE_TOKEN &&
    (!res.ok && (res.status === 401 || res.status === 403))
  ) {
    res = await tryList(`Bearer ${SERVICE_TOKEN}`);
  }

  let items = [];
  if (res.ok && res.data) {
    items = pickArrayFrom(res.data);
  }

  const normalized = normalizeUsers(items);
  mem.users.set(key, { ts: Date.now(), data: normalized });
  return normalized;
}
