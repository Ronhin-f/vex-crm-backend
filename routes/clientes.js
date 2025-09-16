// routes/clientes.js
import { Router } from "express";
import { q } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";

const router = Router();

/* ------------------------ helpers ------------------------ */
function getUserFromReq(req) {
  const u = req.usuario || {};
  return {
    email: u.email ?? req.usuario_email ?? u.usuario_email ?? null,
    organizacion_id: u.organizacion_id ?? req.organizacion_id ?? u.organization_id ?? null,
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

/* ========================= GET ========================== */
/**
 * Listado de clientes (con filtros opcionales):
 *  - stage, assignee, source
 *  - q (nombre/email/telefono) — telefono casteado a TEXT por compat
 */
router.get("/", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id } = getUserFromReq(req);
    const { stage, assignee, source, q: qtext } = req.query || {};

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
      params.push(String(assignee));
      where.push(`assignee = $${params.length}`);
    }
    if (source) {
      params.push(String(source));
      where.push(`source = $${params.length}`);
    }
    if (qtext) {
      const qval = `%${String(qtext).trim()}%`;
      params.push(qval);
      const idx = params.length;
      // telefono casteado a TEXT por si es numérico en DB viejas
      where.push(
        `(nombre ILIKE $${idx} OR email ILIKE $${idx} OR CAST(telefono AS TEXT) ILIKE $${idx})`
      );
    }

    // order-by seguro si falta created_at
    const rCols = await q(
      `SELECT 1
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='clientes' AND column_name='created_at'`
    );
    const orderBy = rCols.rowCount > 0
      ? "created_at DESC NULLS LAST, id DESC"
      : "id DESC";

    const sql = `
      SELECT
        id, nombre, email, telefono,
        stage, categoria, assignee, source, due_date,
        contacto_nombre,
        estimate_url, estimate_file, estimate_uploaded_at,
        organizacion_id, created_at
      FROM clientes
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY ${orderBy}
    `;

    const r = await q(sql, params);
    return res.json(r.rows || []);
  } catch (e) {
    console.error("[GET /clientes]", e?.stack || e?.message || e);
    // Degradamos a 200 [] para no romper el Kanban del FE
    return res.status(200).json([]);
  }
});

/* ======================== POST ========================== */
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
      source = null,
      due_date = null,
      contacto_nombre = null,
      estimate_url = null,
    } = req.body || {};

    if (!nombre || typeof nombre !== "string" || !nombre.trim()) {
      return res.status(400).json({ message: "Nombre requerido" });
    }

    nombre = nombre.trim();
    email = coerceText(email);
    telefono = coerceText(telefono);
    assignee = coerceText(assignee);
    source = coerceText(source);
    contacto_nombre = coerceText(contacto_nombre);
    estimate_url = coerceText(estimate_url);
    stage = coerceText(stage) || coerceText(categoria); // preferimos stage

    const r = await q(
      `
      INSERT INTO clientes
        (nombre, email, telefono, stage, categoria, assignee, source, due_date,
         contacto_nombre, estimate_url, usuario_email, organizacion_id)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8,
         $9, $10, $11, $12)
      RETURNING id, nombre, email, telefono, stage, categoria, assignee, source, due_date,
                contacto_nombre, estimate_url, estimate_file, estimate_uploaded_at,
                organizacion_id, created_at
      `,
      [
        nombre, email, telefono, stage, categoria, assignee, source,
        coerceDate(due_date), contacto_nombre, estimate_url, usuario_email, organizacion_id
      ]
    );

    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error("[POST /clientes]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error creando cliente" });
  }
});

/* ======================== PATCH ========================= */
router.patch("/:id", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });

    const allowed = [
      "nombre","email","telefono",
      "stage","categoria","assignee","source","due_date",
      "contacto_nombre","estimate_url"
    ];

    const fields = [];
    const values = [];
    let idx = 1;

    for (const k of allowed) {
      if (k in req.body) {
        let v = req.body[k];
        if (k === "due_date") v = coerceDate(v);
        else v = coerceText(v);
        fields.push(`${k} = $${idx++}`);
        values.push(v);
      }
    }
    if (!fields.length) return res.status(400).json({ message: "Nada para actualizar" });

    values.push(id);
    const r = await q(
      `UPDATE clientes SET ${fields.join(", ")} WHERE id = $${idx}
       RETURNING id, nombre, email, telefono, stage, categoria, assignee, source, due_date,
                 contacto_nombre, estimate_url, estimate_file, estimate_uploaded_at,
                 organizacion_id, created_at`,
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
                 organizacion_id, created_at`,
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
                 organizacion_id, created_at`,
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
