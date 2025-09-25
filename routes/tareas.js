// routes/tareas.js
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

const VALID_ESTADOS = ["todo", "doing", "waiting", "done"];

/* =========================== GET =========================== */
/**
 * Lista tareas de la organización, con join a cliente.
 * Query opcionales: estado, q (busca en título/descr), cliente_id
 */
router.get("/", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id } = getUserFromReq(req);
    const { estado, q: qtext, cliente_id } = req.query || {};

    const params = [];
    const where = [];

    if (organizacion_id) {
      params.push(organizacion_id);
      where.push(`t.organizacion_id = $${params.length}`);
    }
    if (estado) {
      params.push(String(estado));
      where.push(`t.estado = $${params.length}`);
    }
    if (cliente_id) {
      params.push(parseInt(cliente_id, 10));
      where.push(`t.cliente_id = $${params.length}`);
    }
    if (qtext) {
      const like = `%${String(qtext).toLowerCase()}%`;
      params.push(like, like);
      where.push(
        `(lower(t.titulo) LIKE $${params.length - 1} OR lower(t.descripcion) LIKE $${params.length})`
      );
    }

    const r = await q(
      `
      SELECT
        t.id, t.titulo, t.descripcion, t.estado, t.orden, t.completada,
        t.vence_en, t.created_at, t.cliente_id, t.usuario_email,
        c.nombre AS cliente_nombre
      FROM tareas t
      LEFT JOIN clientes c ON c.id = t.cliente_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY t.estado ASC, t.orden ASC, t.created_at DESC, t.id DESC
      `,
      params
    );

    res.json(r.rows || []);
  } catch (e) {
    console.error("[GET /tareas]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error al obtener tareas" });
  }
});

/* =========================== POST ========================== */
/**
 * Crea una tarea.
 * Body mínimo: { titulo }
 * Opcionales: descripcion, cliente_id, vence_en, estado
 * - Si no envían estado, se usa 'todo'
 * - Si no envían orden, se coloca al final del carril
 */
router.post("/", authenticateToken, async (req, res) => {
  try {
    const { email: usuario_email, organizacion_id } = getUserFromReq(req);

    let {
      titulo,
      descripcion = null,
      cliente_id = null,
      vence_en = null,
      estado = "todo",
      orden = null,
    } = req.body || {};

    if (!titulo || !titulo.trim()) {
      return res.status(400).json({ message: "Título requerido" });
    }

    titulo = titulo.trim();
    descripcion = coerceText(descripcion);
    estado = VALID_ESTADOS.includes(estado) ? estado : "todo";
    vence_en = coerceDate(vence_en);
    cliente_id = cliente_id != null ? parseInt(cliente_id, 10) : null;

    // Si no envían orden, lo coloco al final del carril
    if (orden == null) {
      const r = await q(
        `SELECT COALESCE(MAX(orden),0) AS m FROM tareas WHERE estado = $1 AND organizacion_id = $2`,
        [estado, organizacion_id]
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

    res.status(201).json(ins.rows[0]);
  } catch (e) {
    console.error("[POST /tareas]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error al crear tarea" });
  }
});

/* ========== UPDATE genérico: PATCH y PUT comparten lógica ========== */
async function updateTaskGeneric(req, res, { emptyAsComplete = false } = {}) {
  try {
    const { organizacion_id } = getUserFromReq(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });

    const allowed = ["titulo","descripcion","cliente_id","vence_en","estado","orden","completada"];
    const fields = [];
    const values = [];
    let idx = 1;

    for (const k of allowed) {
      if (k in (req.body || {})) {
        let v = req.body[k];
        if (k === "titulo" || k === "descripcion") v = coerceText(v);
        if (k === "vence_en") v = coerceDate(v);
        if (k === "cliente_id") v = v != null ? parseInt(v, 10) : null;
        if (k === "estado" && v) v = VALID_ESTADOS.includes(v) ? v : "todo";
        if (k === "orden" && v != null) v = parseInt(v, 10);
        if (k === "completada") v = !!v;

        fields.push(`${k} = $${idx++}`);
        values.push(v);
      }
    }

    // Si no vino nada y se permite "marcar como hecha" por defecto (PATCH vacío desde el front)
    if (!fields.length && emptyAsComplete) {
      // mover a 'done' y marcar completada, colocando al final del carril
      const ordenQ = await q(
        `SELECT COALESCE(MAX(orden),0) AS m FROM tareas WHERE estado='done' AND organizacion_id=$1`,
        [organizacion_id]
      );
      const nextOrden = (ordenQ.rows?.[0]?.m ?? 0) + 1;

      const rDone = await q(
        `
        UPDATE tareas
           SET estado='done',
               completada=TRUE,
               orden=$1
         WHERE id=$2 AND organizacion_id=$3
         RETURNING id, titulo, descripcion, cliente_id, estado, orden, vence_en, completada, created_at, usuario_email
        `,
        [nextOrden, id, organizacion_id]
      );

      if (!rDone.rowCount) return res.status(404).json({ message: "Tarea no encontrada" });
      return res.json(rDone.rows[0]);
    }

    if (!fields.length) return res.status(400).json({ message: "Nada para actualizar" });

    values.push(id);
    values.push(organizacion_id);

    const r = await q(
      `
      UPDATE tareas
         SET ${fields.join(", ")}
       WHERE id = $${idx++} AND organizacion_id = $${idx}
       RETURNING id, titulo, descripcion, cliente_id, estado, orden, vence_en, completada, created_at, usuario_email
      `,
      values
    );

    if (!r.rowCount) return res.status(404).json({ message: "Tarea no encontrada" });
    return res.json(r.rows[0]);
  } catch (e) {
    console.error("[UPDATE /tareas/:id]", e?.stack || e?.message || e);
    return res.status(500).json({ message: "Error al editar tarea" });
  }
}

/* =========================== PATCH ========================= */
// PATCH vacío = marcar como hecha (compat con front viejo)
router.patch("/:id", authenticateToken, (req, res) =>
  updateTaskGeneric(req, res, { emptyAsComplete: true })
);

/* ============================ PUT ========================== */
// PUT = update (el front lo usa para editar y para reabrir)
router.put("/:id", authenticateToken, (req, res) =>
  updateTaskGeneric(req, res, { emptyAsComplete: false })
);

/* =================== PATCH /complete (toggle) =================== */
/**
 * Marca/desmarca completada. Body: { completada: boolean }
 * (El Kanban /kanban/tareas/:id/move ya actualiza completada cuando estado='done')
 */
router.patch("/:id/complete", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id } = getUserFromReq(req);
    const id = Number(req.params.id);
    const completada = !!req.body?.completada;

    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });

    const r = await q(
      `
      UPDATE tareas
         SET completada = $1
       WHERE id = $2 AND organizacion_id = $3
       RETURNING id, titulo, descripcion, cliente_id, estado, orden, vence_en, completada, created_at, usuario_email
      `,
      [completada, id, organizacion_id]
    );

    if (!r.rowCount) return res.status(404).json({ message: "Tarea no encontrada" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error("[PATCH /tareas/:id/complete]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error al completar tarea" });
  }
});

/* =========================== DELETE ========================= */
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id } = getUserFromReq(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });

    const r = await q(
      `DELETE FROM tareas WHERE id = $1 AND organizacion_id = $2`,
      [id, organizacion_id]
    );

    if (!r.rowCount) return res.status(404).json({ message: "Tarea no encontrada" });
    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /tareas/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error al eliminar tarea" });
  }
});

export default router;
