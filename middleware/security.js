// backend/middleware/security.js
import helmet from "helmet";

/* =========================
 *  Helpers CORS
 * ========================= */
function parseOrigins() {
  const raw = process.env.CORS_ORIGIN || "*";
  return new Set(
    raw.split(",").map((s) => s.trim()).filter(Boolean)
  );
}

// Soporte de comodines: "*.dominio.com" o "https://*.vercel.app"
function matchOrigin(origin, pat) {
  if (!origin || !pat) return false;
  if (pat === "*" || pat === origin) return true;
  if (pat.startsWith("*.")) return origin.endsWith(pat.slice(1)); // ".dominio.com"
  if (pat.includes("*")) {
    const [pre, suf] = pat.split("*");
    return origin.startsWith(pre) && origin.endsWith(suf);
  }
  return false;
}

export function applySecurity(app) {
  app.disable("x-powered-by");

  /* =========================
   *  CORS robusto + preflight
   * ========================= */
  const allowList = parseOrigins();

  app.use((req, res, next) => {
    const origin = req.headers.origin || "";

    let allowOrigin = "";
    if (allowList.has("*")) {
      allowOrigin = "*";
      // OJO: con "*" NO se puede mandar Allow-Credentials
    } else if ([...allowList].some((p) => matchOrigin(origin, p))) {
      allowOrigin = origin; // eco del origin permitido
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }

    if (allowOrigin) {
      res.setHeader("Access-Control-Allow-Origin", allowOrigin);
      res.setHeader("Vary", "Origin");
    }

    // Respeta lo que pide el preflight si viene; defaults seguros si no
    res.setHeader(
      "Access-Control-Allow-Headers",
      req.headers["access-control-request-headers"] ||
        "Content-Type, Authorization, X-Requested-With, Accept, Origin"
    );
    res.setHeader(
      "Access-Control-Allow-Methods",
      req.headers["access-control-request-method"] ||
        "GET,POST,PUT,PATCH,DELETE,OPTIONS"
    );
    // Cachea el preflight 24h en el navegador
    res.setHeader("Access-Control-Max-Age", "86400");

    // Exponer headers útiles (descargas/paginación)
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, X-Total-Count");

    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  /* =========================
   *  Helmet / hardening
   * ========================= */
  app.use(
    helmet({
      frameguard: { action: "deny" },
      referrerPolicy: { policy: "no-referrer" },
      contentSecurityPolicy: false, // si hace falta, se configura después
      crossOriginResourcePolicy: { policy: "cross-origin" }, // no bloquear /uploads
      crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
    })
  );

  // Extra seguro y compatible
  app.use((_, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
}
