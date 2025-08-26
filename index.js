// Backend/index.js
import express from "express";
import dotenv from "dotenv";
import { applySecurity } from "./middleware/security.js";
import { initDB } from "./utils/db.js";

import clientes from "./routes/clientes.js";
import pedidos from "./routes/pedidos.js";
import tareas from "./routes/tareas.js";
import dashboard from "./routes/dashboard.js";
import health from "./routes/health.js";
import modulos from "./routes/modulos.js";
import integraciones from "./routes/integraciones.js";
import recordatorios from "./routes/recordatorios.js";
import jobs from "./routes/job.js"; // <— nombre correcto

dotenv.config();

const app = express();
app.use(express.json());
applySecurity(app);

// funcional
app.use("/clientes", clientes);
app.use("/pedidos", pedidos);
app.use("/tareas", tareas);
app.use("/dashboard", dashboard);

// infra
app.use("/modulos", modulos);            // opcional si consultás Core
app.use("/integraciones", integraciones);
app.use("/recordatorios", recordatorios);
app.use("/jobs", jobs);
app.use("/health", health);

const PORT = process.env.PORT || 3000;

(async () => {
  await initDB();
  app.listen(PORT, () => console.log(`✅ VEX CRM en :${PORT}`));
})();
