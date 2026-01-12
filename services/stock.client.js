// services/stock.client.js
import axios from "axios";

const BASE = (process.env.STOCK_BASE_URL || "https://vex-backend-production.up.railway.app").replace(/\/+$/, "");
const DEFAULT_TIMEOUT = Number(process.env.STOCK_TIMEOUT_MS || 8000);

function extractToken(req) {
  const auth = req.headers?.authorization || req.headers?.Authorization;
  if (auth && typeof auth === "string") {
    const parts = auth.split(" ");
    if (parts.length === 2 && /^Bearer$/i.test(parts[0])) return parts[1];
  }
  const x1 = req.headers?.["x-vex-token"] || req.headers?.["x-auth-token"];
  if (x1 && typeof x1 === "string") return x1;
  const fromQuery = req.query?.vex_token || req.query?.token;
  if (fromQuery) return String(fromQuery);
  return null;
}

function buildAuthHeader(req) {
  const token = extractToken(req);
  if (!token) return null;
  return token.startsWith("Bearer ") ? token : `Bearer ${token}`;
}

export async function stockRequest(req, { method, path, params, data, timeout } = {}) {
  if (!BASE) throw new Error("STOCK_BASE_URL no configurado");
  const auth = buildAuthHeader(req);
  if (!auth) throw new Error("Token requerido para Stock");

  const url = `${BASE}${path}`;
  const response = await axios({
    method,
    url,
    params,
    data,
    timeout: Number(timeout || DEFAULT_TIMEOUT),
    headers: {
      Authorization: auth,
      Accept: "application/json",
    },
  });
  return response;
}

export function stockBaseUrl() {
  return BASE;
}
