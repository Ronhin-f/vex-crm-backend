// routes/recordatorios.js — Blindado + multi-tenant + schema-agnostic
import { Router } from "express";
import { q } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";
import { hasTable, tableColumns } from "../utils/schema.js";

const router = Router();

/* ---------------------------- helpers ---------------------------- */
const T = (v) => (v == null ? null : String(v).trim() || null);
const toInt = (v) => { const n = Number(v); return Number.isInteger(n) ? n : null; };
const DISO = (v) => { if (!v && v !== 0) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString(); };

function getOrg(req) {
  // Si tu org fuera TEXT, cambiá esta normalización a String(...).trim()
  const raw =
    req.usuario?.organizacion_id ??
    req.organizacion_id ??
    req.headers?.["x-org-id"] ??
    req.query?.organizacion_id ??
    req.body?.organizacion_id ??
    null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
function getUser(req) {
  const u = req.usuario || {};
  return {
    email: u.email ?? u.usuario_email ?? req.usuario_email ?? null,
    organizacion_id: getOrg(req),
  };
}
const ESTADOS = new Set(["pendiente", "enviado", "error", "cancelado"]);

function exp(cols, name, type) {
  return cols.has(name) ? name : `NULL::${type} AS ${name}`;
}
function orderExpr(cols) {
  if (cols.has("enviar_en")) return "enviar_en ASC NULLS LAST, id ASC";
  return "id ASC";
}
function pickInsert(cols, obj) {
  const fields = []; const values = [];
  for (const [k, v] of Object.entries(obj)) if (cols.has(k)) { fields.push(k); values.push(v); }
  return { fields, values };
}
function pickUpdate(cols, obj) {
  const sets = []; const values = []; let i = 1;
  for (const [k, v] of Object.entries(obj)) {
    if (!cols.has(k)) continue;
    sets.push(`${k} = $${i++}`); values.push(v);
  }
  if (cols.has("updated_at")) sets.push(`updated_at = NOW()`);
  return { sets, values };
}

/* ----------------------------- GET ------------------------------ */
/**
 * Lista recordatorios de la organización.
 * Filtros: estado, desde/hasta (enviar_en), cliente_id, tarea_id
 * Orden: enviar_en ASC (si existe), id ASC
 */
router.get("/", authenticateToken, async (req, res) => {
  try {
    if (!(await hasTable("recordatorios"))) return res.status(200).json([]);
    const cols = await tableColumns("recordatorios");

    const { organizacion_id } = getUser(req);
    // Sin org en el token/req no exponemos nada
    if (organizacion_id == null) return res.status(200).json([]);

    const estado = T(req.query?.estado);
    const desde = DISO(req.query?.desde);
    const hasta = DISO(req.query?.hasta);
    const cliente_id = toInt(req.query?.cliente_id);
    const tarea_id = toInt(req.query?.tarea_id);

    const params = [];
    const where = [];

    if (cols.has("organizacion_id")) {
      params.push(organizacion_id);
      where.push(`organizacion_id = $${params.length}`);
    } else {
      // Sin columna de org ⇒ entorno single-tenant, igual exigimos org para evitar fugas.
      return res.status(501).json([]);
    }

    if (estado && ESTADOS.has(estado) && cols.has("estado")) {
      params.push(estado);
      where.push(`estado = $${params.length}`);
    }
    if (desde && cols.has("enviar_en")) {
      params.push(desde);
      where.push(`enviar_en >= $${params.length}`);
    }
    if (hasta && cols.has("enviar_en")) {
      params.push(hasta);
      where.push(`enviar_en <= $${params.length}`);
    }
    if (cliente_id != null && cols.has("cliente_id")) {
      params.push(cliente_id);
      where.push(`cliente_id = $${params.length}`);
    }
    if (tarea_id != null && cols.has("tarea_id")) {
      params.push(tarea_id);
      where.push(`tarea_id = $${params.length}`);
    }

    const orderBy = orderExpr(cols);
    const select = [
      exp(cols, "id", "int"),
      exp(cols, "organizacion_id", "int"),
      exp(cols, "titulo", "text"),
      exp(cols, "mensaje", "text"),
      exp(cols, "enviar_en", "timestamptz"),
      exp(cols, "cliente_id", "int"),
      exp(cols, "tarea_id", "int"),
      exp(cols, "estado", "text"),
      exp(cols, "intento_count", "int"),
      exp(cols, "last_error", "text"),
      exp(cols, "sent_at", "timestamptz"),
      exp(cols, "usuario_email", "text"),
      exp(cols, "created_at", "timestamptz"),
      exp(cols, "updated_at", "timestamptz"),
    ].join(", ");

    const sql = `
      SELECT ${select}
      FROM recordatorios
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY ${orderBy}
      LIMIT 2000
    `;
    const r = await q(sql, params);
    res.json(r.rows || []);
  } catch (e) {
    console.error("[GET /recordatorios]", e?.stack || e?.message || e);
    res.status(200).json([]);
  }
});

/* ----------------------------- POST ----------------------------- */
/**
 * Crea un recordatorio en estado 'pendiente'.
 * Body: { titulo, mensaje, enviar_en, cliente_id?, tarea_id? }
 */
router.post("/", authenticateToken, async (req, res) => {
  try {
    if (!(await hasTable("recordatorios"))) {
      return res.status(501).json({ message: "Módulo de recordatorios no instalado" });
    }
    const cols = await tableColumns("recordatorios");

    const { organizacion_id, email } = getUser(req);
    if (organizacion_id == null) {
      return res.status(400).json({ message: "organizacion_id requerido en token/headers" });
    }

    let { titulo, mensaje, enviar_en, cliente_id = null, tarea_id = null } = req.body || {};
    titulo = T(titulo);
    mensaje = T(mensaje);
    const cuando = DISO(enviar_en);

    if (!titulo || !mensaje || !cuando) {
      return res.status(400).json({ message: "Campos requeridos: titulo, mensaje, enviar_en (ISO)" });
    }

    const payload = {
      organizacion_id: organizacion_id,
      titulo,
      mensaje,
      enviar_en: cuando,
      cliente_id: cliente_id == null ? null : Number(cliente_id),
      tarea_id: tarea_id == null ? null : Number(tarea_id),
      estado: "pendiente",
      intento_count: 0,
      last_error: null,
      sent_at: null,
      usuario_email: email || null,
    };
    if (cols.has("created_at")) payload.created_at = new Date();
    if (cols.has("updated_at")) payload.updated_at = new Date();

    const { fields, values } = pickInsert(cols, payload);
    if (!fields.length) return res.status(501).json({ message: "Schema inválido para recordatorios" });

    const placeholders = fields.map((_, i) => `$${i + 1}`).join(",");
    const ins = await q(
      `INSERT INTO recordatorios (${fields.join(",")}) VALUES (${placeholders}) RETURNING id`,
      values
    );
    res.status(201).json({ id: ins.rows[0].id });
  } catch (e) {
    console.error("[POST /recordatorios]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error al crear recordatorio" });
  }
});

/* ----------------------------- PATCH ---------------------------- */
/**
 * Actualiza parcialmente un recordatorio de la misma organización.
 * Campos permitidos (si existen): titulo, mensaje, enviar_en, estado, cliente_id, tarea_id
 * - estado validado contra {pendiente,enviado,error,cancelado}
 * - pasar a 'enviado' setea sent_at si la columna existe y está null
 */
router.patch("/:id", authenticateToken, async (req, res) => {
  try {
    if (!(await hasTable("recordatorios"))) {
      return res.status(501).json({ message: "Módulo de recordatorios no instalado" });
    }
    const cols = await tableColumns("recordatorios");

    const { organizacion_id } = getUser(req);
    const id = toInt(req.params.id);
    if (organizacion_id == null) return res.status(400).json({ message: "organizacion_id requerido" });
    if (id == null) return res.status(400).json({ message: "ID inválido" });

    const updates = {};

    if ("titulo" in (req.body || {}) && cols.has("titulo")) updates.titulo = T(req.body.titulo);
    if ("mensaje" in (req.body || {}) && cols.has("mensaje")) updates.mensaje = T(req.body.mensaje);
    if ("enviar_en" in (req.body || {}) && cols.has("enviar_en")) {
      const iso = DISO(req.body.enviar_en);
      if (!iso) return res.status(400).json({ message: "enviar_en inválido" });
      updates.enviar_en = iso;
    }
    if ("estado" in (req.body || {}) && cols.has("estado")) {
      const est = T(req.body.estado);
      if (!ESTADOS.has(est)) return res.status(400).json({ message: "estado inválido" });
      updates.estado = est;
    }
    if ("cliente_id" in (req.body || {}) && cols.has("cliente_id")) {
      updates.cliente_id = req.body.cliente_id == null ? null : Number(req.body.cliente_id);
    }
    if ("tarea_id" in (req.body || {}) && cols.has("tarea_id")) {
      updates.tarea_id = req.body.tarea_id == null ? null : Number(req.body.tarea_id);
    }

    // Si estado=>enviado y existe sent_at, seteamos si es null (en el UPDATE)
    const { sets, values } = pickUpdate(cols, updates);
    if (!sets.length) return res.status(400).json({ message: "Nada para actualizar" });
    if (updates.estado === "enviado" && cols.has("sent_at")) {
      sets.push(`sent_at = COALESCE(sent_at, NOW())`);
    }

    values.push(id);
    let where = `id = $${values.length}`;
    if (cols.has("organizacion_id")) {
      values.push(organizacion_id);
      where += ` AND organizacion_id = $${values.length}`;
    } else {
      return res.status(501).json({ message: "Schema sin organizacion_id" });
    }

    const r = await q(
      `UPDATE recordatorios SET ${sets.join(", ")} WHERE ${where}
       RETURNING ${[
         exp(cols, "id", "int"),
         exp(cols, "organizacion_id", "int"),
         exp(cols, "titulo", "text"),
         exp(cols, "mensaje", "text"),
         exp(cols, "enviar_en", "timestamptz"),
         exp(cols, "cliente_id", "int"),
         exp(cols, "tarea_id", "int"),
         exp(cols, "estado", "text"),
         exp(cols, "intento_count", "int"),
         exp(cols, "last_error", "text"),
         exp(cols, "sent_at", "timestamptz"),
         exp(cols, "created_at", "timestamptz"),
         exp(cols, "updated_at", "timestamptz"),
       ].join(", ")}`
      ,
      values
    );
    if (!r.rowCount) return res.status(404).json({ message: "Recordatorio no encontrado" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error("[PATCH /recordatorios/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error al actualizar recordatorio" });
  }
});

/* ---------------------------- DELETE ---------------------------- */
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    if (!(await hasTable("recordatorios"))) {
      return res.status(501).json({ message: "Módulo de recordatorios no instalado" });
    }
    const cols = await tableColumns("recordatorios");

    const { organizacion_id } = getUser(req);
    const id = toInt(req.params.id);
    if (organizacion_id == null) return res.status(400).json({ message: "organizacion_id requerido" });
    if (id == null) return res.status(400).json({ message: "ID inválido" });

    const params = [id];
    let where = `id = $1`;
    if (cols.has("organizacion_id")) {
      params.push(organizacion_id);
      where += ` AND organizacion_id = $2`;
    } else {
      return res.status(501).json({ message: "Schema sin organizacion_id" });
    }

    const r = await q(`DELETE FROM recordatorios WHERE ${where}`, params);
    if (!r.rowCount) return res.status(404).json({ message: "Recordatorio no encontrado" });
    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /recordatorios/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error al eliminar recordatorio" });
  }
});

export default router;
