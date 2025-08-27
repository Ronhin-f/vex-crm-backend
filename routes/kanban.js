// routes/kanban.js
import { Router } from "express";
import { q } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";

const router = Router();

// ---------- KPIs para dashboard ----------
router.get("/kpis", authenticateToken, async (req, res) => {
  try {
    const org = req.organizacion_id || null;

    const p1 = org ? [org] : [];
    const w1 = org ? "WHERE organizacion_id = $1" : "";
    const clientesPorCat = await q(
      `SELECT COALESCE(categoria,'Uncategorized') AS categoria, COUNT(*)::int AS total
         FROM clientes
         ${w1}
         GROUP BY categoria
         ORDER BY total DESC`,
      p1
    );

    const p2 = org ? [org] : [];
    const w2 = org ? "WHERE organizacion_id = $1" : "";
    const tareasPorEstado = await q(
      `SELECT COALESCE(estado,'todo') AS estado, COUNT(*)::int AS total
         FROM tareas
         ${w2}
         GROUP BY estado
         ORDER BY total DESC`,
      p2
    );

    const vencen7 = await q(
      `SELECT COUNT(*)::int AS total
         FROM tareas
        WHERE completada = FALSE
          AND vence_en IS NOT NULL
          AND vence_en <= NOW() + INTERVAL '7 days'
          ${org ? "AND organizacion_id = $1" : ""}`,
      org ? [org] : []
    );

    res.json({
      clientesPorCat: clientesPorCat.rows,
      tareasPorEstado: tareasPorEstado.rows,
      proximos7d: vencen7.rows?.[0]?.total ?? 0,
    });
  } catch (e) {
    console.error("[GET /kanban/kpis]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error obteniendo KPIs" });
  }
});

// ---------- Kanban de CLIENTES (pipeline fijo si te sirve) ----------
const PIPELINE = ["Incoming Leads", "Qualified", "Bid/Estimate Sent", "Won", "Lost"];

router.get("/clientes", authenticateToken, async (req, res) => {
  try {
    const org = req.organizacion_id || null;
    const params = [];
    let where = "";
    if (org) { params.push(org); where = `WHERE c.organizacion_id = $${params.length}`; }

    const rs = await q(
      `SELECT c.id, c.nombre, c.telefono, c.email, c.categoria, c.created_at
         FROM clientes c
         ${where}
         ORDER BY c.created_at DESC NULLS LAST, c.id DESC`,
      params
    );

    // armo columnas en orden del pipeline
    const map = new Map(PIPELINE.map(k => [k, []]));
    for (const row of rs.rows) {
      const key = PIPELINE.includes(row.categoria) ? row.categoria : "Lost";
      map.get(key).push(row);
    }

    const columns = PIPELINE.map(name => ({
      key: name,
      title: name,
      count: map.get(name)?.length || 0,
      items: map.get(name) || [],
    }));

    res.json({ columns });
  } catch (e) {
    console.error("[GET /kanban/clientes]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error obteniendo Kanban de clientes" });
  }
});

// mover cliente entre columnas del pipeline
router.patch("/clientes/:id/move", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    let { categoria } = req.body || {};
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });
    if (!categoria || typeof categoria !== "string") return res.status(400).json({ message: "Categoría requerida" });
    categoria = categoria.trim();
    if (!PIPELINE.includes(categoria)) return res.status(400).json({ message: "Categoría fuera del pipeline" });

    const r = await q(
      `UPDATE clientes SET categoria=$1 WHERE id=$2 RETURNING id, nombre, categoria`,
      [categoria, id]
    );
    if (!r.rowCount) return res.status(404).json({ message: "Cliente no encontrado" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error("[PATCH /kanban/clientes/:id/move]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error moviendo cliente" });
  }
});

// ---------- Kanban de TAREAS ----------
const TASK_COLUMNS = [
  { key: "todo",    title: "Por hacer" },
  { key: "doing",   title: "En curso" },
  { key: "waiting", title: "En espera" },
  { key: "done",    title: "Hecho" },
];

router.get("/tareas", authenticateToken, async (req, res) => {
  try {
    const org = req.organizacion_id || null;

    const params = [];
    let where = "";
    if (org) { params.push(org); where = `WHERE t.organizacion_id = $${params.length}`; }

    const rows = await q(
      `
      SELECT t.id, t.titulo, t.descripcion, t.estado, t.orden, t.completada,
             t.vence_en, t.created_at, t.cliente_id, c.nombre AS cliente_nombre
        FROM tareas t
        LEFT JOIN clientes c ON c.id = t.cliente_id
        ${where}
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
    if (!estado || !["todo","doing","waiting","done"].includes(estado))
      return res.status(400).json({ message: "Estado inválido" });

    // si no envían orden, lo pongo al final
    if (orden == null) {
      const mr = await q(
        `SELECT COALESCE(MAX(orden),0) AS m FROM tareas WHERE estado=$1`,
        [estado]
      );
      orden = (mr.rows?.[0]?.m ?? 0) + 1;
    }

    const r = await q(
      `UPDATE tareas
          SET estado=$1,
              orden=$2,
              completada = ($1 = 'done')
        WHERE id=$3
        RETURNING id, titulo, estado, orden, completada`,
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
