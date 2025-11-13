// routes/recordatorios.js — Blindado + multi-tenant + schema-agnostic (TEXT-safe, sin utils/schema)
import { Router } from "express";
import { q } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";

const router = Router();

/* ---------------------------- helpers ---------------------------- */
const T = (v) => (v == null ? null : (String(v).trim() || null));
const toInt = (v) => { const n = Number(v); return Number.isInteger(n) ? n : null; };
const DISO = (v) => { if (!v && v !== 0) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString(); };

// Org TEXT-safe
function getOrgText(req) {
  const raw =
    T(req.usuario?.organizacion_id) ||
    T(req.organizacion_id) ||
    T(req.headers?.["x-org-id"]) ||
    T(req.query?.organizacion_id) ||
    T(req.body?.organizacion_id) ||
    null;
  return raw ? String(raw) : null;
}
function getUser(req) {
  const u = req.usuario || {};
  return {
    email: u.email ?? u.usuario_email ?? req.usuario_email ?? null,
    organizacion_id: getOrgText(req),
  };
}

const ESTADOS = new Set(["pendiente", "enviado", "error", "cancelado"]);

/* ---------- introspección local  ---------- */
async function hasTable(tableName) {
  const { rows } = await q(`SELECT to_regclass($1) IS NOT NULL AS ok`, [tableName]);
  return !!rows?.[0]?.ok;
}

// Cache simple de columnas por 30s
const _colsCache = new Map(); // key: tableName -> { at:number, set:Set<string> }
const COLS_TTL_MS = 30_000;

async function tableColumns(tableName) {
  const now = Date.now();
  const hit = _colsCache.get(tableName);
  if (hit && now - hit.at < COLS_TTL_MS) return hit.set;

  const { rows } = await q(
    `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = $1`,
    [tableName]
  );
  const set = new Set((rows || []).map(r => String(r.column_name)));
  _colsCache.set(tableName, { at: now, set });
  return set;
}

function exp(cols, name, type) {
  return cols.has(name) ? name : `NULL::${type} AS ${name}`;
}
function orderExpr(cols) {
  if (cols.has("enviar_en")) return "enviar_en ASC NULLS LAST, id ASC";
  return "id ASC";
}
function pickInsert(cols, obj) {
  const fields = [], values = [];
  for (const [k, v] of Object.entries(obj)) if (cols.has(k)) { fields.push(k); values.push(v); }
  return { fields, values };
}
function pickUpdate(cols, obj) {
  const sets = [], values = []; let i = 1;
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
 * Filtros: estado, desde/hasta (enviar_en), cliente_id, tarea_id, q (titulo/mensaje)
 * Paginación: limit (<=2000), offset
 */
router.get("/", authenticateToken, async (req, res) => {
  try {
    if (!(await hasTable("recordatorios"))) return res.status(200).json([]);
    const cols = await tableColumns("recordatorios");

    const { organizacion_id } = getUser(req);
    if (organizacion_id == null) return res.status(200).json([]);

    const estadoIn = T(req.query?.estado)?.toLowerCase() || null;
    const estado = estadoIn && ESTADOS.has(estadoIn) ? estadoIn : null;

    const desde = DISO(req.query?.desde);
    const hasta = DISO(req.query?.hasta);
    const cliente_id = toInt(req.query?.cliente_id);
    const tarea_id = toInt(req.query?.tarea_id);
    const qtext = T(req.query?.q);

    let limit = Math.min(2000, Math.max(1, Number(req.query?.limit) || 2000));
    let offset = Math.max(0, Number(req.query?.offset) || 0);

    const params = [];
    const where = [];

    if (cols.has("organizacion_id")) {
      params.push(organizacion_id);
      where.push(`organizacion_id::text = $${params.length}::text`);
    } else {
      console.warn("[recordatorios] schema sin organizacion_id; bloqueando respuesta");
      return res.status(501).json([]);
    }

    if (estado && cols.has("estado")) { params.push(estado); where.push(`estado = $${params.length}`); }
    if (desde && cols.has("enviar_en")) { params.push(desde); where.push(`enviar_en >= $${params.length}`); }
    if (hasta && cols.has("enviar_en")) { params.push(hasta); where.push(`enviar_en <= $${params.length}`); }
    if (cliente_id != null && cols.has("cliente_id")) { params.push(cliente_id); where.push(`cliente_id = $${params.length}`); }
    if (tarea_id != null && cols.has("tarea_id")) { params.push(tarea_id); where.push(`tarea_id = $${params.length}`); }

    // Solo agregamos placeholders si la columna existe
    if (qtext) {
      const like = `%${qtext}%`;
      const parts = [];
      if (cols.has("titulo"))  { params.push(like); parts.push(`titulo ILIKE $${params.length}`); }
      if (cols.has("mensaje")) { params.push(like); parts.push(`mensaje ILIKE $${params.length}`); }
      if (parts.length) where.push(`(${parts.join(" OR ")})`);
    }

    const orderBy = orderExpr(cols);
    const select = [
      exp(cols, "id", "int"),
      exp(cols, "organizacion_id", "text"),
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

    params.push(limit, offset);
    const sql = `
      SELECT ${select}
      FROM recordatorios
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY ${orderBy}
      LIMIT $${params.length - 1} OFFSET $${params.length}
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
 * Body: { titulo, mensaje, enviar_en (ISO), cliente_id?, tarea_id? }
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
      organizacion_id: cols.has("organizacion_id") ? organizacion_id : undefined,
      titulo,
      mensaje,
      enviar_en: cols.has("enviar_en") ? cuando : undefined,
      cliente_id: cols.has("cliente_id") ? (cliente_id == null ? null : Number(cliente_id)) : undefined,
      tarea_id: cols.has("tarea_id") ? (tarea_id == null ? null : Number(tarea_id)) : undefined,
      estado: cols.has("estado") ? "pendiente" : undefined,
      intento_count: cols.has("intento_count") ? 0 : undefined,
      last_error: cols.has("last_error") ? null : undefined,
      sent_at: cols.has("sent_at") ? null : undefined,
      usuario_email: cols.has("usuario_email") ? (email || null) : undefined,
      created_at: cols.has("created_at") ? new Date() : undefined,
      updated_at: cols.has("updated_at") ? new Date() : undefined,
    };

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
 * - estado validado (lowercase)
 * - estado='enviado' → setea sent_at si está null
 * - estado='pendiente' → resetea sent_at/last_error/intento_count
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
      const est = T(req.body.estado)?.toLowerCase();
      if (!ESTADOS.has(est)) return res.status(400).json({ message: "estado inválido" });
      updates.estado = est;
    }
    if ("cliente_id" in (req.body || {}) && cols.has("cliente_id")) {
      updates.cliente_id = req.body.cliente_id == null ? null : Number(req.body.cliente_id);
    }
    if ("tarea_id" in (req.body || {}) && cols.has("tarea_id")) {
      updates.tarea_id = req.body.tarea_id == null ? null : Number(req.body.tarea_id);
    }

    const { sets, values } = pickUpdate(cols, updates);
    if (!sets.length) return res.status(400).json({ message: "Nada para actualizar" });

    // Ajustes por estado
    if (updates.estado === "enviado" && cols.has("sent_at")) {
      sets.push(`sent_at = COALESCE(sent_at, NOW())`);
    }
    if (updates.estado === "pendiente") {
      if (cols.has("sent_at")) sets.push(`sent_at = NULL`);
      if (cols.has("last_error")) sets.push(`last_error = NULL`);
      if (cols.has("intento_count")) sets.push(`intento_count = 0`);
    }

    values.push(id);
    let where = `id = $${values.length}`;
    if (cols.has("organizacion_id")) {
      values.push(organizacion_id);
      where += ` AND organizacion_id::text = $${values.length}::text`;
    } else {
      return res.status(501).json({ message: "Schema sin organizacion_id" });
    }

    const r = await q(
      `UPDATE recordatorios SET ${sets.join(", ")} WHERE ${where}
       RETURNING ${[
         exp(cols, "id", "int"),
         exp(cols, "organizacion_id", "text"),
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
      where += ` AND organizacion_id::text = $2::text`;
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

