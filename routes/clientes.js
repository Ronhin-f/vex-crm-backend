// routes/clientes.js
import { Router } from "express";
import { q } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";

const router = Router();

/* ------------------------ helpers ------------------------ */
function getUserFromReq(req) {
  const u = req.usuario || {};
  return {
    email:
      u.email ??
      req.usuario_email ??
      u.usuario_email ??
      null,
    organizacion_id:
      u.organizacion_id ??
      req.organizacion_id ??
      u.organization_id ??
      null,
  };
}

function coerceText(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function coerceDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function isTruthy(v) {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "t" || s === "yes" || s === "y" || s === "on";
}

/* ========================= GET ========================== */
/**
 * Listado de clientes de la organización.
 * Filtros opcionales (query):
 *  - stage, assignee, source, only_due (1|true)
 *  - q (busca en nombre/email/telefono)
 */
router.get("/", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id } = getUserFromReq(req);
    const { stage, assignee, source, q: qtext, only_due } = req.query || {};

    const params = [];
    const where = [];

    if (organizacion_id) {
      params.push(organizacion_id);
      where.push(`organizacion_id = $${params.length}`);
    }
    if (stage) {
      params.push(String(stage));
      where.push(`stage = $${params.length}`);
    }
    if (assignee) {
      // "Sin asignar" / "unassigned" => NULL o vacío
      if (/^(sin asignar|unassigned)$/i.test(String(assignee))) {
        where.push(`(assignee IS NULL OR TRIM(assignee) = '')`);
      } else {
        params.push(String(assignee));
        where.push(`assignee = $${params.length}`);
      }
    }
    if (source) {
      params.push(String(source));
      where.push(`source = $${params.length}`);
    }
    if (qtext) {
      // Un solo parámetro para las tres columnas (Postgres permite reutilizar $idx)
      const qval = `%${String(qtext).trim()}%`;
      params.push(qval);
      const idx = params.length;
      where.push(
        `(nombre ILIKE $${idx} OR email ILIKE $${idx} OR telefono ILIKE $${idx})`
      );
    }
    if (isTruthy(only_due)) {
      where.push(`due_date IS NOT NULL`);
    }

    const sql = `
      SELECT
        id, nombre, email, telefono,
        stage, categoria, assignee, source, due_date,
        contacto_nombre,
        estimate_url, estimate_file, estimate_uploaded_at,
        organizacion_id, created_at,
        assignee    AS assignee_email,  -- alias para FE
        observacion AS contact_info     -- alias para FE
      FROM clientes
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY created_at DESC NULLS LAST, id DESC
    `;

    const r = await q(sql, params);
    res.json(r.rows || []);
  } catch (e) {
    console.error("[GET /clientes]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error listando clientes" });
  }
});

/* ======================== POST ========================== */
/**
 * Crea cliente.
 * Body mínimo: { nombre }
 * Opcionales: email, telefono, stage | categoria, assignee|assignee_email, source, due_date,
 *             contacto_nombre, contact_info, estimate_url
 */
router.post("/", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id, email: usuario_email } = getUserFromReq(req);
    let {
      nombre,
      email = null,
      telefono = null,
      stage = null,
      categoria = null,     // back-compat
      assignee = null,
      assignee_email = null, // alias desde FE
      source = null,
      due_date = null,
      contacto_nombre = null,
      contact_info = null,   // alias → observacion
      estimate_url = null,
    } = req.body || {};

    if (!nombre || typeof nombre !== "string" || !nombre.trim()) {
      return res.status(400).json({ message: "Nombre requerido" });
    }

    nombre = nombre.trim();
    email = coerceText(email);
    telefono = coerceText(telefono);
    assignee = coerceText(assignee) || coerceText(assignee_email);
    source = coerceText(source);
    contacto_nombre = coerceText(contacto_nombre);
    const observacion = coerceText(contact_info);
    estimate_url = coerceText(estimate_url);
    stage = coerceText(stage) || coerceText(categoria); // preferimos stage

    const r = await q(
      `
      INSERT INTO clientes
        (nombre, email, telefono, stage, categoria, assignee, source, due_date,
         contacto_nombre, observacion, estimate_url, usuario_email, organizacion_id)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8,
         $9, $10, $11, $12, $13)
      RETURNING id, nombre, email, telefono, stage, categoria, assignee, source, due_date,
                contacto_nombre, estimate_url, estimate_file, estimate_uploaded_at,
                organizacion_id, created_at,
                assignee AS assignee_email,
                observacion AS contact_info
      `,
      [
        nombre, email, telefono, stage, categoria, assignee, source,
        coerceDate(due_date), contacto_nombre, observacion, estimate_url, usuario_email, organizacion_id
      ]
    );

    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error("[POST /clientes]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error creando cliente" });
  }
});

/* ======================== PATCH ========================= */
/**
 * Update parcial.
 * Campos permitidos:
 *  nombre, email, telefono, stage, categoria, assignee|assignee_email, source, due_date,
 *  contacto_nombre, estimate_url, contact_info (alias -> observacion)
 */
router.patch("/:id", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });

    const allowed = new Set([
      "nombre","email","telefono",
      "stage","categoria","assignee","assignee_email","source","due_date",
      "contacto_nombre","estimate_url","contact_info"
    ]);

    const fields = [];
    const values = [];
    let idx = 1;

    const push = (dbField, val) => {
      fields.push(`${dbField} = $${idx++}`);
      values.push(val);
    };

    for (const [k, raw] of Object.entries(req.body || {})) {
      if (!allowed.has(k)) continue;

      if (k === "assignee_email") {
        push("assignee", coerceText(raw));                // alias
      } else if (k === "contact_info") {
        push("observacion", coerceText(raw));             // alias
      } else if (k === "due_date") {
        push("due_date", coerceDate(raw));
      } else if (k === "nombre" || k === "email" || k === "telefono" ||
                 k === "stage" || k === "categoria" || k === "assignee" ||
                 k === "source" || k === "contacto_nombre" || k === "estimate_url") {
        push(k, coerceText(raw));
      }
    }

    if (!fields.length) return res.status(400).json({ message: "Nada para actualizar" });

    values.push(id);
    const r = await q(
      `UPDATE clientes SET ${fields.join(", ")} WHERE id = $${idx}
       RETURNING id, nombre, email, telefono, stage, categoria, assignee, source, due_date,
                 contacto_nombre, estimate_url, estimate_file, estimate_uploaded_at,
                 organizacion_id, created_at,
                 assignee AS assignee_email,
                 observacion AS contact_info`,
      values
    );
    if (!r.rowCount) return res.status(404).json({ message: "Cliente no encontrado" });

    res.json(r.rows[0]);
  } catch (e) {
    console.error("[PATCH /clientes/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error actualizando cliente" });
  }
});

/* ==================== PATCH stage (one-click) ==================== */
/**
 * Move one-click del pipeline.
 * Path: PATCH /clientes/:id/stage
 * Body: { stage: "Qualified" }  (si viene categoria, también la espejamos)
 */
router.patch("/:id/stage", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });

    const newStage = coerceText(req.body?.stage) || coerceText(req.body?.categoria);
    if (!newStage) return res.status(400).json({ message: "stage requerido" });

    const r = await q(
      `UPDATE clientes
         SET stage = $1,
             categoria = $1
       WHERE id = $2
       RETURNING id, nombre, email, telefono, stage, categoria, assignee, source, due_date,
                 contacto_nombre, estimate_url, estimate_file, estimate_uploaded_at,
                 organizacion_id, created_at,
                 assignee AS assignee_email,
                 observacion AS contact_info`,
      [newStage, id]
    );
    if (!r.rowCount) return res.status(404).json({ message: "Cliente no encontrado" });

    res.json(r.rows[0]);
  } catch (e) {
    console.error("[PATCH /clientes/:id/stage]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error moviendo de etapa" });
  }
});

/* ================== PATCH estimate (file/url) =================== */
/**
 * Adjunta estimate al cliente.
 * - Si viene { estimate_url }, se guarda URL.
 * - Si viene { filename }, se guarda como file público en /uploads + marca de tiempo.
 * Body: { estimate_url?: string, filename?: string }
 */
router.patch("/:id/estimate", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });

    const base = req.body?.estimate_url ? coerceText(req.body.estimate_url) : null;
    const filename = req.body?.filename ? coerceText(req.body.filename) : null;

    if (!base && !filename) {
      return res.status(400).json({ message: "estimate_url o filename requerido" });
    }

    let estimate_url = base;
    let estimate_file = null;
    let estimate_uploaded_at = null;

    if (filename) {
      // Si nos pasan filename desde /upload/estimate
      const publicBase = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
      estimate_file = filename;
      estimate_url = new URL(`/uploads/${filename}`, publicBase).toString();
      estimate_uploaded_at = new Date().toISOString();
    }

    const r = await q(
      `UPDATE clientes
         SET estimate_url = $1,
             estimate_file = $2,
             estimate_uploaded_at = $3
       WHERE id = $4
       RETURNING id, nombre, email, telefono, stage, categoria, assignee, source, due_date,
                 contacto_nombre, estimate_url, estimate_file, estimate_uploaded_at,
                 organizacion_id, created_at,
                 assignee AS assignee_email,
                 observacion AS contact_info`,
      [estimate_url, estimate_file, estimate_uploaded_at, id]
    );

    if (!r.rowCount) return res.status(404).json({ message: "Cliente no encontrado" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error("[PATCH /clientes/:id/estimate]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error adjuntando estimate" });
  }
});

/* ========================= DELETE ======================== */
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });

    const r = await q(`DELETE FROM clientes WHERE id = $1`, [id]);
    if (!r.rowCount) return res.status(404).json({ message: "Cliente no encontrado" });
    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /clientes/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error eliminando cliente" });
  }
});

export default router;
