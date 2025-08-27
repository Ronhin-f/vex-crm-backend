// index.js — VEX CRM Backend
import "dotenv/config";
import express from "express";
import { applySecurity } from "./middleware/security.js";
import { initDB } from "./utils/db.js";

const app = express();
app.set("trust proxy", true);
app.use(express.json());
applySecurity(app);

// Migraciones mínimas + catálogo de categorías
await initDB();

// ===== Helpers para montar rutas con tolerancia a fallos =====
async function mount(path, modulePath) {
  try {
    const mod = await import(modulePath);
    const router = mod.default || mod.router || mod;
    if (router && typeof router === "function") {
      app.use(path, router);
      console.log(`✅ Ruta montada: ${path} <- ${modulePath}`);
    } else {
      console.warn(`⚠️  ${modulePath} no exporta un router válido. Montando stub 501 en ${path}`);
      app.use(path, (_req, res) => res.status(501).json({ error: "Ruta no disponible" }));
    }
  } catch (e) {
    console.error(`💥 Error importando ${modulePath}:`, e?.stack || e?.message || e);
    app.use(path, (_req, res) => res.status(500).json({ error: "Ruta falló al cargar" }));
  }
}

// ===== Montaje de rutas =====
await mount("/clientes",       "./routes/clientes.js");
await mount("/categorias",     "./routes/categorias.js");   // << NUEVO
await mount("/pedidos",        "./routes/pedidos.js");
await mount("/tareas",         "./routes/tareas.js");
await mount("/dashboard",      "./routes/dashboard.js");
await mount("/modulos",        "./routes/modulos.js");
await mount("/integraciones",  "./routes/integraciones.js");
await mount("/recordatorios",  "./routes/recordatorios.js");
await mount("/jobs",           "./routes/job.js");
await mount("/health",         "./routes/health.js");

// ===== Home / 404 =====
app.get("/", (_req, res) => res.json({ ok: true, service: "vex-crm-backend" }));
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// ===== Hardening =====
process.on("unhandledRejection", (e) => console.error("UNHANDLED REJECTION:", e));
process.on("uncaughtException", (e) => console.error("UNCAUGHT EXCEPTION:", e));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ VEX CRM en :${PORT}`));
