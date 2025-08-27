// Backend/routes/dashboard.js
import { Router } from "express";
import { q } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";

const router = Router();

// El dashboard requiere token válido (como ya tenías)
router.get("/", authenticateToken, async (req, res) => {
  const out = {
    metrics: { total_clientes: 0, total_tareas: 0, proximos_7d: 0 },
    topClientes: [],
    proximosSeguimientos: [],
  };

  try {
    const org = req.organizacion_id || null;

    // WHERE dinámico
    const whereClientes = [];
    const paramsClientes = [];
    if (org != null) {
      paramsClientes.push(org);
      whereClientes.push(`organizacion_id = $${paramsClientes.length}`);
    }
    const sqlWhereClientes = whereClientes.length ? `WHERE ${whereClientes.join(" AND ")}` : "";

    const whereTareas = [];
    const paramsTareas = [];
    if (org != null) {
      paramsTareas.push(org);
      whereTareas.push(`organizacion_id = $${paramsTareas.length}`);
    }
    const sqlWhereTareas = whereTareas.length ? `WHERE ${whereTareas.join(" AND ")}` : "";

    // ------ Métricas ------
    const [rC, rT, rSeg] = await Promise.all([
      q(`SELECT COUNT(*)::int AS total_clientes FROM clientes ${sqlWhereClientes}`, paramsClientes),
      q(`SELECT COUNT(*)::int AS total_tareas   FROM tareas   ${sqlWhereTareas}`,   paramsTareas),
      q(
        `SELECT COUNT(*)::int AS proximos_7d
           FROM tareas
          WHERE completada = FALSE
            AND vence_en IS NOT NULL
            AND vence_en <= NOW() + INTERVAL '7 days'
            ${org != null ? `AND organizacion_id = $1` : ""}`,
        org != null ? [org] : []
      ),
    ]);

    out.metrics.total_clientes = rC.rows?.[0]?.total_clientes ?? 0;
    out.metrics.total_tareas   = rT.rows?.[0]?.total_tareas   ?? 0;
    out.metrics.proximos_7d    = rSeg.rows?.[0]?.proximos_7d  ?? 0;

    // ------ ¿existe created_at en clientes? ------
    const rCols = await q(
      `SELECT 1
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='clientes' AND column_name='created_at'`
    );
    const hasCreatedAt = rCols.rowCount > 0;

    // ------ Top clientes recientes ------
    const sqlTop = `
      SELECT id, nombre, email, telefono, ${hasCreatedAt ? "created_at" : "NULL::timestamptz AS created_at"}
        FROM clientes
        ${sqlWhereClientes}
        ORDER BY ${hasCreatedAt ? "created_at DESC NULLS LAST" : "id DESC"}
        LIMIT 5
    `;
    const rTop = await q(sqlTop, paramsClientes);
    out.topClientes = rTop.rows || [];

    // ------ Próximos seguimientos (join a clientes) ------
    const paramsSeg = [];
    let whereSeg = `WHERE t.completada = FALSE AND t.vence_en IS NOT NULL AND t.vence_en <= NOW() + INTERVAL '7 days'`;
    if (org != null) {
      paramsSeg.push(org);
      whereSeg += ` AND t.organizacion_id = $${paramsSeg.length}`;
    }
    const rProx = await q(
      `
      SELECT
        t.id,
        t.titulo,
        t.descripcion,
        t.vence_en,
        t.completada,
        t.cliente_id,
        c.nombre AS cliente_nombre
      FROM tareas t
      LEFT JOIN clientes c ON c.id = t.cliente_id
      ${whereSeg}
      ORDER BY t.vence_en ASC NULLS LAST
      LIMIT 20
      `,
      paramsSeg
    );
    out.proximosSeguimientos = rProx.rows || [];

    return res.json(out);
  } catch (e) {
    console.error("[GET /dashboard] error:", e?.stack || e?.message || e);
    // NUNCA devolvemos 500 crudo al front
    return res.status(200).json(out);
  }
});

export default router;
