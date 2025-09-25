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
 *  - metrics: { total_clientes, total_tareas, proximos_7d, total_proyectos }
 *  - topClientes: últimos 5 (clientes; si no hay → fallback por proyectos)
 *  - proximosSeguimientos: tareas (vencen en <= 7 días)
 *
 * Siempre responde 200 (estructura vacía si algo falla).
 */
router.get("/", authenticateToken, async (req, res) => {
  const out = {
    metrics: { total_clientes: 0, total_tareas: 0, proximos_7d: 0, total_proyectos: 0 },
    topClientes: [],
    proximosSeguimientos: [],
  };

  try {
    const { organizacion_id } = getUserFromReq(req);

    // ------ WHEREs / params dinámicos ------
    const pc = []; const wc = [];
    if (organizacion_id != null) { pc.push(organizacion_id); wc.push(`organizacion_id = $${pc.length}`); }
    const whereClientes = wc.length ? `WHERE ${wc.join(" AND ")}` : "";

    const pt = []; const wt = [];
    if (organizacion_id != null) { pt.push(organizacion_id); wt.push(`organizacion_id = $${pt.length}`); }
    const whereTareas = wt.length ? `WHERE ${wt.join(" AND ")}` : "";

    const pp = []; const wp = [];
    if (organizacion_id != null) { pp.push(organizacion_id); wp.push(`organizacion_id = $${pp.length}`); }
    const whereProyectos = wp.length ? `WHERE ${wp.join(" AND ")}` : "";

    // ------ Métricas (paralelo) ------
    const [rC, rT, rSeg, rP] = await Promise.all([
      q(`SELECT COUNT(*)::int AS total_clientes FROM clientes ${whereClientes}`, pc),
      q(`SELECT COUNT(*)::int AS total_tareas   FROM tareas   ${whereTareas}`,   pt),
      q(
        `SELECT COUNT(*)::int AS proximos_7d
           FROM tareas
          WHERE completada = FALSE
            AND vence_en IS NOT NULL
            AND vence_en <= NOW() + INTERVAL '7 days'
            ${organizacion_id != null ? `AND organizacion_id = $1` : ""}`,
        organizacion_id != null ? [organizacion_id] : []
      ),
      q(`SELECT COUNT(*)::int AS total_proyectos FROM proyectos ${whereProyectos}`, pp),
    ]);

    out.metrics.total_clientes   = Number(rC.rows?.[0]?.total_clientes ?? 0);
    out.metrics.total_tareas     = Number(rT.rows?.[0]?.total_tareas   ?? 0);
    out.metrics.proximos_7d      = Number(rSeg.rows?.[0]?.proximos_7d  ?? 0);
    out.metrics.total_proyectos  = Number(rP.rows?.[0]?.total_proyectos ?? 0);

    // ------ ¿existe created_at en clientes? ------
    const rCols = await q(
      `SELECT 1
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='clientes' AND column_name='created_at'`
    );
    const hasCreatedAt = rCols.rowCount > 0;

    // ------ Top clientes recientes (preferencia: clientes) ------
    const sqlTopClientes = `
      SELECT id, nombre, email, telefono,
             ${hasCreatedAt ? "created_at" : "NULL::timestamptz AS created_at"}
        FROM clientes
        ${whereClientes}
        ORDER BY ${hasCreatedAt ? "created_at DESC NULLS LAST" : "id DESC"}
        LIMIT 5
    `;
    const rTop = await q(sqlTopClientes, pc);
    let top = rTop.rows || [];

    // Fallback: si no hay clientes, intentamos derivar “top clientes” desde proyectos
    if (!top.length) {
      const pp2 = [];
      let whereP = "";
      if (organizacion_id != null) { pp2.push(organizacion_id); whereP = `WHERE p.organizacion_id = $1`; }

      const rTopP = await q(
        `
        SELECT
          COALESCE(c.id, p.cliente_id) AS id,
          COALESCE(c.nombre, p.cliente_nombre, p.nombre) AS nombre,
          COALESCE(c.email, p.email) AS email,
          COALESCE(c.telefono, p.telefono) AS telefono,
          p.created_at
        FROM proyectos p
        LEFT JOIN clientes c ON c.id = p.cliente_id
        ${whereP}
        ORDER BY p.created_at DESC NULLS LAST, p.id DESC
        LIMIT 5
        `,
        pp2
      );
      top = rTopP.rows || [];
    }

    out.topClientes = top;

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
    // Nunca 500; estructura vacía
    return res.status(200).json(out);
  }
});

export default router;
