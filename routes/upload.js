// routes/upload.js — robusto, proxy-aware, con firma mágica
import { Router } from "express";
import multer from "multer";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { authenticateToken } from "../middleware/auth.js";

const router = Router();

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Límite configurable (por defecto 10 MB)
const MAX_MB = Number(process.env.UPLOAD_MAX_MB || 10);

// Whitelist básica
const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "text/plain",
  // "text/csv",
  // "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // docx
  // "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",      // xlsx
]);

/* ------------------------- helpers ------------------------- */
const safeName = (orig) => {
  const base = path.basename(orig || "file");
  const clean = base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  return `${Date.now()}_${crypto.randomUUID()}_${clean}`;
};

function resolveBaseURL(req) {
  const env = (process.env.PUBLIC_BASE_URL || "").trim();
  if (env) {
    try {
      const u = new URL(env);
      return u.origin; // evita duplicar paths
    } catch {
      console.warn("[upload] PUBLIC_BASE_URL inválida:", env);
    }
  }
  // Detrás de proxy usar X-Forwarded-*
  const xfProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const xfHost  = String(req.headers["x-forwarded-host"]  || "").split(",")[0].trim();
  const proto = xfProto || req.protocol || "http";
  const host  = xfHost  || req.get("host");
  return `${proto}://${host}`;
}

// Sniff muy ligero de firma mágica (primeros bytes)
async function sniffMagic(filePath) {
  const fh = await fsp.open(filePath, "r");
  try {
    const buf = Buffer.alloc(16);
    await fh.read({ buffer: buf, offset: 0, length: 16, position: 0 });

    // PDF: %PDF
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return "application/pdf";
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
        buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) return "image/png";
    // JPEG: FF D8 FF
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return "image/jpeg";
    // WEBP: "RIFF" .... "WEBP"
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
    // TXT: no hay firma; dejamos null y validamos por mimetype
    return null;
  } finally {
    await fh.close();
  }
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => cb(null, safeName(file.originalname)),
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) return cb(null, true);
    cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}`));
  },
});

/* ------------------------- routes ------------------------- */
// POST /upload/estimate  (campo: "file")
router.post("/estimate", authenticateToken, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "Archivo requerido" });

  const { filename, path: savedPath, mimetype, originalname, size } = req.file;

  try {
    // Validación extra: firma mágica para binarios soportados
    if (mimetype !== "text/plain") {
      const detected = await sniffMagic(savedPath);
      if (detected && detected !== mimetype) {
        // mimetype declarado no coincide con firma => borrar y rechazar
        await fsp.unlink(savedPath).catch(() => {});
        return res.status(400).json({
          message: `Tipo de archivo inválido: esperado ${detected}, recibido ${mimetype}`,
        });
      }
      // Si no se pudo detectar (null) y no es text/plain, mantenemos la whitelist original.
    }

    const base = resolveBaseURL(req); // respeta proxy o PUBLIC_BASE_URL
    // Asegurate de servir /uploads como estático en index.js
    const publicUrl = new URL(`/uploads/${filename}`, base).toString();

    return res.status(201).json({
      url: publicUrl,               // absoluta (para clic/share)
      path: `/uploads/${filename}`, // relativa para FE interno
      filename,
      originalname,
      mimetype,
      size,
    });
  } catch (e) {
    // Si algo falla post-escritura, intentar limpiar
    await fsp.unlink(savedPath).catch(() => {});
    console.error("[POST /upload/estimate] error:", e?.stack || e?.message || e);
    return res.status(500).json({ message: "Error en carga de archivo" });
  }
});

// Manejo básico de errores de multer (mimetype/size)
router.use((err, _req, res, _next) => {
  if (err && err.message?.startsWith("Tipo de archivo no permitido")) {
    return res.status(400).json({ message: err.message });
  }
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ message: `Archivo excede ${MAX_MB}MB` });
  }
  return res.status(500).json({ message: "Error en carga de archivo" });
});

export default router;
