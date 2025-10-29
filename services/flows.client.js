// services/flows.client.js
import axios from "axios";

const BASE = (process.env.FLOWS_BASE_URL || "").replace(/\/+$/, "");
const CORE_MACHINE_TOKEN = process.env.CORE_MACHINE_TOKEN || ""; // token emitido por Core (service)

function normalizeBearer(b) {
  if (!b) return null;
  return b.startsWith("Bearer ") ? b : `Bearer ${b}`;
}

export async function emit(type, payload, { bearer } = {}) {
  if (!BASE) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[Flows] skip emit; falta FLOWS_BASE_URL");
    }
    return { skipped: true };
  }

  // 1) Preferir el bearer del request (passthrough), 2) fallback a token de máquina de Core
  const authHeader = normalizeBearer(bearer) || normalizeBearer(CORE_MACHINE_TOKEN);
  if (!authHeader) {
    console.warn("[Flows] skip emit; falta Authorization (req) y CORE_MACHINE_TOKEN");
    return { skipped: true };
  }

  const { data } = await axios.post(
    `${BASE}/api/triggers/emit`,
    { type, payload },
    { headers: { Authorization: authHeader }, timeout: 8000 }
  );
  return data;
}

export async function health() {
  if (!BASE) return { ok: false, reason: "no_base" };
  try {
    const r = await axios.get(`${BASE}/health`, { timeout: 4000 });
    return { ok: r.status === 200 };
  } catch (e) {
    return { ok: false, reason: e?.message || "error" };
  }
}
