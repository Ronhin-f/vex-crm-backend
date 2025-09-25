// backend/routes/kanban.js
import { Router } from "express";
import { q, CANON_CATS } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";

const router = Router();

/* ---------------------------- helpers ---------------------------- */
function getUserFromReq(req) {
  const u = req.usuario || {};
  return {
    email: u.email ?? req.usuario_email ?? u.usuario_email ?? null,
    organizacion_id:
      u.organizacion_id ?? req.organizacion_id ?? u.organization_id ?? null,
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

/* ------------------ Pipeline (proyectos/clientes) ------------------ */
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
router.get("/kpis", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id } = getUserFromReq(req);

    // PROYECTOS por stage
    const pProj = [], wProj = [];
    if (organizacion_id) { pProj.push(organizacion_id); wProj.push(`organizacion_id = $${pProj.length}`); }
    const proyectosPorStage = await q(
      `SELECT COALESCE(stage,'Uncategorized') AS stage, COUNT(*)::int AS total
         FROM proyectos
        ${wProj.length ? "WHERE " + wProj.join(" AND ") : ""}
        GROUP BY stage
        ORDER BY total DESC`,
      pProj
    );

    // CLIENTES por stage/categoría
    const pCli = [], wCli = [];
    if (organizacion_id) { pCli.push(organizacion_id); wCli.push(`organizacion_id = $${pCli.length}`); }
    const clientesPorStage = await q(
      `SELECT COALESCE(stage,'Uncategorized') AS stage, COUNT(*)::int AS total
         FROM clientes
        ${wCli.length ? "WHERE " + wCli.join(" AND ") : ""}
        GROUP BY stage
        ORDER BY total DESC`,
      pCli
    );
    const clientesPorCat = await q(
      `SELECT COALESCE(categoria,'Uncategorized') AS categoria, COUNT(*)::int AS total
         FROM clientes
        ${wCli.length ? "WHERE " + wCli.join(" AND ") : ""}
        GROUP BY categoria
        ORDER BY total DESC`,
      pCli
    );

    // TAREAS por estado
    const pTask = [], wTask = [];
    if (organizacion_id) { pTask.push(organizacion_id); wTask.push(`organizacion_id = $${pTask.length}`); }
    const tareasPorEstado = await q(
      `SELECT COALESCE(estado,'todo') AS estado, COUNT(*)::int AS total
         FROM tareas
        ${wTask.length ? "WHERE " + wTask.join(" AND ") : ""}
        GROUP BY estado
        ORDER BY total DESC`,
      pTask
    );

    // Próximos 7 días
    const vencen7T = await q(
      `SELECT COUNT(*)::int AS total
         FROM tareas
        WHERE completada = FALSE
          AND vence_en IS NOT NULL
          AND vence_en <= NOW() + INTERVAL '7 days'
          ${organizacion_id ? "AND organizacion_id = $1" : ""}`,
      organizacion_id ? [organizacion_id] : []
    );
    const vencen7P = await q(
      `SELECT COUNT(*)::int AS total
         FROM proyectos
        WHERE due_date IS NOT NULL
          AND due_date <= NOW() + INTERVAL '7 days'
          ${organizacion_id ? "AND organizacion_id = $1" : ""}`,
      organizacion_id ? [organizacion_id] : []
    );

    res.json({
      proyectosPorStage: proyectosPorStage.rows || [],
      proximos7d_proyectos: vencen7P.rows?.[0]?.total ?? 0,
      clientesPorStage: clientesPorStage.rows || [],
      clientesPorCat: clientesPorCat.rows || [],
      tareasPorEstado: tareasPorEstado.rows || [],
      proximos7d: vencen7T.rows?.[0]?.total ?? 0,
      proximos_7d: vencen7T.rows?.[0]?.total ?? 0,
    });
  } catch (e) {
    console.error("[GET /kanban/kpis]", e?.stack || e?.message || e);
    res.json({
      proyectosPorStage: [], proximos7d_proyectos: 0,
      clientesPorStage: [], clientesPorCat: [],
      tareasPorEstado: [], proximos7d: 0, proximos_7d: 0,
    });
  }
});

/* ====================== Kanban de PROYECTOS ===================== */
router.get("/proyectos", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id } = getUserFromReq(req);
    const { q: qtext, source, assignee, stage, only_due } = req.query || {};
    const params = [], where = [];

    if (organizacion_id) { params.push(organizacion_id); where.push(`p.organizacion_id = $${params.length}`); }
    if (stage)   { params.push(String(stage));   where.push(`p.stage = $${params.length}`); }
    if (source)  { params.push(String(source));  where.push(`p.source = $${params.length}`); }
    if (assignee) {
      if (/^(sin asignar|unassigned)$/i.test(String(assignee))) {
        where.push(`(p.assignee IS NULL OR TRIM(p.assignee) = '')`);
      } else { params.push(String(assignee)); where.push(`p.assignee = $${params.length}`); }
    }
    if (qtext) {
      const qval = `%${String(qtext).trim()}%`; params.push(qval);
      const i = params.length;
      where.push(
        `(p.nombre ILIKE $${i}
          OR COALESCE(p.email, c.email) ILIKE $${i}
          OR COALESCE(p.telefono, c.telefono) ILIKE $${i}
          OR c.nombre ILIKE $${i})`
      );
    }
    if (isTruthy(only_due)) where.push(`p.due_date IS NOT NULL`);

    const rs = await q(
      `SELECT
         p.id, p.cliente_id,
         p.nombre,
         COALESCE(p.email, c.email)       AS email,
         COALESCE(p.telefono, c.telefono) AS telefono,
         p.stage, p.categoria, p.source, p.assignee, p.due_date,
         p.estimate_url, p.estimate_file, p.created_at,
         c.nombre AS cliente_nombre,
         COALESCE(p.contacto_nombre, c.contacto_nombre) AS contacto_nombre
       FROM proyectos p
       LEFT JOIN clientes c ON c.id = p.cliente_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY p.created_at DESC NULLS LAST, p.id DESC`,
      params
    );

    const bucket = new Map(ORDER.map(k => [k, []]));
    for (const row of rs.rows) {
      const key =
        PIPELINE_SET.has(row.stage) ? row.stage :
        PIPELINE_SET.has(row.categoria) ? row.categoria : "Lost";

      const estimateChip = !!(row.estimate_url || row.estimate_file);
      bucket.get(key)?.push({
        id: row.id,
        cliente_id: row.cliente_id,
        cliente_nombre: row.cliente_nombre || null,
        nombre: row.nombre,
        empresa: row.cliente_nombre || null,
        email: row.email,
        telefono: row.telefono,
        stage: row.stage,
        source: row.source,
        assignee: row.assignee,
        assignee_email: row.assignee,
        due_date: row.due_date,
        estimate_url: row.estimate_url,
        estimate: estimateChip,
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
    console.error("[GET /kanban/proyectos]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error obteniendo Kanban de proyectos" });
  }
});

router.patch("/proyectos/:id/move", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    let next = coerceText(req.body?.stage ?? req.body?.categoria);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });
    if (!next) return res.status(400).json({ message: "stage requerido" });
    if (!PIPELINE_SET.has(next) && !CANON_CATS.includes(next)) {
      return res.status(400).json({ message: "stage fuera del pipeline" });
    }

    const r = await q(
      `UPDATE proyectos
          SET stage = $1,
              categoria = $1
        WHERE id = $2
        RETURNING id, nombre, stage, categoria`,
      [next, id]
    );
    if (!r.rowCount) return res.status(404).json({ message: "Proyecto no encontrado" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error("[PATCH /kanban/proyectos/:id/move]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error moviendo proyecto" });
  }
});

/* ====================== Kanban de CLIENTES (compat) ===================== */
router.get("/clientes", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id } = getUserFromReq(req);
    const { q: qtext, source, assignee, stage, only_due } = req.query || {};
    const params = [], where = [];

    if (organizacion_id) { params.push(organizacion_id); where.push(`c.organizacion_id = $${params.length}`); }
    if (stage)   { params.push(String(stage));   where.push(`c.stage = $${params.length}`); }
    if (source)  { params.push(String(source));  where.push(`c.source = $${params.length}`); }
    if (assignee) {
      if (/^(sin asignar|unassigned)$/i.test(String(assignee))) {
        where.push(`(c.assignee IS NULL OR TRIM(c.assignee) = '')`);
      } else { params.push(String(assignee)); where.push(`c.assignee = $${params.length}`); }
    }
    if (qtext) {
      const qval = `%${String(qtext).trim()}%`; params.push(qval);
      const i = params.length;
      where.push(`(c.nombre ILIKE $${i} OR c.email ILIKE $${i} OR c.telefono ILIKE $${i})`);
    }
    if (isTruthy(only_due)) where.push(`c.due_date IS NOT NULL`);

    const rs = await q(
      `SELECT
         c.id, c.nombre, c.telefono, c.email,
         c.stage, c.categoria, c.source, c.assignee, c.due_date,
         c.estimate_url, c.estimate_file, c.created_at
       FROM clientes c
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY c.created_at DESC NULLS LAST, c.id DESC`,
      params
    );

    const bucket = new Map(ORDER.map(k => [k, []]));
    for (const row of rs.rows) {
      const key =
        PIPELINE_SET.has(row.stage) ? row.stage :
        PIPELINE_SET.has(row.categoria) ? row.categoria : "Lost";

      const estimateChip = !!(row.estimate_url || row.estimate_file);
      bucket.get(key)?.push({
        id: row.id,
        nombre: row.nombre,
        email: row.email,
        telefono: row.telefono,
        stage: row.stage,
        source: row.source,
        assignee: row.assignee,
        assignee_email: row.assignee,
        due_date: row.due_date,
        estimate_url: row.estimate_url,
        estimate: estimateChip,
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

router.patch("/clientes/:id/move", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    let next = coerceText(req.body?.stage ?? req.body?.categoria);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });
    if (!next) return res.status(400).json({ message: "stage requerido" });
    if (!PIPELINE_SET.has(next) && !CANON_CATS.includes(next)) {
      return res.status(400).json({ message: "stage fuera del pipeline" });
    }

    const r = await q(
      `UPDATE clientes
          SET stage = $1,
              categoria = $1
        WHERE id = $2
        RETURNING id, nombre, stage, categoria`,
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

// GET compatible: devuelve items[], columns{}, lanes[]
router.get("/tareas", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id } = getUserFromReq(req);
    const params = [], where = [];

    if (organizacion_id != null) { params.push(organizacion_id); where.push(`t.organizacion_id = $${params.length}`); }

    const r = await q(
      `SELECT
         t.id, t.titulo, t.descripcion, t.estado, t.orden, t.completada,
         t.vence_en, t.created_at, t.cliente_id, t.usuario_email,
         c.nombre AS cliente_nombre
       FROM tareas t
       LEFT JOIN clientes c ON c.id = t.cliente_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY t.estado ASC, t.orden ASC, t.created_at DESC, t.id DESC`,
      params
    );

    const rows = r.rows || [];

    // Plano
    const items = rows.map(row => ({
      id: row.id,
      titulo: row.titulo,
      descripcion: row.descripcion,
      estado: row.estado || "todo",
      orden: row.orden ?? 0,
      completada: !!row.completada,
      vence_en: row.vence_en,
      created_at: row.created_at,
      cliente_id: row.cliente_id,
      cliente_nombre: row.cliente_nombre || null,
      usuario_email: row.usuario_email || null,
    }));

    // Columns
    const columns = { todo: [], doing: [], waiting: [], done: [] };
    for (const it of items) {
      const lane = columns[it.estado] ? it.estado : "todo";
      columns[lane].push(it);
    }

    // Lanes
    const lanes = Object.entries(columns).map(([id, arr]) => ({
      id,
      title: id === "todo" ? "Por hacer" :
             id === "doing" ? "En curso" :
             id === "waiting" ? "En espera" : "Hecho",
      items: arr,
    }));

    res.json({ ok: true, items, columns, lanes });
  } catch (e) {
    console.error("[GET /kanban/tareas]", e?.stack || e?.message || e);
    // Respuesta "suave" para no romper el render del FE
    res.status(200).json({
      ok: true,
      items: [],
      columns: { todo: [], doing: [], waiting: [], done: [] },
      lanes: [
        { id: "todo", title: "Por hacer", items: [] },
        { id: "doing", title: "En curso", items: [] },
        { id: "waiting", title: "En espera", items: [] },
        { id: "done", title: "Hecho", items: [] },
      ],
    });
  }
});

router.patch("/tareas/:id/move", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id } = getUserFromReq(req);
    const id = Number(req.params.id);
    let { estado, orden } = req.body || {};
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });

    const valid = ["todo","doing","waiting","done"];
    if (!estado || !valid.includes(estado)) {
      return res.status(400).json({ message: "Estado inválido" });
    }

    // Si no se envía orden: al final del carril destino (por organización)
    if (orden == null) {
      const mr = await q(
        `SELECT COALESCE(MAX(orden),0) AS m
           FROM tareas
          WHERE estado = $1 AND ($2::text IS NULL OR organizacion_id = $2)`,
        [estado, organizacion_id ?? null]
      );
      orden = (mr.rows?.[0]?.m ?? 0) + 1;
    }

    const r = await q(
      `UPDATE tareas
          SET estado = $1,
              orden = $2,
              completada = CASE WHEN $1='done' THEN TRUE ELSE FALSE END
        WHERE id = $3 AND ($4::text IS NULL OR organizacion_id = $4)
        RETURNING id, titulo, estado, orden, completada`,
      [estado, orden, id, organizacion_id ?? null]
    );
    if (!r.rowCount) return res.status(404).json({ message: "Tarea no encontrada" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error("[PATCH /kanban/tareas/:id/move]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error moviendo tarea" });
  }
});

export default router;
