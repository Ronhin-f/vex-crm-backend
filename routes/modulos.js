// routes/modulos.js
import { Router } from "express";
import { authenticateToken } from "../middleware/auth.js";

const router = Router();

const CORE_URL = (process.env.VEX_CORE_URL || "").replace(/\/+$/, "");
const TIMEOUT_MS = Number(process.env.CORE_TIMEOUT_MS || 3000);
const CACHE_MS = Number(process.env.CORE_CACHE_MS || 60_000);

const cache = new Map(); // key -> { ts, data }

/* ------------------------- helpers ------------------------- */
function withTimeout(ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, cancel: () => clearTimeout(t) };
}

async function fetchCore(path, req) {
  if (!CORE_URL) throw new Error("CORE_URL not set");
  const url = `${CORE_URL}${path.startsWith("/") ? path : `/${path}`}`;
  const { signal, cancel } = withTimeout(TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: "GET",
      headers: {
        // Reenviamos tal cual el bearer del usuario
        Authorization: req.headers["authorization"] || "",
        "Content-Type": "application/json",
      },
      signal,
    });
    const data = await r.json().catch(() => ({}));
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

function getCached(key) {
  const c = cache.get(key);
  if (!c) return null;
  if (Date.now() - c.ts > CACHE_MS) {
    cache.delete(key);
    return null;
  }
  return c.data;
}

function setCached(key, data) {
  cache.set(key, { ts: Date.now(), data });
}

/* --------------------------- ping --------------------------- */
/** Pequeño ping para verificar Core sin romper la demo */
router.get("/ping", authenticateToken, async (req, res) => {
  if (!CORE_URL) return res.json({ core: false, reachable: false });
  try {
    // Intentamos /health; si tu Core no lo tiene, podés cambiar a "/"
    await fetchCore("/health", req);
    return res.json({ core: true, reachable: true });
  } catch {
    return res.json({ core: true, reachable: false });
  }
});

/* -------------------------- / (modulos) -------------------------- */
/**
 * Proxy resiliente a /modulos de Core.
 * - Si Core no está configurado o falla, devolvemos 200 con fallback vacío.
 * - Cachea 60s para no depender de Core en vivo durante la demo.
 */
router.get("/", authenticateToken, async (req, res) => {
  const cacheKey = "modulos";
  try {
    // 1) Sin Core configurado → fallback
    if (!CORE_URL) {
      const payload = { core: false, modules: [], note: "core_unset" };
      setCached(cacheKey, payload);
      return res.json(payload);
    }

    // 2) Cache
    const hit = getCached(cacheKey);
    if (hit) return res.json(hit);

    // 3) Core vivo
    const data = await fetchCore("/modulos", req);
    const payload = { core: true, ...data };
    setCached(cacheKey, payload);
    return res.json(payload);
  } catch (_e) {
    // 4) Fallback suave sin romper demo
    const payload = { core: !!CORE_URL, modules: [], note: "core_unreachable" };
    setCached(cacheKey, payload);
    return res.json(payload);
  }
});

export default router;
