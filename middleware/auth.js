import jwt from "jsonwebtoken";

// Fallback opcional a Core (si seteás VEX_CORE_URL)
const SECRET_KEY = process.env.JWT_SECRET || "vex-secreta";
const CORE_URL = process.env.VEX_CORE_URL || null;
const VALIDATE_PATH = "/auth/validar"; // debería existir en Core
const CACHE_MS = 60_000;
const tokenCache = new Map();

async function validateWithCore(token) {
  if (!CORE_URL) throw new Error("CORE_URL not set");
  const cached = tokenCache.get(token);
  const now = Date.now();
  if (cached && (now - cached.ts) < CACHE_MS) return cached.payload;

  const resp = await fetch(`${CORE_URL}${VALIDATE_PATH}`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({})
  });
  if (!resp.ok) throw new Error("Core validation failed");
  const data = await resp.json();
  tokenCache.set(token, { payload: data, ts: now });
  return data;
}

export async function authenticateToken(req, res, next) {
  const header = req.headers["authorization"];
  if (!header) return res.status(401).json({ message: "Token requerido" });
  const token = header.split(" ")[1];
  if (!token) return res.status(401).json({ message: "Token requerido" });

  // 1) local
  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    req.usuario_email = decoded.email;
    req.organizacion_id = decoded.organizacion_id ?? decoded.organization_id;
    req.rol = decoded.rol || "user";
    return next();
  } catch { /* sigue */ }

  // 2) fallback Core (si está configurado)
  try {
    const payload = await validateWithCore(token);
    req.usuario_email = payload.email;
    req.organizacion_id = payload.organizacion_id ?? payload.organization_id;
    req.rol = payload.rol || "user";
    return next();
  } catch {
    return res.status(403).json({ message: "Token inválido" });
  }
}
