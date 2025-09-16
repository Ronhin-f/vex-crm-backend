// routes/kanban.js
import { Router } from "express";
import { q, CANON_CATS } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";

const router = Router();

/* ---------------------------- helpers ---------------------------- */
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
function isTruthy(v) {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "t" || s === "yes" || s === "y" || s === "on";
}

// Pipeline preferido por la UI (agrega 2 columnas extra a las canónicas)
const ORDER = [
  "Incoming Leads",
  "Unqualified",
  "Qualified",
  "Follow-up Missed",
  "Bid/Estimate Sent",
  "Won",
  "Lost",
];
const PIPELINE_SET = new Set(ORDER);

/* ============================ KPIs ============================ */
/**
 * KPIs para dashboard:
 *  - clientesPorStage (usa stage; fallback a "Uncategorized")
 *  - clientesPorCat   (compat por categoría)
 *  - tareasPorEstado
 *  - proximos7d (tareas con due en <= 7 días, incompletas)
 *
 * Debe devolver zeros/arrays vacíos si no hay datos (no 500).
 */
router.get("/kpis", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id } = getUserFromReq(req);

    // ---- Clientes por STAGE
    const p1 = [];
    const w1 = [];
    if (organizacion_id) {
      p1.push(organizacion_id);
      w1.push(`organizacion_id = $${p1.length}`);
    }
    const clientesPorStage = await q(
      `
      SELECT COALESCE(stage,'Uncategorized') AS stage, COUNT(*)::int AS total
        FROM clientes
       ${w1.length ? "WHERE " + w1.join(" AND ") : ""}
       GROUP BY stage
       ORDER BY total DESC
      `,
      p1
    );

    // ---- Compat: Clientes por CATEGORÍA
    const clientesPorCat = await q(
      `
      SELECT COALESCE(categoria,'Uncategorized') AS categoria, COUNT(*)::int AS total
        FROM clientes
       ${w1.length ? "WHERE " + w1.join(" AND ") : ""}
       GROUP BY categoria
       ORDER BY total DESC
      `,
      p1
    );

    // ---- Tareas por estado
    const p2 = [];
    const w2 = [];
    if (organizacion_id) {
      p2.push(organizacion_id);
      w2.push(`organizacion_id = $${p2.length}`);
    }
    const tareasPorEstado = await q(
      `
      SELECT COALESCE(estado,'todo') AS estado, COUNT(*)::int AS total
        FROM tareas
       ${w2.length ? "WHERE " + w2.join(" AND ") : ""}
       GROUP BY estado
       ORDER BY total DESC
      `,
      p2
    );

    // ---- Tareas que vencen en <= 7 días (incompletas)
    const vencen7 = await q(
      `
      SELECT COUNT(*)::int AS total
        FROM tareas
       WHERE completada = FALSE
         AND vence_en IS NOT NULL
         AND vence_en <= NOW() + INTERVAL '7 days'
         ${organizacion_id ? "AND organizacion_id = $1" : ""}
      `,
      organizacion_id ? [organizacion_id] : []
    );

    const prox7 = vencen7.rows?.[0]?.total ?? 0;

    res.json({
      clientesPorStage: clientesPorStage.rows || [],
      clientesPorCat: clientesPorCat.rows || [],
      tareasPorEstado: tareasPorEstado.rows || [],
      proximos7d: prox7,
      proximos_7d: prox7,
    });
  } catch (e) {
    console.error("[GET /kanban/kpis]", e?.stack || e?.message || e);
    res.json({
      clientesPorStage: [],
      clientesPorCat: [],
      tareasPorEstado: [],
      proximos7d: 0,
      proximos_7d: 0,
    });
  }
});

/* ====================== Kanban de CLIENTES ===================== */
/**
 * Devuelve columnas del pipeline con tarjetas ricas para la UI:
 *  - id, nombre, email, telefono
 *  - stage, source, assignee(+alias assignee_email), due_date
 *  - estimate_url (y flag si hay file), created_at
 *
 * Acepta filtros: q, source, assignee ("Sin asignar"), stage, only_due=1|true
 */
router.get("/clientes", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id } = getUserFromReq(req);
    const { q: qtext, source, assignee, stage, only_due } = req.query || {};

    const params = [];
    const where = [];

    if (organizacion_id) {
      params.push(organizacion_id);
      where.push(`c.organizacion_id = $${params.length}`);
    }
    if (stage) {
      params.push(String(stage));
      where.push(`c.stage = $${params.length}`);
    }
    if (source) {
      params.push(String(source));
      where.push(`c.source = $${params.length}`);
    }
    if (assignee) {
      if (/^(sin asignar|unassigned)$/i.test(String(assignee))) {
        where.push(`(c.assignee IS NULL OR TRIM(c.assignee) = '')`);
      } else {
        params.push(String(assignee));
        where.push(`c.assignee = $${params.length}`);
      }
    }
    if (qtext) {
      const qval = `%${String(qtext).trim()}%`;
      params.push(qval);
      const idx = params.length;
      where.push(
        `(c.nombre ILIKE $${idx} OR c.email ILIKE $${idx} OR c.telefono ILIKE $${idx})`
      );
    }
    if (isTruthy(only_due)) {
      where.push(`c.due_date IS NOT NULL`);
    }

    const rs = await q(
      `
      SELECT
        c.id, c.nombre, c.telefono, c.email,
        c.stage, c.categoria, c.source, c.assignee, c.due_date,
        c.estimate_url, c.estimate_file, c.created_at
      FROM clientes c
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY c.created_at DESC NULLS LAST, c.id DESC
      `,
      params
    );

    const bucket = new Map(ORDER.map(k => [k, []]));
    for (const row of rs.rows) {
      const key =
        PIPELINE_SET.has(row.stage) ? row.stage
        : PIPELINE_SET.has(row.categoria) ? row.categoria
        : "Lost"; // fallback sólido para no mezclar "Uncategorized" en la demo

      const estimateChip = !!(row.estimate_url || row.estimate_file);
      bucket.get(key)?.push({
        id: row.id,
        nombre: row.nombre,
        email: row.email,
        telefono: row.telefono,
        stage: row.stage,
        source: row.source,
        assignee: row.assignee,
        assignee_email: row.assignee, // alias para FE
        due_date: row.due_date,
        estimate_url: row.estimate_url,
        estimate: estimateChip,       // flag para mostrar chip en UI
        created_at: row.created_at,
      });
    }

    const columns = ORDER.map(name => ({
      key: name,
      title: name,
      count: bucket.get(name)?.length || 0,
      items: bucket.get(name) || [],
    }));

    res.json({ columns, order: ORDER });
  } catch (e) {
    console.error("[GET /kanban/clientes]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error obteniendo Kanban de clientes" });
  }
});

/**
 * Move one-click del pipeline
 * Body: { stage: "Qualified" }  (acepta "categoria" por compat)
 * Espeja stage <-> categoria para evitar inconsistencias con instalaciones viejas.
 */
router.patch("/clientes/:id/move", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    let next = coerceText(req.body?.stage ?? req.body?.categoria);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });
    if (!next) return res.status(400).json({ message: "stage requerido" });
    // Permitimos también las columnas extra del ORDER
    if (!PIPELINE_SET.has(next) && !CANON_CATS.includes(next)) {
      return res.status(400).json({ message: "stage fuera del pipeline" });
    }

    const r = await q(
      `
      UPDATE clientes
         SET stage = $1,
             categoria = $1
       WHERE id = $2
       RETURNING id, nombre, stage, categoria
      `,
      [next, id]
    );
    if (!r.rowCount) return res.status(404).json({ message: "Cliente no encontrado" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error("[PATCH /kanban/clientes/:id/move]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error moviendo cliente" });
  }
});

/* ======================= Kanban de TAREAS ====================== */
const TASK_COLUMNS = [
  { key: "todo",    title: "Por hacer"  },
  { key: "doing",   title: "En curso"   },
  { key: "waiting", title: "En espera"  },
  { key: "done",    title: "Hecho"      },
];

router.get("/tareas", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id } = getUserFromReq(req);

    const params = [];
    const where = [];
    if (organizacion_id) {
      params.push(organizacion_id);
      where.push(`t.organizacion_id = $${params.length}`);
    }

    const rows = await q(
      `
      SELECT
        t.id, t.titulo, t.descripcion, t.estado, t.orden, t.completada,
        t.vence_en, t.created_at, t.cliente_id, c.nombre AS cliente_nombre
      FROM tareas t
      LEFT JOIN clientes c ON c.id = t.cliente_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY t.estado ASC, t.orden ASC, t.created_at DESC
      `,
      params
    );

    const byState = new Map(TASK_COLUMNS.map(c => [c.key, []]));
    for (const r of rows.rows) {
      const key = r.estado || "todo";
      if (!byState.has(key)) byState.set(key, []);
      byState.get(key).push(r);
    }

    const columns = TASK_COLUMNS.map(col => ({
      key: col.key,
      title: col.title,
      count: (byState.get(col.key) || []).length,
      items: byState.get(col.key) || [],
    }));

    res.json({ columns });
  } catch (e) {
    console.error("[GET /kanban/tareas]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error obteniendo Kanban de tareas" });
  }
});

router.patch("/tareas/:id/move", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    let { estado, orden } = req.body || {};
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });

    const valid = ["todo","doing","waiting","done"];
    if (!estado || !valid.includes(estado))
      return res.status(400).json({ message: "Estado inválido" });

    // si no envían orden, lo pongo al final del carril
    if (orden == null) {
      const mr = await q(
        `SELECT COALESCE(MAX(orden),0) AS m FROM tareas WHERE estado=$1`,
        [estado]
      );
      orden = (mr.rows?.[0]?.m ?? 0) + 1;
    }

    const r = await q(
      `
      UPDATE tareas
         SET estado=$1,
             orden=$2,
             completada = ($1 = 'done')
       WHERE id=$3
       RETURNING id, titulo, estado, orden, completada
      `,
      [estado, orden, id]
    );
    if (!r.rowCount) return res.status(404).json({ message: "Tarea no encontrada" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error("[PATCH /kanban/tareas/:id/move]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error moviendo tarea" });
  }
});

export default router;
