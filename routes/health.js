// routes/health.js — liveness/readiness + status extendido (sin auth)
import { Router } from "express";
import { q } from "../utils/db.js";
import { nocache } from "../middleware/nocache.js";

const router = Router();

/* ------------------------ helpers ------------------------ */
async function regclassExists(name) {
  try {
    const r = await q(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${name}`]);
    return !!r.rows?.[0]?.ok;
  } catch {
    return false;
  }
}

async function dbPingAndTables() {
  const t0 = Date.now();
  const out = { ok: false, latency_ms: null, tables: {} };
  try {
    await q("SELECT 1");
    out.ok = true;
    out.latency_ms = Date.now() - t0;
  } catch (e) {
    out.ok = false;
    out.error = (e && (e.message || e.code)) || "db_error";
    return out; // si ping falla, evitamos más queries
  }

  // Chequeos de tablas clave (mejor esfuerzo)
  const names = [
    "clientes",
    "tareas",
    "proyectos",
    "invoices",
    "categorias",
    "compras",
    "compra_items",
    "slack_users",
    "integraciones",
  ];
  for (const n of names) {
    out.tables[n] = await regclassExists(n);
  }
  return out;
}

function mem() {
  const mu = process.memoryUsage();
  const mb = (n) => Math.round((n / (1024 * 1024)) * 10) / 10;
  return {
    rss_mb: mb(mu.rss),
    heap_used_mb: mb(mu.heapUsed),
    heap_total_mb: mb(mu.heapTotal),
    external_mb: mb(mu.external ?? 0),
  };
}

/* -------------------------- /health -------------------------- */
// Informativo (siempre 200). Útil para humanos/monitoreo básico.
router.get("/", nocache, async (_req, res) => {
  const now = new Date().toISOString();
  const uptime_sec = Math.round(process.uptime());

  const version = process.env.APP_VERSION || process.env.npm_package_version || null;
  const git_sha = process.env.GIT_SHA || null;
  const env = process.env.NODE_ENV || "development";
  const tz = process.env.TZ || "UTC";

  const features = {
    reminder_cron: process.env.REMINDER_CRON || null,
    invoice_reminder_cron: process.env.INVOICE_REMINDER_CRON || null,
  };

  let db = { ok: false, latency_ms: null, tables: {} };
  try {
    db = await dbPingAndTables();
  } catch (e) {
    db = { ok: false, error: (e && (e.message || e.code)) || "db_error" };
  }

  res.status(200).json({
    ok: true,
    service: "vex-crm-backend",
    now,
    pid: process.pid,
    uptime_sec,
    env,
    tz,
    version,
    git_sha,
    node: { version: process.version, platform: process.platform },
    memory: mem(),
    features,
    db,
  });
});

/* -------------------------- /live --------------------------- */
// Liveness: si el proceso responde, 200.
router.get("/live", nocache, (_req, res) => {
  res.status(200).json({
    ok: true,
    pid: process.pid,
    uptime_sec: Math.round(process.uptime()),
  });
});

/* -------------------------- /ready -------------------------- */
// Readiness real: debe poder hablar con la DB y ver tablas mínimas.
// Devuelve 503 si no está listo (para probes de orquestadores).
router.get("/ready", nocache, async (_req, res) => {
  try {
    const t0 = Date.now();
    await q("SELECT 1");
    const latency = Date.now() - t0;

    const hasClientes = await regclassExists("clientes");
    const hasTareas   = await regclassExists("tareas");
    const ready = hasClientes && hasTareas;

    const payload = {
      ok: ready,
      db: { ok: true, latency_ms: latency },
      tables: { clientes: hasClientes, tareas: hasTareas },
    };

    if (!ready) return res.status(503).json(payload);
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(503).json({
      ok: false,
      db: { ok: false, error: (e && (e.message || e.code)) || "db_error" },
    });
  }
});

/* -------------------------- HEAD --------------------------- */
// Para probes que usan HEAD lightweight.
router.head("/", (_req, res) => res.status(204).end());
router.head("/live", (_req, res) => res.status(204).end());
router.head("/ready", (_req, res) => res.status(204).end());

export default router;
