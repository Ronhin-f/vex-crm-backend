// routes/tareas.js
import { Router } from "express";
import { q } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";
import { emit as emitFlow } from "../services/flows.client.js";

const router = Router();

/* ------------------------ helpers ------------------------ */
function getUserFromReq(req) {
  const u = req.usuario || {};
  return {
    email: u.email ?? u.usuario_email ?? req.usuario_email ?? null,
    organizacion_id: u.organizacion_id ?? u.organization_id ?? req.organizacion_id ?? null,
  };
}
function getBearer(req) {
  return req.headers?.authorization || null;
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
function toInt(v) {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

const VALID_ESTADOS = ["todo", "doing", "waiting", "done"];
const ESTADO_ORDER_SQL = `
  CASE t.estado
    WHEN 'todo'    THEN 1
    WHEN 'doing'   THEN 2
    WHEN 'waiting' THEN 3
    WHEN 'done'    THEN 4
    ELSE 99
  END
`;

/* =========================== GET LIST =========================== */
/**
 * Lista tareas de la organización.
 * Query: estado, q (título/descr), cliente_id, limit, offset
 */
router.get("/", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id } = getUserFromReq(req);
    let { estado, q: qtext, cliente_id, limit = 200, offset = 0 } = req.query || {};

    const params = [];
    const where = [];

    if (organizacion_id != null) {
      params.push(organizacion_id);
      where.push(`t.organizacion_id = $${params.length}`);
    }

    if (estado && VALID_ESTADOS.includes(String(estado))) {
      params.push(String(estado));
      where.push(`t.estado = $${params.length}`);
    }

    const cid = toInt(cliente_id);
    if (cid != null) {
      params.push(cid);
      where.push(`t.cliente_id = $${params.length}`);
    }

    if (qtext) {
      const like = `%${String(qtext).trim().toLowerCase()}%`;
      params.push(like, like);
      const i1 = params.length - 1;
      const i2 = params.length;
      where.push(`(lower(t.titulo) LIKE $${i1} OR lower(COALESCE(t.descripcion,'')) LIKE $${i2})`);
    }

    limit = Math.max(1, Math.min(500, Number(limit) || 200));
    offset = Math.max(0, Number(offset) || 0);
    params.push(limit, offset);

    const r = await q(
      `
      SELECT
        t.id, t.titulo, t.descripcion, t.estado, t.orden, t.completada,
        t.vence_en, t.created_at, t.cliente_id, t.usuario_email,
        c.nombre AS cliente_nombre
      FROM tareas t
      LEFT JOIN clientes c ON c.id = t.cliente_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY ${ESTADO_ORDER_SQL},
               t.orden ASC,
               COALESCE(t.vence_en, '2099-01-01') ASC,
               t.created_at DESC,
               t.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
      `,
      params
    );

    res.json(r.rows || []);
  } catch (e) {
    console.error("[GET /tareas]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error al obtener tareas" });
  }
});

/* =========================== GET ONE =========================== */
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id } = getUserFromReq(req);
    const id = toInt(req.params.id);
    if (id == null) return res.status(400).json({ message: "ID inválido" });

    const r = await q(
      `
      SELECT
        t.id, t.titulo, t.descripcion, t.estado, t.orden, t.completada,
        t.vence_en, t.created_at, t.cliente_id, t.usuario_email
      FROM tareas t
      WHERE t.id = $1
        AND (${organizacion_id != null ? "t.organizacion_id = $2" : "t.organizacion_id IS NULL"})
      `,
      organizacion_id != null ? [id, organizacion_id] : [id]
    );

    if (!r.rowCount) return res.status(404).json({ message: "Tarea no encontrada" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error("[GET /tareas/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error al obtener la tarea" });
  }
});

/* =========================== POST ========================== */
/**
 * Crea una tarea.
 * Body: { titulo, descripcion?, cliente_id?, vence_en?, estado?, orden?, usuario_email?|assignee_email? }
 */
router.post("/", authenticateToken, async (req, res) => {
  try {
    const bearer = getBearer(req);
    const { email: creador_email, organizacion_id } = getUserFromReq(req);

    let {
      titulo,
      descripcion = null,
      cliente_id = null,
      vence_en = null,
      estado = "todo",
      orden = null,
      usuario_email: body_usuario_email,
      assignee_email,
    } = req.body || {};

    if (!titulo || !titulo.trim()) {
      return res.status(400).json({ message: "Título requerido" });
    }

    let usuario_email = coerceText(body_usuario_email || assignee_email) || creador_email || null;

    titulo = titulo.trim();
    descripcion = coerceText(descripcion);
    estado = VALID_ESTADOS.includes(estado) ? estado : "todo";
    vence_en = coerceDate(vence_en);
    cliente_id = cliente_id != null ? toInt(cliente_id) : null;

    if (orden == null) {
      const r = await q(
        `SELECT COALESCE(MAX(orden),0) AS m
           FROM tareas
          WHERE estado = $1 AND (${organizacion_id != null ? "organizacion_id = $2" : "organizacion_id IS NULL"})`,
        organizacion_id != null ? [estado, organizacion_id] : [estado]
      );
      orden = (r.rows?.[0]?.m ?? 0) + 1;
    }

    const ins = await q(
      `
      INSERT INTO tareas
        (titulo, descripcion, cliente_id, estado, orden, vence_en,
         completada, usuario_email, organizacion_id, created_at)
      VALUES
        ($1,$2,$3,$4,$5,$6,
         FALSE, $7, $8, NOW())
      RETURNING id, titulo, descripcion, cliente_id, estado, orden, vence_en, completada, created_at, usuario_email
      `,
      [titulo, descripcion, cliente_id, estado, orden, vence_en, usuario_email, organizacion_id]
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
          status: t.estado,
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
    const bearer = getBearer(req);
    const { organizacion_id } = getUserFromReq(req);
    const id = toInt(req.params.id);
    if (id == null) return res.status(400).json({ message: "ID inválido" });

    const allowed = ["titulo","descripcion","cliente_id","vence_en","estado","orden","completada","usuario_email"];
    const fields = [];
    const values = [];
    let idx = 1;

    if ("assignee_email" in (req.body || {})) {
      req.body.usuario_email = req.body.assignee_email;
      delete req.body.assignee_email;
    }

    for (const k of allowed) {
      if (k in (req.body || {})) {
        let v = req.body[k];
        if (k === "titulo" || k === "descripcion" || k === "usuario_email") v = coerceText(v);
        if (k === "vence_en") v = coerceDate(v);
        if (k === "cliente_id") v = v != null ? toInt(v) : null;
        if (k === "estado" && v) v = VALID_ESTADOS.includes(v) ? v : "todo";
        if (k === "orden" && v != null) v = toInt(v);
        if (k === "completada") v = !!v;

        fields.push(`${k} = $${idx++}`);
        values.push(v);
      }
    }

    // Compat: PATCH vacío = marcar hecha y mover al final de 'done'
    if (!fields.length && emptyAsComplete) {
      const rOrden = await q(
        `SELECT COALESCE(MAX(orden),0) AS m
           FROM tareas
          WHERE estado='done' AND (${organizacion_id != null ? "organizacion_id = $1" : "organizacion_id IS NULL"})`,
        organizacion_id != null ? [organizacion_id] : []
      );
      const nextOrden = (rOrden.rows?.[0]?.m ?? 0) + 1;

      const rDone = await q(
        `
        UPDATE tareas
           SET estado='done',
               completada=TRUE,
               orden=$1
         WHERE id=$2 AND (${organizacion_id != null ? "organizacion_id = $3" : "organizacion_id IS NULL"})
         RETURNING id, titulo, descripcion, cliente_id, estado, orden, vence_en, completada, created_at, usuario_email
        `,
        organizacion_id != null ? [nextOrden, id, organizacion_id] : [nextOrden, id]
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
            status: t.estado,
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

    if (!fields.length) return res.status(400).json({ message: "Nada para actualizar" });

    values.push(id);
    if (organizacion_id != null) values.push(organizacion_id);

    const r = await q(
      `
      UPDATE tareas
         SET ${fields.join(", ")}
       WHERE id = $${idx++}
         AND (${organizacion_id != null ? "organizacion_id = $"+idx : "organizacion_id IS NULL"})
       RETURNING id, titulo, descripcion, cliente_id, estado, orden, vence_en, completada, created_at, usuario_email
      `,
      values
    );

    if (!r.rowCount) return res.status(404).json({ message: "Tarea no encontrada" });

    const t = r.rows[0];
    emitFlow(
      "crm.task.updated",
      {
        org_id: String(organizacion_id || ""),
        idempotency_key: `task:${t.id}:updated:${t.orden || 0}`,
        task: {
          id: String(t.id),
          title: t.titulo,
          status: t.estado,
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
    const bearer = getBearer(req);
    const { organizacion_id } = getUserFromReq(req);
    const id = toInt(req.params.id);
    const usuario_email = coerceText(req.body?.usuario_email || req.body?.assignee_email);

    if (id == null) return res.status(400).json({ message: "ID inválido" });
    if (!usuario_email) return res.status(400).json({ message: "usuario_email requerido" });

    const r = await q(
      `
      UPDATE tareas
         SET usuario_email = $1
       WHERE id = $2
         AND (${organizacion_id != null ? "organizacion_id = $3" : "organizacion_id IS NULL"})
       RETURNING id, titulo, descripcion, cliente_id, estado, orden, vence_en, completada, created_at, usuario_email
      `,
      organizacion_id != null ? [usuario_email, id, organizacion_id] : [usuario_email, id]
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
          status: t.estado,
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
    const bearer = getBearer(req);
    const { organizacion_id } = getUserFromReq(req);
    const id = toInt(req.params.id);
    if (id == null) return res.status(400).json({ message: "ID inválido" });

    // lee estado actual
    const cur = await q(
      `
      SELECT id, completada, estado, orden, vence_en, titulo, usuario_email
        FROM tareas
       WHERE id=$1 AND (${organizacion_id != null ? "organizacion_id = $2" : "organizacion_id IS NULL"})
      `,
      organizacion_id != null ? [id, organizacion_id] : [id]
    );
    if (!cur.rowCount) return res.status(404).json({ message: "Tarea no encontrada" });
    const row = cur.rows[0];

    let nuevoEstado = row.completada ? "todo" : "done";
    let nuevaOrden = row.orden;

    if (!row.completada) {
      const rOrden = await q(
        `SELECT COALESCE(MAX(orden),0) AS m FROM tareas WHERE estado='done' AND (${organizacion_id != null ? "organizacion_id = $1" : "organizacion_id IS NULL"})`,
        organizacion_id != null ? [organizacion_id] : []
      );
      nuevaOrden = (rOrden.rows?.[0]?.m ?? 0) + 1;
    }

    const upd = await q(
      `
      UPDATE tareas
         SET completada = NOT completada,
             estado = $1,
             orden = $2
       WHERE id=$3 AND (${organizacion_id != null ? "organizacion_id = $4" : "organizacion_id IS NULL"})
       RETURNING id, titulo, descripcion, cliente_id, estado, orden, vence_en, completada, created_at, usuario_email
      `,
      organizacion_id != null
        ? [nuevoEstado, nuevaOrden, id, organizacion_id]
        : [nuevoEstado, nuevaOrden, id]
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
          status: t.estado,
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
 * - Mueve las tareas listadas a `estado` y fija orden 1..N según el array.
 * - No toca otras tareas.
 */
router.patch("/reorder", authenticateToken, async (req, res) => {
  try {
    const bearer = getBearer(req);
    const { organizacion_id } = getUserFromReq(req);
    const estado = VALID_ESTADOS.includes(req.body?.estado) ? req.body.estado : "todo";
    const ids = Array.isArray(req.body?.ordered_ids)
      ? req.body.ordered_ids.map(toInt).filter((x) => x != null)
      : [];

    if (!ids.length) return res.status(400).json({ message: "ordered_ids requerido" });

    const params = [estado];
    const caseClauses = [];
    const inHolders = [];

    ids.forEach((id, i) => {
      params.push(id);
      caseClauses.push(`WHEN $${params.length} THEN ${i + 1}`);
      inHolders.push(`$${params.length}`);
    });

    if (organizacion_id != null) params.push(organizacion_id);

    const r = await q(
      `
      UPDATE tareas
         SET estado = $1,
             orden = CASE id
               ${caseClauses.join("\n")}
               ELSE orden
             END
       WHERE id IN (${inHolders.join(", ")})
         AND (${organizacion_id != null ? "organizacion_id = $" + params.length : "organizacion_id IS NULL"})
       RETURNING id, titulo, estado, orden, vence_en, usuario_email
      `,
      params
    );

    const updated = r.rows || [];

    // Emit por cada tarea (ligero, idempotency con nuevo orden)
    await Promise.all(
      updated.map((t) =>
        emitFlow(
          "crm.task.updated",
          {
            org_id: String(organizacion_id || ""),
            idempotency_key: `task:${t.id}:reorder:${t.orden}`,
            task: {
              id: String(t.id),
              title: t.titulo,
              status: t.estado,
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
    const bearer = getBearer(req);
    const { organizacion_id } = getUserFromReq(req);
    const id = toInt(req.params.id);
    if (id == null) return res.status(400).json({ message: "ID inválido" });

    // tomar datos para emitir antes de borrar
    const prev = await q(
      `
      SELECT id, titulo, estado, vence_en, usuario_email
        FROM tareas
       WHERE id=$1 AND (${organizacion_id != null ? "organizacion_id = $2" : "organizacion_id IS NULL"})
      `,
      organizacion_id != null ? [id, organizacion_id] : [id]
    );

    const r = await q(
      `
      DELETE FROM tareas
       WHERE id = $1
         AND (${organizacion_id != null ? "organizacion_id = $2" : "organizacion_id IS NULL"})
      `,
      organizacion_id != null ? [id, organizacion_id] : [id]
    );

    if (!r.rowCount) return res.status(404).json({ message: "Tarea no encontrada" });

    // Emit best-effort de deleted
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
            status: t.estado,
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
