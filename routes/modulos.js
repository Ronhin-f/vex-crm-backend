// routes/modulos.js — Proxy a Core (blindado, cache por org + query)
import { Router } from "express";
import { authenticateToken } from "../middleware/auth.js";
import { nocache } from "../middleware/nocache.js";

const router = Router();

/* ------------------------- config ------------------------- */
// Base URL sin trailing slash
const CORE_URL = String(process.env.VEX_CORE_URL || "").replace(/\/+$/, "");

// Permite override sin asumir rutas del Core
const CORE_HEALTH_PATH  = process.env.CORE_HEALTH_PATH  || "/health";
const CORE_MODULOS_PATH = process.env.CORE_MODULOS_PATH || "/modulos";

const TIMEOUT_MS = Number(process.env.CORE_TIMEOUT_MS || 3000);
const CACHE_MS   = Number(process.env.CORE_CACHE_MS   || 60_000);

// cache: key -> { ts, data }
const cache = new Map();

/* ------------------------- helpers ------------------------- */
function joinUrl(base, path) {
  if (!path) return base;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

function buildUrlWithQuery(base, path, query = {}) {
  const url = new URL(joinUrl(base, path));
  // forward solo primitivos y arrays simples
  for (const [k, v] of Object.entries(query || {})) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      for (const vv of v) url.searchParams.append(k, String(vv));
    } else if (typeof v === "object") {
      // evitamos objetos anidados (para no reventar el Core)
      url.searchParams.append(k, String(v));
    } else {
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

function withTimeout(ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, cancel: () => clearTimeout(t) };
}

function getOrg(req) {
  const u = req.usuario || {};
  const raw =
    u.organizacion_id ??
    req.organizacion_id ??
    req.headers["x-org-id"] ??
    req.query?.organizacion_id ??
    req.body?.organizacion_id ??
    null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function cacheGet(key) {
  const c = cache.get(key);
  if (!c) return null;
  if (Date.now() - c.ts > CACHE_MS) {
    cache.delete(key);
    return null;
  }
  return c.data;
}
function cacheSet(key, data) {
  cache.set(key, { ts: Date.now(), data });
}

// Si el Core devuelve vacío/no-JSON, devolvemos {}
async function parseJsonSafe(res) {
  const txt = await res.text();
  if (!txt) return {};
  try { return JSON.parse(txt); } catch { return {}; }
}

/* Core GET con forward de Authorization, X-Org-Id y querystring */
async function fetchCore(path, req) {
  if (!CORE_URL) throw new Error("CORE_URL not set");
  const url = buildUrlWithQuery(CORE_URL, path, req.query);
  const { signal, cancel } = withTimeout(TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: req.headers["authorization"] || "",
        "X-Org-Id": String(getOrg(req) ?? ""),
        Accept: "application/json",
      },
      signal,
    });
    // 204/205: no content válido
    if (r.status === 204 || r.status === 205) return {};
    const data = await parseJsonSafe(r);
    if (!r.ok) {
      const err = new Error(`Core ${r.status}`);
      err.status = r.status;
      err.data = data;
      throw err;
    }
    return data;
  } finally {
    cancel();
  }
}

/* --------------------------- ping --------------------------- */
/** Verifica reachability de Core sin asumir endpoint fijo (env-driven) */
router.get("/ping", authenticateToken, nocache, async (req, res) => {
  res.set("Vary", "Authorization, X-Org-Id");
  if (!CORE_URL) return res.json({ core: false, reachable: false, note: "core_unset" });
  try {
    await fetchCore(CORE_HEALTH_PATH, req);
    return res.json({ core: true, reachable: true, path: CORE_HEALTH_PATH });
  } catch (e) {
    return res.json({ core: true, reachable: false, path: CORE_HEALTH_PATH });
  }
});

/* -------------------------- / (modulos) -------------------------- */
/**
 * Proxy resiliente a /modulos del Core (ruta configurable).
 * - Si Core no está configurado o falla, devolvemos 200 con fallback vacío.
 * - Cachea por organización + querystring para evitar fugas entre tenants y variaciones de filtro.
 *   ⚠️ Si el Core personaliza por rol/permiso del usuario, considerá incluir una fingerprint del token.
 */
router.get("/", authenticateToken, nocache, async (req, res) => {
  res.set("Vary", "Authorization, X-Org-Id");
  const org = getOrg(req);
  // cacheKey incluye path + org + query ordenada
  const qsPairs = Object.entries(req.query || {})
    .sort(([a],[b]) => a.localeCompare(b))
    .map(([k,v]) => Array.isArray(v) ? `${k}=${v.join(",")}` : `${k}=${v}`)
    .join("&");
  const cacheKey = `modulos:${CORE_MODULOS_PATH}:${org ?? "anon"}:${qsPairs}`;

  try {
    if (!CORE_URL) {
      const payload = { core: false, modules: [], note: "core_unset" };
      cacheSet(cacheKey, payload);
      return res.json(payload);
    }

    const hit = cacheGet(cacheKey);
    if (hit) return res.json(hit);

    const data = await fetchCore(CORE_MODULOS_PATH, req);
    const payload = { core: true, ...data, path: CORE_MODULOS_PATH };
    cacheSet(cacheKey, payload);
    return res.json(payload);
  } catch (e) {
    const payload = {
      core: !!CORE_URL,
      modules: [],
      note: e?.name === "AbortError" ? "core_timeout" : "core_unreachable",
      path: CORE_MODULOS_PATH,
    };
    cacheSet(cacheKey, payload);
    return res.json(payload);
  }
});

export default router;
