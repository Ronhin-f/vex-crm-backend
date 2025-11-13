// routes/tareas.js — Blindado + multi-tenant + schema-agnostic (TEXT-safe, sin utils/schema)
import { Router } from "express";
import { q } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";
import { emit as emitFlow } from "../services/flows.client.js";

const router = Router();

/* ------------------------ helpers ------------------------ */
const T = (v) => (v == null ? null : String(v).trim() || null);
const coerceText = (v) => { const s = T(v); return s && s.length ? s : null; };
function coerceDate(v) { if (!v) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString(); }
function toInt(v) { const n = Number(v); return Number.isInteger(n) ? n : null; }

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
function getUserFromReq(req) {
  const u = req.usuario || {};
  return {
    email: u.email ?? u.usuario_email ?? req.usuario_email ?? null,
    organizacion_id: getOrgText(req),
  };
}
function getBearer(req) { return req.headers?.authorization || null; }

/* ---------- dominios ---------- */
const VALID_ESTADOS = ["todo", "doing", "waiting", "done"];
const VALID_PRIORIDADES = ["alta", "media", "baja"];
const normEstado = (v) => {
  const x = String(v ?? "todo").toLowerCase();
  return VALID_ESTADOS.includes(x) ? x : "todo";
};
const normPrioridad = (v) => {
  const p = String(coerceText(v) ?? "media").toLowerCase();
  return VALID_PRIORIDADES.includes(p) ? p : "media";
};

/* ---------- introspección local (sin utils/schema) ---------- */
async function hasTable(tableName) {
  const { rows } = await q(`SELECT to_regclass($1) IS NOT NULL AS ok`, [tableName]);
  return !!rows?.[0]?.ok;
}
// cache columnas 30s
const _colsCache = new Map(); // tableName -> { at:number, set:Set<string> }
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

/* ---------- schema utils ---------- */
function exp(cols, name, type) {
  return cols.has(name) ? `t.${name}` : `NULL::${type} AS ${name}`;
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
    sets.push(`${k} = $${i++}`);
    values.push(v);
  }
  if (cols.has("updated_at")) sets.push(`updated_at = NOW()`);
  return { sets, values };
}
function orderSql(cols) {
  const estadoCase = cols.has("estado")
    ? `CASE t.estado WHEN 'todo' THEN 1 WHEN 'doing' THEN 2 WHEN 'waiting' THEN 3 WHEN 'done' THEN 4 ELSE 99 END`
    : `1`;
  const prioridadCase = cols.has("prioridad")
    ? `CASE t.prioridad WHEN 'alta' THEN 0 WHEN 'media' THEN 1 WHEN 'baja' THEN 2 ELSE 9 END`
    : `1`;
  const dueExpr = cols.has("vence_en") ? `COALESCE(t.vence_en, '2099-01-01') ASC` : `1`;
  const ordenExpr = cols.has("orden") ? `t.orden ASC` : `1`;
  const createdExpr = cols.has("created_at") ? `t.created_at DESC NULLS LAST` : `t.id DESC`;
  return `${estadoCase}, ${prioridadCase}, ${dueExpr}, ${ordenExpr}, ${createdExpr}, t.id DESC`;
}

/* =========================== GET LIST =========================== */
router.get("/", authenticateToken, async (req, res) => {
  try {
    if (!(await hasTable("tareas"))) return res.status(200).json([]);
    const tCols = await tableColumns("tareas");
    const hasClientes = await hasTable("clientes");

    if (!tCols.has("organizacion_id")) {
      // sin columna de org => no exponemos
      return res.status(501).json([]);
    }

    const { organizacion_id } = getUserFromReq(req);
    let { estado, prioridad, q: qtext, cliente_id, limit = 200, offset = 0 } = req.query || {};

    const params = [];
    const where = [];

    params.push(organizacion_id);
    where.push(`t.organizacion_id::text = $${params.length}::text`);

    if (estado && tCols.has("estado") && VALID_ESTADOS.includes(String(estado))) {
      params.push(String(estado));
      where.push(`t.estado = $${params.length}`);
    }

    if (prioridad && tCols.has("prioridad") && VALID_PRIORIDADES.includes(String(prioridad).toLowerCase())) {
      params.push(String(prioridad).toLowerCase());
      where.push(`t.prioridad = $${params.length}`);
    }

    const cid = toInt(cliente_id);
    if (cid != null && tCols.has("cliente_id")) {
      params.push(cid);
      where.push(`t.cliente_id = $${params.length}`);
    }

    if (qtext) {
      const like = `%${String(qtext).trim().toLowerCase()}%`;
      params.push(like);
      const i1 = params.length;
      const descExpr = tCols.has("descripcion") ? `COALESCE(t.descripcion,'')` : `''`;
      where.push(`(lower(t.titulo) LIKE $${i1} OR lower(${descExpr}) LIKE $${i1})`);
    }

    limit = Math.max(1, Math.min(500, Number(limit) || 200));
    offset = Math.max(0, Number(offset) || 0);
    params.push(limit, offset);

    const select = [
      `t.id`,
      exp(tCols, "titulo", "text"),
      exp(tCols, "descripcion", "text"),
      exp(tCols, "estado", "text"),
      exp(tCols, "prioridad", "text"),
      exp(tCols, "orden", "int"),
      exp(tCols, "completada", "bool"),
      exp(tCols, "vence_en", "timestamptz"),
      exp(tCols, "created_at", "timestamptz"),
      exp(tCols, "updated_at", "timestamptz"),
      exp(tCols, "cliente_id", "int"),
      exp(tCols, "usuario_email", "text"),
      hasClientes && tCols.has("cliente_id")
        ? `c.nombre AS cliente_nombre`
        : `NULL::text AS cliente_nombre`,
    ].join(", ");

    const joinClientes = hasClientes && tCols.has("cliente_id")
      ? `LEFT JOIN clientes c ON c.id = t.cliente_id AND (c.organizacion_id::text = t.organizacion_id::text)`
      : ``;

    const r = await q(
      `
      SELECT ${select}
      FROM tareas t
      ${joinClientes}
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY ${orderSql(tCols)}
      LIMIT $${params.length - 1} OFFSET $${params.length}
      `,
      params
    );

    res.json(r.rows || []);
  } catch (e) {
    console.error("[GET /tareas]", e?.stack || e?.message || e);
    res.status(200).json([]);
  }
});

/* =========================== GET ONE =========================== */
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    if (!(await hasTable("tareas"))) return res.status(404).json({ message: "Tarea no encontrada" });
    const tCols = await tableColumns("tareas");
    if (!tCols.has("organizacion_id")) return res.status(501).json({ message: "Schema sin organizacion_id" });

    const { organizacion_id } = getUserFromReq(req);
    const id = toInt(req.params.id);
    if (id == null) return res.status(400).json({ message: "ID inválido" });

    const select = [
      `t.id`,
      exp(tCols, "titulo", "text"),
      exp(tCols, "descripcion", "text"),
      exp(tCols, "estado", "text"),
      exp(tCols, "prioridad", "text"),
      exp(tCols, "orden", "int"),
      exp(tCols, "completada", "bool"),
      exp(tCols, "vence_en", "timestamptz"),
      exp(tCols, "created_at", "timestamptz"),
      exp(tCols, "updated_at", "timestamptz"),
      exp(tCols, "cliente_id", "int"),
      exp(tCols, "usuario_email", "text"),
    ].join(", ");

    const r = await q(
      `
      SELECT ${select}
      FROM tareas t
      WHERE t.id = $1 AND t.organizacion_id::text = $2::text
      `,
      [id, organizacion_id]
    );

    if (!r.rowCount) return res.status(404).json({ message: "Tarea no encontrada" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error("[GET /tareas/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error al obtener la tarea" });
  }
});

/* =========================== POST ========================== */
router.post("/", authenticateToken, async (req, res) => {
  try {
    if (!(await hasTable("tareas"))) return res.status(501).json({ message: "Módulo de tareas no instalado" });
    const tCols = await tableColumns("tareas");
    if (!tCols.has("organizacion_id")) return res.status(501).json({ message: "Schema sin organizacion_id" });

    const bearer = getBearer(req);
    const { email: creador_email, organizacion_id } = getUserFromReq(req);

    let {
      titulo,
      descripcion = null,
      cliente_id = null,
      vence_en = null,
      estado = "todo",
      prioridad = "media",
      orden = null,
      usuario_email: body_usuario_email,
      assignee_email,
    } = req.body || {};

    if (!titulo || !String(titulo).trim()) {
      return res.status(400).json({ message: "Título requerido" });
    }

    let usuario_email = coerceText(body_usuario_email || assignee_email) || creador_email || null;

    const payload = {
      titulo: String(titulo).trim(),
      descripcion: coerceText(descripcion),
      cliente_id: cliente_id != null ? toInt(cliente_id) : null,
      estado: normEstado(estado),
      prioridad: normPrioridad(prioridad),
      vence_en: coerceDate(vence_en),
      completada: false,
      usuario_email,
      organizacion_id,
    };

    // Calcular orden si existe la columna y no vino
    if (tCols.has("orden")) {
      if (orden == null) {
        const r = await q(
          `SELECT COALESCE(MAX(orden),0) AS m FROM tareas WHERE estado = $1 AND organizacion_id::text = $2::text`,
          [payload.estado, organizacion_id]
        );
        payload.orden = (r.rows?.[0]?.m ?? 0) + 1;
      } else {
        payload.orden = toInt(orden);
      }
    }

    if (tCols.has("created_at")) payload.created_at = new Date();
    if (tCols.has("updated_at")) payload.updated_at = new Date();

    const { fields, values } = pickInsert(tCols, payload);
    if (!fields.length) return res.status(500).json({ message: "Schema inválido para tareas" });

    const placeholders = fields.map((_, i) => `$${i + 1}`).join(",");
    const ins = await q(
      `INSERT INTO tareas (${fields.join(",")}) VALUES (${placeholders})
       RETURNING id, ${
         [
           exp(tCols, "titulo", "text"),
           exp(tCols, "descripcion", "text"),
           exp(tCols, "cliente_id", "int"),
           exp(tCols, "estado", "text"),
           exp(tCols, "prioridad", "text"),
           exp(tCols, "orden", "int"),
           exp(tCols, "vence_en", "timestamptz"),
           exp(tCols, "completada", "bool"),
           exp(tCols, "created_at", "timestamptz"),
           exp(tCols, "updated_at", "timestamptz"),
           exp(tCols, "usuario_email", "text"),
         ].join(", ")
       }`,
      values
    );

    const t = ins.rows[0];

    emitFlow(
      "crm.task.created",
      {
        org_id: String(organizacion_id || ""),
        idempotency_key: `task:${t.id}:created`,
        task: {
          id: String(t.id),
          title: t.titulo,
          description: t.descripcion || null,
          status: t.estado || "todo",
          priority: t.prioridad || "media",
          due_at: t.vence_en ? new Date(t.vence_en).toISOString() : null,
          assigned_to: { email: t.usuario_email || null },
        },
        meta: { source: "vex-crm", version: "v1" },
      },
      { bearer }
    ).catch((e) => console.warn("[Flows emit task.created]", e?.message));

    res.status(201).json(t);
  } catch (e) {
    console.error("[POST /tareas]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error al crear tarea" });
  }
});

/* ========== UPDATE genérico: PATCH y PUT comparten lógica ========== */
async function updateTaskGeneric(req, res, { emptyAsComplete = false } = {}) {
  try {
    if (!(await hasTable("tareas"))) return res.status(501).json({ message: "Módulo de tareas no instalado" });
    const tCols = await tableColumns("tareas");
    if (!tCols.has("organizacion_id")) return res.status(501).json({ message: "Schema sin organizacion_id" });

    const bearer = getBearer(req);
    const { organizacion_id } = getUserFromReq(req);
    const id = toInt(req.params.id);
    if (id == null) return res.status(400).json({ message: "ID inválido" });

    const allowed = {
      titulo: (v) => coerceText(v),
      descripcion: (v) => coerceText(v),
      cliente_id: (v) => (v != null ? toInt(v) : null),
      vence_en: (v) => coerceDate(v),
      estado: (v) => (v != null ? normEstado(v) : null),
      prioridad: (v) => (v != null ? normPrioridad(v) : null),
      orden: (v) => (v != null ? toInt(v) : null),
      completada: (v) => (v != null ? !!v : null),
      usuario_email: (v) => coerceText(v),
    };

    // alias
    if ("assignee_email" in (req.body || {})) {
      req.body.usuario_email = req.body.assignee_email;
      delete req.body.assignee_email;
    }

    const updates = {};
    for (const k of Object.keys(allowed)) {
      if (k in (req.body || {}) && tCols.has(k)) {
        updates[k] = allowed[k](req.body[k]);
      }
    }

    // PATCH vacío = completar y mandar al final de 'done' (si existen columnas)
    if (!Object.keys(updates).length && emptyAsComplete) {
      if (!tCols.has("estado") || !tCols.has("completada")) {
        return res.status(400).json({ message: "Schema no soporta completar tarea" });
      }
      let nextOrden = null;
      if (tCols.has("orden")) {
        const rOrden = await q(
          `SELECT COALESCE(MAX(orden),0) AS m FROM tareas WHERE estado='done' AND organizacion_id::text = $1::text`,
          [organizacion_id]
        );
        nextOrden = (rOrden.rows?.[0]?.m ?? 0) + 1;
      }

      const sets = [`estado='done'`, `completada=TRUE`];
      if (tCols.has("orden") && nextOrden != null) sets.push(`orden=${Number(nextOrden)}`);
      if (tCols.has("updated_at")) sets.push(`updated_at=NOW()`);

      const rDone = await q(
        `UPDATE tareas SET ${sets.join(", ")}
         WHERE id=$1 AND organizacion_id::text=$2::text
         RETURNING ${[
           "id",
           exp(tCols, "titulo", "text"),
           exp(tCols, "descripcion", "text"),
           exp(tCols, "cliente_id", "int"),
           exp(tCols, "estado", "text"),
           exp(tCols, "prioridad", "text"),
           exp(tCols, "orden", "int"),
           exp(tCols, "vence_en", "timestamptz"),
           exp(tCols, "completada", "bool"),
           exp(tCols, "created_at", "timestamptz"),
           exp(tCols, "updated_at", "timestamptz"),
           exp(tCols, "usuario_email", "text"),
         ].join(", ")}`,
        [id, organizacion_id]
      );
      if (!rDone.rowCount) return res.status(404).json({ message: "Tarea no encontrada" });

      const t = rDone.rows[0];
      emitFlow(
        "crm.task.completed",
        {
          org_id: String(organizacion_id || ""),
          idempotency_key: `task:${t.id}:completed`,
          task: {
            id: String(t.id),
            status: t.estado || "done",
            priority: t.prioridad || "media",
            due_at: t.vence_en ? new Date(t.vence_en).toISOString() : null,
            assigned_to: { email: t.usuario_email || null },
            completed: true,
          },
          meta: { source: "vex-crm", version: "v1" },
        },
        { bearer }
      ).catch((e) => console.warn("[Flows emit task.completed]", e?.message));

      return res.json(t);
    }

    if (!Object.keys(updates).length) return res.status(400).json({ message: "Nada para actualizar" });

    const { sets, values } = pickUpdate(tCols, updates);
    values.push(id, organizacion_id);

    const r = await q(
      `
      UPDATE tareas
         SET ${sets.join(", ")}
       WHERE id = $${values.length - 1} AND organizacion_id::text = $${values.length}::text
       RETURNING ${[
         "id",
         exp(tCols, "titulo", "text"),
         exp(tCols, "descripcion", "text"),
         exp(tCols, "cliente_id", "int"),
         exp(tCols, "estado", "text"),
         exp(tCols, "prioridad", "text"),
         exp(tCols, "orden", "int"),
         exp(tCols, "vence_en", "timestamptz"),
         exp(tCols, "completada", "bool"),
         exp(tCols, "created_at", "timestamptz"),
         exp(tCols, "updated_at", "timestamptz"),
         exp(tCols, "usuario_email", "text"),
       ].join(", ")}
      `,
      values
    );

    if (!r.rowCount) return res.status(404).json({ message: "Tarea no encontrada" });

    const t = r.rows[0];
    emitFlow(
      "crm.task.updated",
      {
        org_id: String(organizacion_id || ""),
        idempotency_key: `task:${t.id}:updated:${Number(t.orden || 0)}`,
        task: {
          id: String(t.id),
          title: t.titulo,
          status: t.estado || "todo",
          priority: t.prioridad || "media",
          due_at: t.vence_en ? new Date(t.vence_en).toISOString() : null,
          completed: !!t.completada,
          assigned_to: { email: t.usuario_email || null },
        },
        meta: { source: "vex-crm", version: "v1" },
      },
      { bearer }
    ).catch((e) => console.warn("[Flows emit task.updated]", e?.message));

    return res.json(t);
  } catch (e) {
    console.error("[UPDATE /tareas/:id]", e?.stack || e?.message || e);
    return res.status(500).json({ message: "Error al editar tarea" });
  }
}

/* =========================== PATCH ========================= */
router.patch("/:id", authenticateToken, (req, res) =>
  updateTaskGeneric(req, res, { emptyAsComplete: true })
);

/* ============================ PUT ========================== */
router.put("/:id", authenticateToken, (req, res) =>
  updateTaskGeneric(req, res, { emptyAsComplete: false })
);

/* ================== PATCH /assign (cambiar asignado) ================== */
router.patch("/:id/assign", authenticateToken, async (req, res) => {
  try {
    if (!(await hasTable("tareas"))) return res.status(501).json({ message: "Módulo de tareas no instalado" });
    const tCols = await tableColumns("tareas");
    if (!tCols.has("organizacion_id")) return res.status(501).json({ message: "Schema sin organizacion_id" });
    if (!tCols.has("usuario_email")) return res.status(400).json({ message: "Schema no soporta asignación" });

    const bearer = getBearer(req);
    const { organizacion_id } = getUserFromReq(req);
    const id = toInt(req.params.id);
    const usuario_email = coerceText(req.body?.usuario_email || req.body?.assignee_email);

    if (id == null) return res.status(400).json({ message: "ID inválido" });
    if (!usuario_email) return res.status(400).json({ message: "usuario_email requerido" });

    const sets = [`usuario_email = $1`];
    if (tCols.has("updated_at")) sets.push(`updated_at = NOW()`);

    const r = await q(
      `
      UPDATE tareas
         SET ${sets.join(", ")}
       WHERE id = $2 AND organizacion_id::text = $3::text
       RETURNING ${[
         "id",
         exp(tCols, "titulo", "text"),
         exp(tCols, "descripcion", "text"),
         exp(tCols, "cliente_id", "int"),
         exp(tCols, "estado", "text"),
         exp(tCols, "prioridad", "text"),
         exp(tCols, "orden", "int"),
         exp(tCols, "vence_en", "timestamptz"),
         exp(tCols, "completada", "bool"),
         exp(tCols, "created_at", "timestamptz"),
         exp(tCols, "updated_at", "timestamptz"),
         exp(tCols, "usuario_email", "text"),
       ].join(", ")}
      `,
      [usuario_email, id, organizacion_id]
    );

    if (!r.rowCount) return res.status(404).json({ message: "Tarea no encontrada" });
    const t = r.rows[0];

    emitFlow(
      "crm.task.updated",
      {
        org_id: String(organizacion_id || ""),
        idempotency_key: `task:${t.id}:updated:assignee`,
        task: {
          id: String(t.id),
          title: t.titulo,
          status: t.estado || "todo",
          priority: t.prioridad || "media",
          due_at: t.vence_en ? new Date(t.vence_en).toISOString() : null,
          completed: !!t.completada,
          assigned_to: { email: t.usuario_email || null },
        },
        meta: { source: "vex-crm", version: "v1" },
      },
      { bearer }
    ).catch((e) => console.warn("[Flows emit task.updated/assign]", e?.message));

    res.json(t);
  } catch (e) {
    console.error("[PATCH /tareas/:id/assign]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error al asignar tarea" });
  }
});

/* ===================== PATCH /toggle (hecha/rehabrir) ===================== */
router.patch("/:id/toggle", authenticateToken, async (req, res) => {
  try {
    if (!(await hasTable("tareas"))) return res.status(501).json({ message: "Módulo de tareas no instalado" });
    const tCols = await tableColumns("tareas");
    if (!tCols.has("organizacion_id")) return res.status(501).json({ message: "Schema sin organizacion_id" });
    if (!tCols.has("completada") || !tCols.has("estado")) {
      return res.status(400).json({ message: "Schema no soporta toggle de completada" });
    }

    const bearer = getBearer(req);
    const { organizacion_id } = getUserFromReq(req);
    const id = toInt(req.params.id);
    if (id == null) return res.status(400).json({ message: "ID inválido" });

    const cur = await q(
      `
      SELECT ${[
        "id",
        exp(tCols, "completada", "bool"),
        exp(tCols, "estado", "text"),
        exp(tCols, "prioridad", "text"),
        exp(tCols, "orden", "int"),
        exp(tCols, "vence_en", "timestamptz"),
        exp(tCols, "titulo", "text"),
        exp(tCols, "usuario_email", "text"),
      ].join(", ")}
        FROM tareas t
       WHERE t.id=$1 AND t.organizacion_id::text=$2::text
      `,
      [id, organizacion_id]
    );
    if (!cur.rowCount) return res.status(404).json({ message: "Tarea no encontrada" });
    const row = cur.rows[0];

    const nuevoEstado = row.completada ? "todo" : "done";

    let nuevaOrden = row.orden ?? null;
    if (!row.completada && tCols.has("orden")) {
      const rOrden = await q(
        `SELECT COALESCE(MAX(orden),0) AS m FROM tareas WHERE estado='done' AND organizacion_id::text=$1::text`,
        [organizacion_id]
      );
      nuevaOrden = (rOrden.rows?.[0]?.m ?? 0) + 1;
    }

    const sets = [`completada = NOT completada`, `estado = $1`];
    const params = [nuevoEstado, id, organizacion_id];
    if (tCols.has("orden") && nuevaOrden != null) {
      sets.push(`orden = $4`);
      params.push(nuevaOrden);
    }
    if (tCols.has("updated_at")) sets.push(`updated_at = NOW()`);

    const upd = await q(
      `
      UPDATE tareas
         SET ${sets.join(", ")}
       WHERE id=$2 AND organizacion_id::text=$3::text
       RETURNING ${[
         "id",
         exp(tCols, "titulo", "text"),
         exp(tCols, "descripcion", "text"),
         exp(tCols, "cliente_id", "int"),
         exp(tCols, "estado", "text"),
         exp(tCols, "prioridad", "text"),
         exp(tCols, "orden", "int"),
         exp(tCols, "vence_en", "timestamptz"),
         exp(tCols, "completada", "bool"),
         exp(tCols, "created_at", "timestamptz"),
         exp(tCols, "updated_at", "timestamptz"),
         exp(tCols, "usuario_email", "text"),
       ].join(", ")}
      `,
      params
    );

    const t = upd.rows[0];
    emitFlow(
      t.completada ? "crm.task.completed" : "crm.task.updated",
      {
        org_id: String(organizacion_id || ""),
        idempotency_key: `task:${t.id}:${t.completada ? "completed" : "toggled"}`,
        task: {
          id: String(t.id),
          title: t.titulo,
          status: t.estado || (t.completada ? "done" : "todo"),
          priority: t.prioridad || "media",
          due_at: t.vence_en ? new Date(t.vence_en).toISOString() : null,
          completed: !!t.completada,
          assigned_to: { email: t.usuario_email || null },
        },
        meta: { source: "vex-crm", version: "v1" },
      },
      { bearer }
    ).catch((e) => console.warn("[Flows emit task.toggle]", e?.message));

    res.json(t);
  } catch (e) {
    console.error("[PATCH /tareas/:id/toggle]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error al alternar tarea" });
  }
});

/* ================== PATCH /reorder (drag & drop) ================== */
/**
 * Body: { estado, ordered_ids: number[] }
 * - Mueve las tareas listadas a `estado` y fija orden 1..N si existe la columna.
 * - No toca otras tareas.
 */
router.patch("/reorder", authenticateToken, async (req, res) => {
  try {
    if (!(await hasTable("tareas"))) return res.status(501).json({ message: "Módulo de tareas no instalado" });
    const tCols = await tableColumns("tareas");
    if (!tCols.has("organizacion_id")) return res.status(501).json({ message: "Schema sin organizacion_id" });

    const bearer = getBearer(req);
    const { organizacion_id } = getUserFromReq(req);
    const estado = normEstado(req.body?.estado);
    const ids = Array.isArray(req.body?.ordered_ids)
      ? req.body.ordered_ids.map(toInt).filter((x) => x != null)
      : [];

    if (!ids.length) return res.status(400).json({ message: "ordered_ids requerido" });

    let r;
    if (tCols.has("orden")) {
      const params = [estado];
      const caseClauses = [];
      const inHolders = [];

      ids.forEach((id, i) => {
        params.push(id);
        caseClauses.push(`WHEN $${params.length} THEN ${i + 1}`);
        inHolders.push(`$${params.length}`);
      });
      params.push(organizacion_id);

      r = await q(
        `
        UPDATE tareas
           SET estado = $1,
               orden = CASE id
                 ${caseClauses.join("\n")}
                 ELSE orden
               END,
               ${tCols.has("updated_at") ? "updated_at = NOW()," : ""}
               organizacion_id = organizacion_id
         WHERE id IN (${inHolders.join(", ")})
           AND organizacion_id::text = $${params.length}::text
         RETURNING id, ${[
           exp(tCols, "titulo", "text"),
           exp(tCols, "estado", "text"),
           exp(tCols, "prioridad", "text"),
           exp(tCols, "orden", "int"),
           exp(tCols, "vence_en", "timestamptz"),
           exp(tCols, "usuario_email", "text"),
           exp(tCols, "updated_at", "timestamptz"),
         ].join(", ")}
        `,
        params
      );
    } else {
      // Sin columna 'orden': solo movemos estado.
      r = await q(
        `
        UPDATE tareas
           SET estado = $1
         WHERE id = ANY($2::int[])
           AND organizacion_id::text = $3::text
         RETURNING id, ${[
           exp(tCols, "titulo", "text"),
           exp(tCols, "estado", "text"),
           exp(tCols, "prioridad", "text"),
           exp(tCols, "vence_en", "timestamptz"),
           exp(tCols, "usuario_email", "text"),
           exp(tCols, "updated_at", "timestamptz"),
         ].join(", ")}
        `,
        [estado, ids, organizacion_id]
      );
    }

    const updated = r.rows || [];

    await Promise.all(
      updated.map((t) =>
        emitFlow(
          "crm.task.updated",
          {
            org_id: String(organizacion_id || ""),
            idempotency_key: `task:${t.id}:reorder:${t.orden ?? "no-orden"}`,
            task: {
              id: String(t.id),
              title: t.titulo,
              status: t.estado || estado,
              priority: t.prioridad || "media",
              due_at: t.vence_en ? new Date(t.vence_en).toISOString() : null,
              completed: false,
              assigned_to: { email: t.usuario_email || null },
            },
            meta: { source: "vex-crm", version: "v1" },
          },
          { bearer }
        ).catch((e) => console.warn("[Flows emit task.reorder]", e?.message))
      )
    );

    res.json({ ok: true, count: updated.length, items: updated });
  } catch (e) {
    console.error("[PATCH /tareas/reorder]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error al reordenar tareas" });
  }
});

/* =========================== DELETE ========================= */
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    if (!(await hasTable("tareas"))) return res.status(501).json({ message: "Módulo de tareas no instalado" });
    const tCols = await tableColumns("tareas");
    if (!tCols.has("organizacion_id")) return res.status(501).json({ message: "Schema sin organizacion_id" });

    const bearer = getBearer(req);
    const { organizacion_id } = getUserFromReq(req);
    const id = toInt(req.params.id);
    if (id == null) return res.status(400).json({ message: "ID inválido" });

    const prev = await q(
      `
      SELECT ${[
        "id",
        exp(tCols, "titulo", "text"),
        exp(tCols, "estado", "text"),
        exp(tCols, "prioridad", "text"),
        exp(tCols, "vence_en", "timestamptz"),
        exp(tCols, "usuario_email", "text"),
      ].join(", ")}
        FROM tareas t
       WHERE t.id=$1 AND t.organizacion_id::text=$2::text
      `,
      [id, organizacion_id]
    );

    const r = await q(
      `DELETE FROM tareas WHERE id = $1 AND organizacion_id::text = $2::text`,
      [id, organizacion_id]
    );

    if (!r.rowCount) return res.status(404).json({ message: "Tarea no encontrada" });

    if (prev.rowCount) {
      const t = prev.rows[0];
      emitFlow(
        "crm.task.deleted",
        {
          org_id: String(organizacion_id || ""),
          idempotency_key: `task:${t.id}:deleted`,
          task: {
            id: String(t.id),
            title: t.titulo,
            status: t.estado || "todo",
            priority: t.prioridad || "media",
            due_at: t.vence_en ? new Date(t.vence_en).toISOString() : null,
            assigned_to: { email: t.usuario_email || null },
          },
          meta: { source: "vex-crm", version: "v1" },
        },
        { bearer }
      ).catch((e) => console.warn("[Flows emit task.deleted]", e?.message));
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /tareas/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error al eliminar tarea" });
  }
});

export default router;
