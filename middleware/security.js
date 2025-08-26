import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

const ALLOWED_ORIGINS = [
  "https://vex-core-frontend.vercel.app",
  "https://vex-crm-frontend.vercel.app"
];

export function applySecurity(app) {
  app.use(helmet());
  app.set("trust proxy", 1);
  app.use(rateLimit({ windowMs: 60_000, max: 300 })); // 300 req/min/IP

  app.use(cors({
    origin: (origin, cb) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      cb(new Error("❌ CORS: Origin no permitido: " + origin));
    },
    credentials: true,
    allowedHeaders: ["Authorization", "Content-Type"]
  }));
}
