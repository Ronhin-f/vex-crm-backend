// backend/middleware/auth.js (ESM)
import jwt from "jsonwebtoken";

// === Config ===
const SECRET_KEY = process.env.JWT_SECRET || "vex-secreta";
const CORE_URL = process.env.VEX_CORE_URL || null;
const VALIDATE_PATH = process.env.CORE_VALIDATE_PATH || "/auth/validar";
const CACHE_MS = Number(process.env.CORE_CACHE_MS || 60_000);
const CLOCK_TOLERANCE = Number(process.env.JWT_CLOCK_TOLERANCE || 30); // seg
const MAX_CACHE_ENTRIES = Number(process.env.CORE_CACHE_MAX || 500);

// Node 18+ tiene fetch global
const tokenCache = new Map(); // token -> { payload, ts }

// === Utils ===
function evictIfNeeded() {
  if (tokenCache.size <= MAX_CACHE_ENTRIES) return;
  // Evicción FIFO simple
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
  // 2) Query bridge (?vex_token= / ?token=)
  const fromQuery = req.query?.vex_token || req.query?.token;
  if (fromQuery) return String(fromQuery);
  // 3) Cookie "token"
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

  return {
    email,
    organizacion_id,
    rol,
    sub,
    payload,
  };
}

async function validateWithCore(token) {
  if (!CORE_URL) throw new Error("CORE_URL not set");
  const cached = cacheGet(token);
  if (cached) return cached;

  const url = `${CORE_URL.replace(/\/+$/, "")}${VALIDATE_PATH}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  if (!resp.ok) {
    throw new Error(`Core validation failed (${resp.status})`);
  }
  const data = await resp.json();
  cacheSet(token, data);
  return data;
}

// === Middlewares ===
export async function authenticateToken(req, res, next) {
  try {
    const token = readToken(req);
    if (!token) return res.status(401).json({ message: "Token requerido" });

    // 1) Verificación local
    try {
      const decoded = jwt.verify(token, SECRET_KEY, {
        algorithms: ["HS256"],
        clockTolerance: CLOCK_TOLERANCE,
      });
      req.usuario = normalizeUser(decoded);
      return next();
    } catch {
      // sigue a Core
    }

    // 2) Fallback a Core (si está configurado)
    try {
      const payload = await validateWithCore(token);
      req.usuario = normalizeUser(payload);
      return next();
    } catch (e) {
      return res.status(403).json({ message: "Token inválido", detail: "core" });
    }
  } catch (e) {
    console.error("auth error:", e?.stack || e?.message || e);
    return res.status(500).json({ message: "Auth error" });
  }
}

// Requiere uno de los roles indicados (case-insensitive)
export function requireRole(...roles) {
  const allow = roles.map(r => String(r).toLowerCase());
  return (req, res, next) => {
    const rol = String(req?.usuario?.rol || "user").toLowerCase();
    if (!allow.length || allow.includes(rol)) return next();
    return res.status(403).json({ message: "Permisos insuficientes" });
  };
}

// Exige que venga organizacion_id en el token
export function requireOrg() {
  return (req, res, next) => {
    const org = req?.usuario?.organizacion_id;
    if (org) return next();
    return res.status(400).json({ message: "organizacion_id requerido en token" });
  };
}
