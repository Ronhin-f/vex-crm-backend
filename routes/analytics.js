// routes/analytics.js — KPIs CRM (ESM)
import { Router } from "express";
import { q } from "../utils/db.js";
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

function parseRange(query) {
  const now = new Date();
  const to = query.to ? new Date(query.to) : now;
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 86400000); // 30 días
  const safeTo = isNaN(to.getTime()) ? now : to;
  const safeFrom = isNaN(from.getTime()) ? new Date(safeTo.getTime() - 30 * 86400000) : from;
  return {
    fromISO: safeFrom.toISOString(),
    toISO: safeTo.toISOString(),
  };
}

/* ============================ KPIs ============================ */
/**
 * GET /analytics/kpis?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Devuelve:
 * {
 *   contacts: {
 *     total: number,
 *     new_by_day: [{ dia, nuevos }],
 *     contactability_pct: number,
 *     first_touch: { p50_min, p90_min, avg_min }
 *   },
 *   tasks: { overdue: number, due_next_7d: number },
 *   pipeline: {
 *     by_source: [{ source, won, lost, win_rate }],
 *     by_owner:  [{ owner, won, lost, win_rate }]
 *   }
 * }
 */
router.get("/kpis", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id } = getUserFromReq(req);
    const { fromISO, toISO } = parseRange(req.query);

    /* ---------- CONTACTS: total & new_by_day ---------- */
    const contactsTotal = await q(
      `
      SELECT COUNT(*)::int AS total
      FROM clientes
      WHERE ($1::text IS NULL OR organizacion_id = $1)
      `,
      [organizacion_id]
    );

    const contactsNewByDay = await q(
      `
      SELECT DATE_TRUNC('day', created_at) AS dia, COUNT(*)::int AS nuevos
      FROM clientes
      WHERE ($1::text IS NULL OR organizacion_id = $1)
        AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
      GROUP BY 1
      ORDER BY 1
      `,
      [organizacion_id, fromISO, toISO]
    );

    /* ---------- CONTACTABILITY: % con al menos 1 tarea en período ---------- */
    const contactability = await q(
      `
      WITH touched AS (
        SELECT DISTINCT t.cliente_id
        FROM tareas t
        WHERE ($1::text IS NULL OR t.organizacion_id = $1)
          AND t.created_at >= $2::timestamptz AND t.created_at < $3::timestamptz
          AND t.cliente_id IS NOT NULL
      ),
      base AS (
        SELECT COUNT(*)::int AS total
        FROM clientes c
        WHERE ($1::text IS NULL OR c.organizacion_id = $1)
          AND c.created_at < $3::timestamptz
      )
      SELECT
        (SELECT COUNT(*)::int FROM touched) AS con_interaccion,
        base.total,
        COALESCE(ROUND(100.0 * (SELECT COUNT(*) FROM touched) / NULLIF(base.total,0))::int, 0) AS pct
      FROM base
      `,
      [organizacion_id, fromISO, toISO]
    );

    /* ---------- FIRST TOUCH SLA (p50/p90/avg en minutos) ---------- */
    const firstTouch = await q(
      `
      WITH first_task AS (
        SELECT c.id AS cliente_id,
               MIN(t.created_at) AS first_touch,
               c.created_at
        FROM clientes c
        LEFT JOIN tareas t ON t.cliente_id = c.id
        WHERE ($1::text IS NULL OR c.organizacion_id = $1)
          AND c.created_at >= $2::timestamptz AND c.created_at < $3::timestamptz
        GROUP BY 1,3
      ),
      deltas AS (
        SELECT EXTRACT(EPOCH FROM (first_touch - created_at))/60.0 AS mins
        FROM first_task
        WHERE first_touch IS NOT NULL
      )
      SELECT
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY mins)::double precision AS p50_min,
        PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY mins)::double precision AS p90_min,
        AVG(mins)::double precision AS avg_min
      FROM deltas
      `,
      [organizacion_id, fromISO, toISO]
    );

    /* ---------- TASKS: overdue & due_next_7d ---------- */
    const tasksOverdue = await q(
      `
      SELECT COUNT(*)::int AS overdue
      FROM tareas
      WHERE completada = FALSE
        AND vence_en IS NOT NULL
        AND vence_en < NOW()
        AND ($1::text IS NULL OR organizacion_id = $1)
      `,
      [organizacion_id]
    );

    const tasksNext7d = await q(
      `
      SELECT COUNT(*)::int AS due_next_7d
      FROM tareas
      WHERE completada = FALSE
        AND vence_en IS NOT NULL
        AND vence_en <= NOW() + INTERVAL '7 days'
        AND ($1::text IS NULL OR organizacion_id = $1)
      `,
      [organizacion_id]
    );

    /* ---------- PIPELINE: by_source & by_owner (dentro del período) ---------- */
    const bySource = await q(
      `
      WITH agg AS (
        SELECT
          COALESCE(source,'Unknown') AS source,
          SUM(CASE WHEN stage='Won'  THEN 1 ELSE 0 END)::int AS won,
          SUM(CASE WHEN stage='Lost' THEN 1 ELSE 0 END)::int AS lost
        FROM clientes
        WHERE ($1::text IS NULL OR organizacion_id = $1)
          AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
        GROUP BY 1
      )
      SELECT source, won, lost,
             CASE WHEN (won+lost)>0
                  THEN ROUND(100.0*won/(won+lost))::int
                  ELSE 0 END AS win_rate
      FROM agg
      ORDER BY win_rate DESC, won DESC, source ASC
      `,
      [organizacion_id, fromISO, toISO]
    );

    const byOwner = await q(
      `
      WITH agg AS (
        SELECT
          COALESCE(assignee,'Unassigned') AS owner,
          SUM(CASE WHEN stage='Won'  THEN 1 ELSE 0 END)::int AS won,
          SUM(CASE WHEN stage='Lost' THEN 1 ELSE 0 END)::int AS lost
        FROM clientes
        WHERE ($1::text IS NULL OR organizacion_id = $1)
          AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
        GROUP BY 1
      )
      SELECT owner, won, lost,
             CASE WHEN (won+lost)>0
                  THEN ROUND(100.0*won/(won+lost))::int
                  ELSE 0 END AS win_rate
      FROM agg
      ORDER BY win_rate DESC, won DESC, owner ASC
      `,
      [organizacion_id, fromISO, toISO]
    );

    /* ---------- Armado de respuesta ---------- */
    const total = contactsTotal.rows?.[0]?.total ?? 0;
    const new_by_day = (contactsNewByDay.rows || []).map(r => ({
      dia: r.dia, nuevos: r.nuevos,
    }));
    const contactability_pct = contactsabilitySafe(contactability.rows?.[0]);

    const ft = firstTouch.rows?.[0] || {};
    const first_touch = {
      p50_min: ft.p50_min ?? 0,
      p90_min: ft.p90_min ?? 0,
      avg_min: ft.avg_min ?? 0,
    };

    res.json({
      range: { from: fromISO, to: toISO },
      contacts: {
        total,
        new_by_day,
        contactability_pct,
        first_touch,
      },
      tasks: {
        overdue: tasksOverdue.rows?.[0]?.overdue ?? 0,
        due_next_7d: tasksNext7d.rows?.[0]?.due_next_7d ?? 0,
      },
      pipeline: {
        by_source: bySource.rows || [],
        by_owner: byOwner.rows || [],
      },
    });
  } catch (e) {
    console.error("[GET /analytics/kpis]", e?.stack || e?.message || e);
    res.status(200).json({
      range: null,
      contacts: { total: 0, new_by_day: [], contactability_pct: 0, first_touch: { p50_min: 0, p90_min: 0, avg_min: 0 } },
      tasks: { overdue: 0, due_next_7d: 0 },
      pipeline: { by_source: [], by_owner: [] },
    });
  }
});

function contactsabilitySafe(row) {
  if (!row) return 0;
  const pct = Number(row.pct);
  return Number.isFinite(pct) ? pct : 0;
}

export default router;
