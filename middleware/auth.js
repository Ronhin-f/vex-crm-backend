// backend/middleware/auth.js (ESM)
import jwt from "jsonwebtoken";

/* ===========================
 * Config & ENV
 * =========================== */
const AUTH_MODE = (process.env.CORE_AUTH_MODE || "hybrid").toLowerCase(); // hybrid | jwt | introspect | none
const SECRET_KEY =
  process.env.JWT_SECRET ||
  process.env.CORE_JWT_SECRET ||
  "vex-secreta";
const JWT_PUBLIC_KEY = process.env.JWT_PUBLIC_KEY || null; // opcional (RS256)
const JWT_ISSUER = process.env.JWT_ISSUER || null;         // opcional
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || null;     // opcional
const CLOCK_TOLERANCE = Number(process.env.JWT_CLOCK_TOLERANCE || 30); // seg

const RAW_CORE_URL =
  (process.env.CORE_URL ||
    process.env.VEX_CORE_URL ||
    process.env.API_CORE_URL ||
    process.env.CORE_BASE_URL ||
    process.env.CORE_API_URL ||
    "").toString().trim();
const CORE_URL = RAW_CORE_URL ? RAW_CORE_URL.replace(/\/+$/, "") : null;

// Ruta principal y alternativas de introspección (compat previa)
const PRIMARY_VALIDATE_PATH = process.env.CORE_VALIDATE_PATH || "/auth/validar";
const ALT_VALIDATE_PATHS = [
  "/api/auth/introspect",
  "/auth/introspect",
  "/api/auth/validar",
];

// Cache
const CACHE_MS = Number(process.env.CORE_CACHE_MS || 60_000);
const MAX_CACHE_ENTRIES = Number(process.env.CORE_CACHE_MAX || 500);
const tokenCache = new Map(); // token -> { payload, ts }

const ALLOW_ANON = /^(1|true|yes)$/i.test(process.env.ALLOW_ANON || "");
const DEV_ORG_ID = process.env.DEV_ORG_ID || null;
const AUTH_DEBUG = /^(1|true|yes)$/i.test(process.env.AUTH_DEBUG || "");

/* ===========================
 * Helpers
 * =========================== */
function debug(...args) {
  if (AUTH_DEBUG) console.log("[auth]", ...args);
}

function evictIfNeeded() {
  if (tokenCache.size <= MAX_CACHE_ENTRIES) return;
  const firstKey = tokenCache.keys().next().value;
  if (firstKey) tokenCache.delete(firstKey);
}

function cacheGet(token) {
  const rec = tokenCache.get(token);
  if (!rec) return null;
  if (Date.now() - rec.ts > CACHE_MS) {
    tokenCache.delete(token);
    return null;
  }
  return rec.payload;
}

function cacheSet(token, payload) {
  evictIfNeeded();
  tokenCache.set(token, { payload, ts: Date.now() });
}

function readToken(req) {
  // 1) Authorization: Bearer xxx
  const hdr = req.headers["authorization"] || req.headers["Authorization"];
  if (hdr && typeof hdr === "string") {
    const parts = hdr.split(" ");
    if (parts.length === 2 && /^Bearer$/i.test(parts[0])) return parts[1];
  }
  // 2) Headers alternativos
  const x1 = req.headers["x-vex-token"] || req.headers["x-auth-token"];
  if (x1 && typeof x1 === "string") return x1;

  // 3) Query bridge (?vex_token= / ?token=)
  const fromQuery = req.query?.vex_token || req.query?.token;
  if (fromQuery) return String(fromQuery);

  // 4) Cookie "token"
  const cookie = req.headers.cookie || "";
  const m = cookie.match(/(?:^|;\s*)token=([^;]+)/);
  if (m) return decodeURIComponent(m[1]);

  return null;
}

function normalizeUser(payload) {
  const email =
    payload?.email ||
    payload?.usuario_email ||
    payload?.user_email ||
    null;

  const organizacion_id =
    payload?.organizacion_id ??
    payload?.organization_id ??
    payload?.org_id ??
    null;

  const rol = payload?.rol || payload?.role || "user";
  const sub = payload?.sub || null;

  return { email, organizacion_id, rol, sub, payload };
}

function buildJwtVerifyOptions() {
  const opts = {
    algorithms: [],
    clockTolerance: CLOCK_TOLERANCE,
  };
  if (JWT_ISSUER) opts.issuer = JWT_ISSUER;
  if (JWT_AUDIENCE) opts.audience = JWT_AUDIENCE;

  if (JWT_PUBLIC_KEY) {
    // Soportar RS256 si hay clave pública
    opts.algorithms.push("RS256");
  } else {
    // HMAC por defecto
    opts.algorithms.push("HS256");
  }
  return opts;
}

function verifyLocalJwt(token) {
  const opts = buildJwtVerifyOptions();
  const key = JWT_PUBLIC_KEY ? JWT_PUBLIC_KEY : SECRET_KEY;
  const decoded = jwt.verify(token, key, opts);
  return decoded;
}

async function validateWithCore(token) {
  if (!CORE_URL) throw new Error("CORE_URL not set");
  const cached = cacheGet(token);
  if (cached) return cached;

  // Intento principal
  const paths = [PRIMARY_VALIDATE_PATH, ...ALT_VALIDATE_PATHS];
  for (const p of paths) {
    const url = `${CORE_URL}${p}`;
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({}),
      });
      if (!resp.ok) {
        debug(`introspect fail ${resp.status} @ ${p}`);
        continue;
      }
      const data = await resp.json().catch(() => ({}));

      // Acepta payload directo o dentro de { ok, user } o { payload }
      const payload =
        data?.user ||
        data?.payload ||
        (data?.ok && data?.data) ||
        data ||
        null;

      if (payload && typeof payload === "object") {
        cacheSet(token, payload);
        return payload;
      }
    } catch (e) {
      debug(`introspect error @ ${p}:`, e?.message || e);
      // sigue a la siguiente ruta
    }
  }
  throw new Error("Core validation failed");
}

/* ===========================
 * Middlewares
 * =========================== */
export async function authenticateToken(req, res, next) {
  try {
    const token = readToken(req);

    // Modo none (o ALLOW_ANON con falta de token) — solo dev
    if (AUTH_MODE === "none" || (!token && ALLOW_ANON)) {
      const devUser = normalizeUser({
        email: "anon@local",
        organizacion_id:
          DEV_ORG_ID ??
          req.headers["x-org-id"] ??
          req.query?.organizacion_id ??
          req.query?.org_id ??
          1,
        rol: "admin",
        sub: "anon",
      });
      req.usuario = devUser;
      req.organizacion_id = devUser.organizacion_id ?? null;
      return next();
    }

    if (!token) {
      return res.status(401).json({ message: "Token requerido" });
    }

    // HYBRID (default): intenta local y cae a introspección
    // JWT: solo local
    // INTROSPECT: solo Core
    if (AUTH_MODE === "jwt" || AUTH_MODE === "hybrid") {
      try {
        const decoded = verifyLocalJwt(token);
        req.usuario = normalizeUser(decoded);
        req.organizacion_id = req.usuario.organizacion_id ?? null;
        return next();
      } catch (e) {
        if (AUTH_MODE === "jwt") {
          return res.status(403).json({ message: "Token inválido (jwt)" });
        }
        // hybrid → sigue a introspect
      }
    }

    if (AUTH_MODE === "introspect" || AUTH_MODE === "hybrid") {
      try {
        const payload = await validateWithCore(token);
        req.usuario = normalizeUser(payload);
        req.organizacion_id = req.usuario.organizacion_id ?? null;
        return next();
      } catch (e) {
        return res.status(403).json({ message: "Token inválido", detail: "core" });
      }
    }

    // Si llegó acá, modo desconocido
    return res.status(500).json({ message: "Auth misconfigured" });
  } catch (e) {
    console.error("auth error:", e?.stack || e?.message || e);
    return res.status(500).json({ message: "Auth error" });
  }
}

// Requiere uno de los roles indicados (case-insensitive)
export function requireRole(...roles) {
  const allow = roles.map((r) => String(r).toLowerCase());
  return (req, res, next) => {
    const rol = String(req?.usuario?.rol || "user").toLowerCase();
    // owner >= admin >= user (mapeo simple)
    const norm = (r) =>
      r === "owner" ? ["owner", "admin"] :
      r === "admin" ? ["admin"] :
      [r];

    const allowed = allow.some((r) => norm(r).includes(rol));
    if (!allow.length || allowed) return next();
    return res.status(403).json({ message: "Permisos insuficientes" });
  };
}

// Exige que venga organizacion_id (desde token o header/query como fallback)
export function requireOrg() {
  return (req, res, next) => {
    let org = req?.usuario?.organizacion_id;
    if (!org) {
      org =
        req.headers["x-org-id"] ||
        req.query?.organizacion_id ||
        req.query?.org_id ||
        null;
      if (org && req.usuario) {
        // Solo setear si existe usuario
        req.usuario.organizacion_id = org;
      }
    }
    req.organizacion_id = org ?? null;
    if (org) return next();
    return res.status(400).json({ message: "organizacion_id requerido" });
  };
}
