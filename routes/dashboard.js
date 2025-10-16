// routes/dashboard.js
import { Router } from "express";
import { q } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";

const router = Router();

/* ------------------------ helpers ------------------------ */
function getUserFromReq(req) {
  const u = req.usuario || {};
  return {
    email: u.email ?? req.usuario_email ?? u.usuario_email ?? null,
    organizacion_id: u.organizacion_id ?? req.organizacion_id ?? u.organization_id ?? null,
  };
}

/* ========================= GET / ========================= */
/**
 * Dashboard payload:
 *  - metrics: {
 *      won, lost, win_rate, unqualified,
 *      followups_7d, overdue,
 *      total_clientes, total_tareas, total_proyectos,
 *      contactability, first_touch_p50_min, first_touch_avg_min
 *    }
 *  - topClientes: últimos 5 (por created_at si existe; fallback proyectos)
 *  - proximosSeguimientos: tareas a 7d (join clientes)
 */
router.get("/", authenticateToken, async (req, res) => {
  const out = {
    metrics: {
      won: 0, lost: 0, win_rate: 0,
      unqualified: 0,
      followups_7d: 0, overdue: 0,
      total_clientes: 0, total_tareas: 0, total_proyectos: 0,
      contactability: 0,
      first_touch_p50_min: 0, first_touch_avg_min: 0,
    },
    topClientes: [],
    proximosSeguimientos: [],
  };

  try {
    const { organizacion_id } = getUserFromReq(req);

    /* -------- WHEREs dinámicos -------- */
    const pC = []; const wC = [];
    if (organizacion_id != null) { pC.push(organizacion_id); wC.push(`organizacion_id = $${pC.length}`); }
    const whereClientes = wC.length ? `WHERE ${wC.join(" AND ")}` : "";

    const pT = []; const wT = [];
    if (organizacion_id != null) { pT.push(organizacion_id); wT.push(`organizacion_id = $${pT.length}`); }
    const whereTareas = wT.length ? `WHERE ${wT.join(" AND ")}` : "";

    const pP = []; const wP = [];
    if (organizacion_id != null) { pP.push(organizacion_id); wP.push(`organizacion_id = $${pP.length}`); }
    const whereProyectos = wP.length ? `WHERE ${wP.join(" AND ")}` : "";

    /* -------- Métricas base -------- */
    const [rClientes, rTareas, rProyectos] = await Promise.all([
      q(`SELECT COUNT(*)::int AS total FROM clientes ${whereClientes}`, pC),
      q(`SELECT COUNT(*)::int AS total FROM tareas   ${whereTareas}`,   pT),
      q(`SELECT COUNT(*)::int AS total FROM proyectos ${whereProyectos}`, pP),
    ]);
    out.metrics.total_clientes  = Number(rClientes.rows?.[0]?.total || 0);
    out.metrics.total_tareas    = Number(rTareas.rows?.[0]?.total   || 0);
    out.metrics.total_proyectos = Number(rProyectos.rows?.[0]?.total|| 0);

    /* -------- Won/Lost/Unqualified -------- */
    const rStages = await q(
      `
      SELECT
        SUM(CASE WHEN stage = 'Won'          THEN 1 ELSE 0 END)::int AS won,
        SUM(CASE WHEN stage = 'Lost'         THEN 1 ELSE 0 END)::int AS lost,
        SUM(CASE WHEN stage = 'Unqualified'  THEN 1 ELSE 0 END)::int AS unqualified
      FROM proyectos
      ${whereProyectos}
      `,
      pP
    );
    const won  = Number(rStages.rows?.[0]?.won || 0);
    const lost = Number(rStages.rows?.[0]?.lost || 0);
    const unq  = Number(rStages.rows?.[0]?.unqualified || 0);
    out.metrics.won = won;
    out.metrics.lost = lost;
    out.metrics.unqualified = unq;
    out.metrics.win_rate = (won + lost) > 0 ? Math.round((won / (won + lost)) * 100) : 0;

    /* -------- Follow-ups 7d / Overdue (tareas) -------- */
    const rFup = await q(
      `
      SELECT
        SUM(CASE WHEN completada = FALSE
                  AND vence_en IS NOT NULL
                  AND vence_en <= NOW() + INTERVAL '7 days'
                  AND vence_en >= NOW()
            THEN 1 ELSE 0 END)::int AS f7,
        SUM(CASE WHEN completada = FALSE
                  AND vence_en IS NOT NULL
                  AND vence_en < NOW()
            THEN 1 ELSE 0 END)::int AS overdue
      FROM tareas
      ${whereTareas}
      `,
      pT
    );
    out.metrics.followups_7d = Number(rFup.rows?.[0]?.f7 || 0);
    out.metrics.overdue      = Number(rFup.rows?.[0]?.overdue || 0);

    /* -------- Contactability (clientes con email o teléfono) -------- */
    const rCont = await q(
      `
      SELECT
        COUNT(*)::int AS total,
        SUM(
          CASE WHEN COALESCE(NULLIF(TRIM(email),''), NULLIF(TRIM(telefono),'')) IS NOT NULL
               THEN 1 ELSE 0 END
        )::int AS contactable
      FROM clientes
      ${whereClientes}
      `,
      pC
    );
    const totalCli = Number(rCont.rows?.[0]?.total || 0);
    const contact  = Number(rCont.rows?.[0]?.contactable || 0);
    out.metrics.contactability = totalCli > 0 ? Math.round((contact / totalCli) * 100) : 0;

    /* -------- First touch (minutos) p50 y avg --------
       Min(tareas.created_at) - clientes.created_at por cliente con al menos 1 tarea
    */
    const rTouch = await q(
      `
      WITH firsts AS (
        SELECT c.id AS cliente_id,
               EXTRACT(EPOCH FROM (MIN(t.created_at) - c.created_at))/60.0 AS mins
        FROM clientes c
        JOIN tareas   t ON t.cliente_id = c.id
        ${organizacion_id != null ? `WHERE c.organizacion_id = $1` : ``}
        GROUP BY c.id, c.created_at
        HAVING MIN(t.created_at) IS NOT NULL AND c.created_at IS NOT NULL
      )
      SELECT
        COALESCE(ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY mins)::numeric), 0) AS p50,
        COALESCE(ROUND(AVG(mins)::numeric), 0) AS avg
      FROM firsts
      `,
      organizacion_id != null ? [organizacion_id] : []
    );
    out.metrics.first_touch_p50_min = Number(rTouch.rows?.[0]?.p50 || 0);
    out.metrics.first_touch_avg_min = Number(rTouch.rows?.[0]?.avg || 0);

    /* -------- Top clientes recientes (si existe created_at) -------- */
    const rCols = await q(
      `SELECT 1
         FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name='clientes'
          AND column_name='created_at'`
    );
    const hasCreatedAt = rCols.rowCount > 0;

    const sqlTopClientes = `
      SELECT id, nombre, email, telefono,
             ${hasCreatedAt ? "created_at" : "NULL::timestamptz AS created_at"}
        FROM clientes
        ${whereClientes}
        ORDER BY ${hasCreatedAt ? "created_at DESC NULLS LAST" : "id DESC"}
        LIMIT 5
    `;
    let top = (await q(sqlTopClientes, pC)).rows || [];

    // Fallback: derivar desde proyectos si no hay clientes
    if (!top.length) {
      const p2 = [];
      let w = "";
      if (organizacion_id != null) { p2.push(organizacion_id); w = `WHERE p.organizacion_id = $1`; }
      const rTopP = await q(
        `
        SELECT
          COALESCE(c.id, p.cliente_id) AS id,
          COALESCE(c.nombre, p.nombre)  AS nombre,
          COALESCE(c.email,  NULL)      AS email,
          COALESCE(c.telefono, NULL)    AS telefono,
          p.created_at
        FROM proyectos p
        LEFT JOIN clientes c ON c.id = p.cliente_id
        ${w}
        ORDER BY p.created_at DESC NULLS LAST, p.id DESC
        LIMIT 5
        `,
        p2
      );
      top = rTopP.rows || [];
    }
    out.topClientes = top;

    /* -------- Próximos seguimientos (<= 7 días) -------- */
    const paramsSeg = [];
    let whereSeg = `WHERE t.completada = FALSE AND t.vence_en IS NOT NULL AND t.vence_en <= NOW() + INTERVAL '7 days'`;
    if (organizacion_id != null) {
      paramsSeg.push(organizacion_id);
      whereSeg += ` AND t.organizacion_id = $${paramsSeg.length}`;
    }
    const rProx = await q(
      `
      SELECT
        t.id, t.titulo, t.descripcion, t.vence_en, t.completada,
        t.cliente_id, c.nombre AS cliente_nombre
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
    // Nunca 500; estructura válida, valores 0
    return res.status(200).json(out);
  }
});

export default router;
