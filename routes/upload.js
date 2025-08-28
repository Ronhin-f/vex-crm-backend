// routes/upload.js
import { Router } from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { authenticateToken } from "../middleware/auth.js";

const router = Router();

const UPLOAD_DIR =
  process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Límite configurable (por defecto 10 MB)
const MAX_MB = Number(process.env.UPLOAD_MAX_MB || 10);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    // Sanea el nombre (evita traversal y caracteres raros)
    const base = path.basename(file.originalname);
    const safe = base.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}_${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_MB * 1024 * 1024 },
});

// POST /upload/estimate  (campo: "file")
router.post("/estimate", authenticateToken, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ message: "Archivo requerido" });

  const filename = req.file.filename;

  // URL absoluta del archivo (sirviendo /uploads como estático en index.js)
  const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  const publicUrl = new URL(`/uploads/${filename}`, base).toString();

  return res.status(201).json({
    url: publicUrl,
    filename,
    originalname: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size,
  });
});

export default router;
