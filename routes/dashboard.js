// routes/dashboard.js
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

/* ========================= GET / ========================= */
/**
 * Dashboard:
 *  - metrics: { total_clientes, total_tareas, proximos_7d }
 *  - topClientes: últimos 5 (por created_at si existe, sino por id)
 *  - proximosSeguimientos: tareas con due en <= 7 días
 *
 * Requisito MVP: si algo falla, devolver 200 con ceros/arrays vacíos (no 500).
 */
router.get("/", authenticateToken, async (req, res) => {
  const out = {
    metrics: { total_clientes: 0, total_tareas: 0, proximos_7d: 0 },
    topClientes: [],
    proximosSeguimientos: [],
  };

  try {
    const { organizacion_id } = getUserFromReq(req);

    // ------ WHERE dinámicos ------
    const paramsClientes = [];
    const whereClientes = [];
    if (organizacion_id != null) {
      paramsClientes.push(organizacion_id);
      whereClientes.push(`organizacion_id = $${paramsClientes.length}`);
    }
    const sqlWhereClientes = whereClientes.length ? `WHERE ${whereClientes.join(" AND ")}` : "";

    const paramsTareas = [];
    const whereTareas = [];
    if (organizacion_id != null) {
      paramsTareas.push(organizacion_id);
      whereTareas.push(`organizacion_id = $${paramsTareas.length}`);
    }
    const sqlWhereTareas = whereTareas.length ? `WHERE ${whereTareas.join(" AND ")}` : "";

    // ------ Métricas (paralelo) ------
    const [rC, rT, rSeg] = await Promise.all([
      q(`SELECT COUNT(*)::int AS total_clientes FROM clientes ${sqlWhereClientes}`, paramsClientes),
      q(`SELECT COUNT(*)::int AS total_tareas   FROM tareas   ${sqlWhereTareas}`,   paramsTareas),
      q(
        `SELECT COUNT(*)::int AS proximos_7d
           FROM tareas
          WHERE completada = FALSE
            AND vence_en IS NOT NULL
            AND vence_en <= NOW() + INTERVAL '7 days'
            ${organizacion_id != null ? `AND organizacion_id = $1` : ""}`,
        organizacion_id != null ? [organizacion_id] : []
      ),
    ]);

    out.metrics.total_clientes = Number(rC.rows?.[0]?.total_clientes ?? 0);
    out.metrics.total_tareas   = Number(rT.rows?.[0]?.total_tareas   ?? 0);
    out.metrics.proximos_7d    = Number(rSeg.rows?.[0]?.proximos_7d  ?? 0);

    // ------ ¿existe created_at en clientes? ------
    const rCols = await q(
      `SELECT 1
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='clientes' AND column_name='created_at'`
    );
    const hasCreatedAt = rCols.rowCount > 0;

    // ------ Top clientes recientes ------
    const sqlTop = `
      SELECT id, nombre, email, telefono,
             ${hasCreatedAt ? "created_at" : "NULL::timestamptz AS created_at"}
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
    if (organizacion_id != null) {
      paramsSeg.push(organizacion_id);
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
      ORDER BY t.vence_en ASC NULLS LAST, t.id DESC
      LIMIT 20
      `,
      paramsSeg
    );
    out.proximosSeguimientos = rProx.rows || [];

    return res.json(out);
  } catch (e) {
    console.error("[GET /dashboard] error:", e?.stack || e?.message || e);
    // Importante: nunca 500; devolvemos estructura vacía
    return res.status(200).json(out);
  }
});

export default router;
