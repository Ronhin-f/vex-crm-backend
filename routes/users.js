// routes/tareas.js — Tareas CRUD + KPIs
import { Router } from "express";
import { authenticateToken as auth } from "../middleware/auth.js";
import { q } from "../utils/db.js";
import axios from "axios";

const router = Router();

/* -------------------- helpers -------------------- */
const T = (v) => (v == null ? null : String(v).trim() || null);
const N = (v) => (v == null || v === "" ? null : Number(v));
const D = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
};
function getOrg(req) {
  return (
    T(req.usuario?.organizacion_id) ||
    T(req.headers["x-org-id"]) ||
    T(req.query.organizacion_id) ||
    null
  );
}

// opcional: enviar a Flows si está configurado
async function emitFlow(type, payload) {
  const base = process.env.FLOWS_BASE_URL;
  const token = process.env.FLOWS_BEARER;
  if (!base || !token) return;
  try {
    await axios.post(
      `${base.replace(/\/+$/, "")}/api/triggers/emit`,
      { type, payload },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }
    );
  } catch (e) {
    console.warn("[tareas.emitFlow]", e?.message || e);
  }
}

/* -------------------- esquema mínimo -------------------- */
async function ensureSchema() {
  // sin enums para no bloquear despliegues
  await q(`
    CREATE TABLE IF NOT EXISTS tareas (
      id               SERIAL PRIMARY KEY,
      organizacion_id  TEXT NOT NULL,
      titulo           TEXT NOT NULL,
      descripcion      TEXT,
      cliente_id       INTEGER,
      vence_en         TIMESTAMPTZ,
      usuario_email    TEXT,
      prioridad        TEXT DEFAULT 'media',  -- 'alta' | 'media' | 'baja'
      estado           TEXT DEFAULT 'todo',   -- 'todo' | 'doing' | 'waiting' | 'done'
      completada       BOOLEAN DEFAULT FALSE,
      recordatorio     BOOLEAN DEFAULT FALSE,
      created_at       TIMESTAMPTZ DEFAULT now(),
      updated_at       TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_tareas_org ON tareas (organizacion_id);
    CREATE INDEX IF NOT EXISTS idx_tareas_org_estado ON tareas (organizacion_id, estado);
    CREATE INDEX IF NOT EXISTS idx_tareas_org_vence ON tareas (organizacion_id, vence_en);
  `);
  // vista simple para KPIs
  await q(`
    CREATE OR REPLACE VIEW v_tareas_overview AS
    SELECT
      organizacion_id,
      COUNT(*) FILTER (WHERE NOT completada) AS open_total,
      COUNT(*) FILTER (WHERE NOT completada AND vence_en IS NOT NULL AND vence_en < now()) AS overdue,
      COUNT(*) FILTER (WHERE NOT completada AND vence_en IS NOT NULL AND vence_en >= now() AND vence_en < now() + interval '7 days') AS due_next_7,
      COUNT(*) FILTER (WHERE NOT completada AND prioridad = 'alta') AS open_high,
      COUNT(*) FILTER (WHERE NOT completada AND prioridad = 'media') AS open_med,
      COUNT(*) FILTER (WHERE NOT completada AND prioridad = 'baja') AS open_low
    FROM tareas
    GROUP BY organizacion_id;
  `);
}
ensureSchema().catch((e) => console.error("[tareas.ensureSchema]", e?.message || e));

/* -------------------- GET /tareas -------------------- */
router.get("/", auth, async (req, res) => {
  try {
    const org = getOrg(req);
    if (!org) return res.json([]); // no rompas el FE

    const { q: qtext, estado, prioridad, assignee, cliente_id } = req.query || {};
    const params = [org];
    const where = ["t.organizacion_id = $1"];

    if (qtext) {
      params.push(`%${String(qtext).trim()}%`);
      const i = params.length;
      where.push(`(t.titulo ILIKE $${i} OR t.descripcion ILIKE $${i})`);
    }
    if (estado)     { params.push(String(estado));     where.push(`t.estado = $${params.length}`); }
    if (prioridad)  { params.push(String(prioridad));  where.push(`t.prioridad = $${params.length}`); }
    if (assignee)   { params.push(String(assignee));   where.push(`t.usuario_email = $${params.length}`); }
    if (cliente_id) { params.push(Number(cliente_id)); where.push(`t.cliente_id = $${params.length}`); }

    const sql = `
      SELECT
        t.*,
        c.email  AS cliente_email,
        c.nombre AS cliente_nombre
      FROM tareas t
      LEFT JOIN clientes c ON c.id = t.cliente_id
      WHERE ${where.join(" AND ")}
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT 2000
    `;
    const r = await q(sql, params);
    res.json(r.rows || []);
  } catch (e) {
    console.error("[GET /tareas]", e?.stack || e?.message || e);
    res.json([]); // compat FE
  }
});

/* -------------------- POST /tareas -------------------- */
router.post("/", auth, async (req, res) => {
  try {
    const org = getOrg(req);
    if (!org) return res.status(400).json({ ok: false, message: "organizacion_id requerido" });

    const b = req.body || {};
    const titulo = T(b.titulo);
    if (!titulo) return res.status(400).json({ ok: false, message: "Título requerido" });

    const r = await q(
      `
      INSERT INTO tareas (
        organizacion_id, titulo, descripcion, cliente_id, vence_en,
        usuario_email, prioridad, estado, completada, recordatorio, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
      RETURNING *
      `,
      [
        org,
        titulo,
        T(b.descripcion),
        N(b.cliente_id),
        D(b.vence_en),
        T(b.usuario_email),
        (T(b.prioridad) || "media").toLowerCase(),
        T(b.estado) || "todo",
        !!b.completada,
        !!b.recordatorio,
      ]
    );
    const item = r.rows[0];

    // aviso opcional
    emitFlow("task.created", {
      org,
      task: {
        id: String(item.id),
        title: item.titulo,
        due: item.vence_en,
        assignee: item.usuario_email || null,
        priority: item.prioridad,
      },
      meta: { source: "vex-crm" },
    }).catch(() => {});

    res.status(201).json(item);
  } catch (e) {
    console.error("[POST /tareas]", e?.stack || e?.message || e);
    res.status(500).json({ ok: false, message: "Error creando tarea" });
  }
});

/* -------------------- PATCH /tareas/:id -------------------- */
router.patch("/:id", auth, async (req, res) => {
  try {
    const org = getOrg(req);
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, message: "ID inválido" });

    const sets = [];
    const values = [];
    let i = 1;

    const allowed = {
      titulo: (v) => T(v),
      descripcion: (v) => T(v),
      cliente_id: (v) => N(v),
      vence_en: (v) => D(v),
      usuario_email: (v) => T(v),
      prioridad: (v) => (T(v) || "media").toLowerCase(),
      estado: (v) => T(v),
      completada: (v) => !!v,
      recordatorio: (v) => !!v,
    };

    for (const [k, conv] of Object.entries(allowed)) {
      if (k in (req.body || {})) {
        sets.push(`${k} = $${i++}`);
        values.push(conv(req.body[k]));
      }
    }
    if (!sets.length) return res.status(400).json({ ok: false, message: "Nada para actualizar" });
    sets.push("updated_at = now()");
    values.push(id);
    if (org) values.push(org);

    const r = await q(
      `
      UPDATE tareas
         SET ${sets.join(", ")}
       WHERE id = $${i++} ${org ? `AND organizacion_id = $${i}` : ""}
       RETURNING *
      `,
      values
    );
    if (!r.rowCount) return res.status(404).json({ ok: false, message: "Tarea no encontrada" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error("[PATCH /tareas/:id]", e?.stack || e?.message || e);
    res.status(500).json({ ok: false, message: "Error actualizando tarea" });
  }
});

/* -------------------- DELETE /tareas/:id -------------------- */
router.delete("/:id", auth, async (req, res) => {
  try {
    const org = getOrg(req);
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, message: "ID inválido" });

    const r = await q(
      `DELETE FROM tareas WHERE id = $1 ${org ? "AND organizacion_id = $2" : ""}`,
      org ? [id, org] : [id]
    );
    if (!r.rowCount) return res.status(404).json({ ok: false, message: "Tarea no encontrada" });
    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /tareas/:id]", e?.stack || e?.message || e);
    res.status(500).json({ ok: false, message: "Error eliminando tarea" });
  }
});

/* -------------------- KPIs: GET /tareas/kpis -------------------- */
router.get("/kpis", auth, async (req, res) => {
  try {
    const org = getOrg(req);
    if (!org) return res.json({ ok: true, kpis: {} });
    const r = await q(`SELECT * FROM v_tareas_overview WHERE organizacion_id = $1`, [org]);
    const row = r.rows[0] || {};
    res.json({
      ok: true,
      kpis: {
        open_total: Number(row.open_total || 0),
        overdue: Number(row.overdue || 0),
        due_next_7: Number(row.due_next_7 || 0),
        by_priority: {
          alta: Number(row.open_high || 0),
          media: Number(row.open_med || 0),
          baja: Number(row.open_low || 0),
        },
      },
    });
  } catch (e) {
    console.error("[GET /tareas/kpis]", e?.stack || e?.message || e);
    res.json({ ok: true, kpis: {} });
  }
});

export default router;
