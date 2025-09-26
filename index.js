// index.js — VEX CRM Backend (ESM)
import "dotenv/config";
import express from "express";
import morgan from "morgan";
import fs from "node:fs";
import path from "node:path";
import { applySecurity } from "./middleware/security.js";
import { initDB } from "./utils/db.js";

// ✅ Defaults útiles (no pisan Railway)
process.env.SLACK_WEBHOOK_FALLBACK_CHANNEL ??= "#reminders-and-follow-ups";
process.env.REMINDER_CRON ??= "*/10 * * * *";

import { scheduleReminders } from "./workers/reminders.worker.js";

const app = express();
app.set("trust proxy", true);

// Parsers
app.use(express.json({ limit: process.env.JSON_LIMIT || "1mb" }));
app.use(express.urlencoded({ extended: false }));

// Logs
if (process.env.NODE_ENV !== "test") {
  app.use(morgan(process.env.LOG_FORMAT || "tiny"));
}

// Seguridad (CORS + headers)
applySecurity(app);

// Estáticos para estimates
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use("/uploads", express.static(UPLOAD_DIR));

/* ───────── Health & readiness ───────── */
let dbReady = false;
app.get("/healthz", (_req, res) => res.status(200).json({ ok: true, minimal: true }));
app.get("/readyz", (_req, res) =>
  dbReady ? res.json({ ok: true }) : res.status(503).json({ ok: false, dbReady })
);

/* ───────── Migraciones mínimas + catálogo ───────── */
try {
  await initDB();
  dbReady = true;
} catch (e) {
  console.error("💥 initDB() falló:", e?.stack || e?.message || e);
  // seguimos levantando el server; /readyz devolverá 503 hasta que esté OK
}

/* ───────── Helper de montaje tolerante ───────── */
async function mount(pathname, modulePath) {
  try {
    const mod = await import(modulePath);
    const router = mod.default || mod.router || mod; // soporta default/named
    if (router && typeof router === "function") {
      app.use(pathname, router);
      console.log(`✅ Ruta montada: ${pathname} <- ${modulePath}`);
    } else {
      console.warn(`⚠️  ${modulePath} no exporta un router válido. Stub 501 en ${pathname}`);
      app.use(pathname, (_req, res) => res.status(501).json({ error: "Ruta no disponible" }));
    }
  } catch (e) {
    console.error(`💥 Error importando ${modulePath}:`, e?.stack || e?.message || e);
    app.use(pathname, (_req, res) => res.status(500).json({ error: "Ruta falló al cargar" }));
  }
}

/* ───────── Montaje de rutas ───────── */
await mount("/clientes",       "./routes/clientes.js");
await mount("/proyectos",      "./routes/proyectos.js");          // pipeline basado en proyectos
await mount("/proyectos",      "./routes/proyectos.assign.js");   // reasignación + follow-up
await mount("/proveedores",    "./routes/proveedores.js");        // proveedores/subcontratistas

// Legacy/compat
await mount("/compras",        "./routes/compras.js");

// CRM utilidades
await mount("/categorias",     "./routes/categorias.js");
await mount("/kanban",         "./routes/kanban.js");      // Kanban + KPIs
await mount("/tareas",         "./routes/tareas.js");
await mount("/dashboard",      "./routes/dashboard.js");

// KPIs consolidados
await mount("/analytics",      "./routes/analytics.js");

// Integraciones y otros
await mount("/upload",         "./routes/upload.js");
await mount("/modulos",        "./routes/modulos.js");
await mount("/integraciones",  "./routes/integraciones.js");
// Ojo con el nombre del archivo real:
await mount("/jobs",           "./routes/job.js");         // <- si tu archivo es jobs.js, cambiá este path
await mount("/ai",             "./routes/ai.js");
await mount("/health",         "./routes/health.js");

// 🔌 Endpoint público (funnel web → leads)
await mount("/web",            "./routes/web.js");

/* ───────── Home / 404 / errores ───────── */
app.get("/", (_req, res) => res.json({ ok: true, service: "vex-crm-backend" }));
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// Handler global
/* eslint-disable no-unused-vars */
app.use((err, _req, res, _next) => {
  console.error("🔥 Unhandled error:", err?.stack || err?.message || err);
  res.status(500).json({ error: "Internal error" });
});
/* eslint-enable no-unused-vars */

// Hardening
process.on("unhandledRejection", (e) => console.error("UNHANDLED REJECTION:", e));
process.on("uncaughtException",  (e) => console.error("UNCAUGHT EXCEPTION:", e));

/* ───────── Schedulers ───────── */
scheduleReminders();
console.log(
  `🕒 Reminders ON cron=${process.env.REMINDER_CRON} tz=America/Argentina/Mendoza | fallbackChannel=${process.env.SLACK_WEBHOOK_FALLBACK_CHANNEL || "(none)"}`
);

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ VEX CRM en :${PORT} | dbReady=${dbReady}`));
