// routes/kanban.js
import { Router } from "express";
import { q, CANON_CATS } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";

const router = Router();

// ---------- KANBAN CLIENTES (pipeline fijo) ----------
router.get("/clientes", authenticateToken, async (req, res) => {
  try {
    const org = req.organizacion_id || null;

    // Orden por catálogo (global y por org), con fallback al orden CANON
    const cats = await q(
      `SELECT nombre, orden
         FROM categorias
        WHERE organizacion_id IS NULL OR organizacion_id = $1
        ORDER BY orden ASC, nombre ASC`,
      [org]
    );
    const order = cats.rowCount ? cats.rows.map(r => r.nombre) : CANON_CATS;

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

    // Inicializo columnas en orden canon
    const map = new Map(order.map(n => [n, []]));
    for (const row of rs.rows) {
      const key = order.includes(row.categoria) ? row.categoria : "Lost"; // bucket de descarte: Lost
      map.get(key).push(row);
    }

    const columns = order.map(name => ({
      key: name,
      title: name,
      count: map.get(name)?.length || 0,
      items: map.get(name) || []
    }));

    res.json({ columns });
  } catch (e) {
    console.error("[GET /kanban/clientes]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error obteniendo Kanban de clientes" });
  }
});

// mover cliente de etapa (solo a categorías canónicas)
router.patch("/clientes/:id/move", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    let { categoria } = req.body || {};
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });
    if (!categoria || typeof categoria !== "string") return res.status(400).json({ message: "Categoría requerida" });
    categoria = categoria.trim();
    if (!CANON_CATS.includes(categoria)) return res.status(400).json({ message: "Categoría no permitida" });

    // Garantizo que exista en catálogo global (si no, la creo con el orden canon)
    const idx = CANON_CATS.indexOf(categoria);
    await q(
      `INSERT INTO categorias (nombre, organizacion_id, orden)
       VALUES ($1, NULL, $2)
       ON CONFLICT (organizacion_id, nombre_ci) DO UPDATE SET orden=EXCLUDED.orden`,
      [categoria, idx]
    );

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

// ---------- KANBAN TAREAS (igual que antes) ----------
const TASK_COLUMNS = [
  { key: "todo",    title: "Por hacer" },
  { key: "doing",   title: "En curso" },
  { key: "waiting", title: "En espera" },
  { key: "done",    title: "Hecho" }
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
      items: byState.get(col.key) || []
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

    const p = [estado];
    let where = "WHERE estado=$1";
    if (orden == null) {
      const mr = await q(`SELECT COALESCE(MAX(orden),0) AS m FROM tareas ${where}`, p);
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
