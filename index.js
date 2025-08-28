// index.js — VEX CRM Backend (ESM)
import "dotenv/config";
import express from "express";
import morgan from "morgan";
import fs from "node:fs";
import path from "node:path";
import { applySecurity } from "./middleware/security.js";
import { initDB } from "./utils/db.js";

const app = express();
app.set("trust proxy", true);

// Parsers
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

// Logs
if (process.env.NODE_ENV !== "test") {
  app.use(morgan("tiny"));
}

// Seguridad (CORS + headers)
applySecurity(app);

// Estáticos para estimates
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use("/uploads", express.static(UPLOAD_DIR));

// Migraciones mínimas + catálogo
await initDB();

// Health de respaldo (aunque /health falle al montar)
app.get("/healthz", (_req, res) => res.status(200).json({ ok: true, minimal: true }));

// ===== Helper para montaje tolerante a fallos =====
async function mount(path, modulePath) {
  try {
    const mod = await import(modulePath);
    const router = mod.default || mod.router || mod;
    if (router && typeof router === "function") {
      app.use(path, router);
      console.log(`✅ Ruta montada: ${path} <- ${modulePath}`);
    } else {
      console.warn(`⚠️  ${modulePath} no exporta un router válido. Stub 501 en ${path}`);
      app.use(path, (_req, res) => res.status(501).json({ error: "Ruta no disponible" }));
    }
  } catch (e) {
    console.error(`💥 Error importando ${modulePath}:`, e?.stack || e?.message || e);
    app.use(path, (_req, res) => res.status(500).json({ error: "Ruta falló al cargar" }));
  }
}

// ===== Montaje de rutas (MVP+) =====
await mount("/clientes",       "./routes/clientes.js");
await mount("/categorias",     "./routes/categorias.js");
await mount("/kanban",         "./routes/kanban.js");       // Kanban clientes/tareas + KPIs
await mount("/compras",        "./routes/compras.js");
await mount("/tareas",         "./routes/tareas.js");
await mount("/dashboard",      "./routes/dashboard.js");
await mount("/upload",         "./routes/upload.js");       // Upload de estimates
await mount("/modulos",        "./routes/modulos.js");      // Proxy resiliente a Core (safe)

// Integraciones y automatización (on por pedido)
// - Slack/WhatsApp config
// - Recordatorios CRUD
// - Dispatcher (Slack/WhatsApp)
// - IA insights
await mount("/integraciones",  "./routes/integraciones.js");
await mount("/recordatorios",  "./routes/recordatorios.js");
await mount("/jobs",           "./routes/job.js");
await mount("/ai",             "./routes/ai.js");

await mount("/health",         "./routes/health.js");

// ===== Home / 404 =====
app.get("/", (_req, res) => res.json({ ok: true, service: "vex-crm-backend" }));
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// ===== Handler global de errores =====
/* eslint-disable no-unused-vars */
app.use((err, _req, res, _next) => {
  console.error("🔥 Unhandled error:", err?.stack || err?.message || err);
  res.status(500).json({ error: "Internal error" });
});
/* eslint-enable no-unused-vars */

// ===== Hardening =====
process.on("unhandledRejection", (e) => console.error("UNHANDLED REJECTION:", e));
process.on("uncaughtException",  (e) => console.error("UNCAUGHT EXCEPTION:", e));

// ===== Start =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ VEX CRM en :${PORT}`));
