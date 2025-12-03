// routes/labs.js — parseo de PDF de laboratorio (veterinaria)
import { Router } from "express";
import multer from "multer";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import pdfParse from "pdf-parse";
import { authenticateToken } from "../middleware/auth.js";
import { getOrgText } from "../utils/org.js";
import { q } from "../utils/db.js";
import { resolveProfile } from "../utils/area.profiles.js";

const router = Router();

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_MB = Number(process.env.UPLOAD_MAX_MB || 10);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => cb(null, safeName(file.originalname)),
});

const uploadPdf = multer({
  storage,
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf") return cb(null, true);
    cb(new Error("Solo se admite PDF"));
  },
});

const cleanStr = (v, max = 140) => {
  if (v == null) return "";
  const out = String(v).trim();
  return out.slice(0, max);
};

const safeName = (orig) => {
  const base = path.basename(orig || "file");
  const clean = base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  return `${Date.now()}_${crypto.randomUUID()}_${clean}`;
};

const resolveBaseURL = (req) => {
  const env = (process.env.PUBLIC_BASE_URL || "").trim();
  if (env) {
    try {
      const u = new URL(env);
      return u.origin;
    } catch {
      /* ignore */
    }
  }
  const xfProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const xfHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const proto = xfProto || req.protocol || "http";
  const host = xfHost || req.get("host");
  return `${proto}://${host}`;
};

async function isPdf(filePath) {
  const fh = await fsp.open(filePath, "r");
  try {
    const buf = Buffer.alloc(4);
    await fh.read({ buffer: buf, offset: 0, length: 4, position: 0 });
    return buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46; // %PDF
  } finally {
    await fh.close();
  }
}

async function loadProfile(orgId) {
  const { rows } = await q(
    `SELECT area, vocab, features, forms FROM org_profiles WHERE organizacion_id=$1 LIMIT 1`,
    [orgId]
  );
  return resolveProfile(rows[0] || {});
}

function normalizeNumber(raw) {
  if (!raw) return "";
  const cleaned = String(raw).trim().replace(",", ".");
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return cleaned.slice(0, 32);
  return String(num);
}

function extractLabData(text, profile) {
  const allowedFields = new Set((profile.forms?.clinicalHistory?.fields || []).map((f) => f.name));
  const matches = [];
  const fields = {};
  const extras = {};
  const signos_vitales = {};

  const patterns = [
    { target: "peso", kind: "vital", rx: /peso\s*[:=]\s*([\d.,]+)/i },
    { target: "temperatura", kind: "vital", rx: /temp(?:eratura)?\s*[:=]\s*([\d.,]+)/i },
    { target: "hematocrito", kind: "field", rx: /hematocrito[^\d]{0,10}([\d.,]+)/i },
    { target: "hemoglobina", kind: "field", rx: /(hemoglobina|hb)[^\d]{0,10}([\d.,]+)/i, group: 2 },
    { target: "leucocitos", kind: "field", rx: /(leucocitos|wbc)[^\d]{0,12}([\d.,]+)/i, group: 2 },
    { target: "plaquetas", kind: "field", rx: /plaquetas[^\d]{0,10}([\d.,]+)/i },
    { target: "glucosa", kind: "field", rx: /glucosa[^\d]{0,10}([\d.,]+)/i },
    { target: "urea", kind: "field", rx: /urea[^\d]{0,10}([\d.,]+)/i },
    { target: "creatinina", kind: "field", rx: /creatinina[^\d]{0,10}([\d.,]+)/i },
    { target: "alt", kind: "field", rx: /(alt|tgp)[^\d]{0,10}([\d.,]+)/i, group: 2 },
    { target: "ast", kind: "field", rx: /(ast|tgo)[^\d]{0,10}([\d.,]+)/i, group: 2 },
    { target: "fosfatasa_alcalina", kind: "field", rx: /(fosfatasa\s+alcalina|alp)[^\d]{0,10}([\d.,]+)/i, group: 2 },
    { target: "proteinas_totales", kind: "field", rx: /(proteinas\s+totales|proteinas)[^\d]{0,10}([\d.,]+)/i, group: 2 },
  ];

  for (const p of patterns) {
    const m = p.rx.exec(text);
    if (!m) continue;
    const raw = m[p.group || 1];
    const val = normalizeNumber(raw);
    matches.push({ target: p.target, raw: cleanStr(raw), value: val });
    if (p.kind === "vital") {
      signos_vitales[p.target] = val;
    } else if (allowedFields.has(p.target)) {
      fields[p.target] = val;
    } else {
      extras[p.target] = val;
    }
  }

  return { fields, extras, signos_vitales, matches };
}

router.post("/parse", authenticateToken, uploadPdf.single("file"), async (req, res) => {
  try {
    const orgId = getOrgText(req, { require: true });
    const profile = await loadProfile(orgId);
    if (profile.area !== "veterinaria") {
      return res.status(400).json({ message: "Solo disponible para la vertical Veterinaria" });
    }
    if (!profile.features?.clinicalHistory) {
      return res.status(403).json({ message: "Historias clinicas deshabilitadas para esta organizacion" });
    }
    if (!profile.features?.labResults) {
      return res.status(403).json({ message: "Carga de laboratorios no habilitada para esta organizacion" });
    }
    if (!req.file) return res.status(400).json({ message: "Archivo PDF requerido" });

    const savedPath = req.file.path;
    const isValidPdf = await isPdf(savedPath).catch(() => false);
    if (!isValidPdf) {
      await fsp.unlink(savedPath).catch(() => {});
      return res.status(400).json({ message: "El archivo no parece ser un PDF valido" });
    }

    let text = "";
    try {
      const parsed = await pdfParse(await fsp.readFile(savedPath));
      text = parsed?.text || "";
    } catch (e) {
      console.error("[/labs/parse] pdf-parse fallo:", e?.message || e);
    }

    if (!text.trim()) {
      return res.status(422).json({ message: "No pude leer texto del PDF. Probá con otro archivo." });
    }

    const extracted = extractLabData(text, profile);

    const base = resolveBaseURL(req);
    const publicUrl = new URL(`/uploads/${req.file.filename}`, base).toString();

    res.json({
      organizacion_id: orgId,
      file: {
        url: publicUrl,
        path: `/uploads/${req.file.filename}`,
        filename: req.file.filename,
        originalname: req.file.originalname,
        size: req.file.size,
      },
      extracted,
      text_excerpt: text.slice(0, 2000),
    });
  } catch (e) {
    console.error("[POST /labs/parse]", e?.stack || e?.message || e);
    res.status(500).json({ message: "No pude procesar el laboratorio" });
  }
});

router.use((err, _req, res, _next) => {
  if (err && err.message?.includes("Solo se admite PDF")) {
    return res.status(400).json({ message: "Solo se admite PDF" });
  }
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ message: `Archivo excede ${MAX_MB}MB` });
  }
  return res.status(500).json({ message: "Error en carga de archivo" });
});

export default router;
