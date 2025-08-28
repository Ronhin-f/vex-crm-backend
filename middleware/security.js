// backend/middleware/security.js
import helmet from "helmet";

export function applySecurity(app) {
  app.disable("x-powered-by");

  // ---- CORS configurable ----
  const origins = (process.env.CORS_ORIGIN || "*")
    .split(",")
    .map(o => o.trim())
    .filter(Boolean);

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origins.includes("*") || origins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin || "*");
    }
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization"
    );
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,PATCH,DELETE,OPTIONS"
    );
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // ---- Helmet para hardening básico ----
  app.use(
    helmet({
      frameguard: { action: "deny" },
      referrerPolicy: { policy: "no-referrer" },
      contentSecurityPolicy: false, // lo podés activar más adelante
    })
  );

  // Extra manuales (por compatibilidad)
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
}
