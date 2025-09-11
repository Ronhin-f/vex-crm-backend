// routes/analytics.js — KPIs CRM (ESM)
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

function pct(n, d) {
  const N = Number(n) || 0;
  const D = Number(d) || 0;
  return D > 0 ? Math.round((N * 100) / D) : 0;
}

/* ============================ KPIs ============================ */
/**
 * GET /analytics/kpis?from=YYYY-MM-DD&to=YYYY-MM-DD&stalled_days=7
 *
 * Devuelve:
 * {
 *   range: {...},
 *   contacts: { total, new_by_day, contactability_pct, first_touch:{...} },
 *   tasks: { overdue, due_next_7d },
 *   pipeline: { by_source:[], by_owner:[] },
 *   qualification: {
 *     total, qualified, rate_pct,
 *     uncontactable:{ total, pct },
 *     no_first_touch:{ total, pct },
 *     uncategorized:{ total, pct },
 *     stalled_in_incoming:{ total, days }
 *   }
 * }
 */
router.get("/kpis", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id } = getUserFromReq(req);
    const { fromISO, toISO } = parseRange(req.query);
    const stalledDays = Math.max(1, Number(req.query.stalled_days || 7));

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

    /* ---------- QUALIFICATION KPIs (nuevos) ---------- */
    const canonLower = CANON_CATS.map((s) => s.toLowerCase());

    // Total de leads creados en el rango (denominador)
    const leadsRange = await q(
      `
      SELECT COUNT(*)::int AS total
      FROM clientes
      WHERE ($1::text IS NULL OR organizacion_id = $1)
        AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
      `,
      [organizacion_id, fromISO, toISO]
    );
    const totalLeads = leadsRange.rows?.[0]?.total ?? 0;

    // No contactables (sin email y sin teléfono) en el rango
    const uncontactableQ = await q(
      `
      SELECT COUNT(*)::int AS n
      FROM clientes c
      WHERE ($1::text IS NULL OR c.organizacion_id = $1)
        AND c.created_at >= $2::timestamptz AND c.created_at < $3::timestamptz
        AND COALESCE(NULLIF(TRIM(c.email), ''), '') = ''
        AND COALESCE(NULLIF(TRIM(c.telefono), ''), '') = ''
      `,
      [organizacion_id, fromISO, toISO]
    );
    const uncontactable = uncontactableQ.rows?.[0]?.n ?? 0;

    // Sin primer contacto (ninguna tarea asociada) en el rango
    const noFirstTouchQ = await q(
      `
      SELECT COUNT(*)::int AS n
      FROM clientes c
      WHERE ($1::text IS NULL OR c.organizacion_id = $1)
        AND c.created_at >= $2::timestamptz AND c.created_at < $3::timestamptz
        AND NOT EXISTS (
          SELECT 1 FROM tareas t
          WHERE t.cliente_id = c.id
            ${organizacion_id ? "AND t.organizacion_id = c.organizacion_id" : ""}
        )
      `,
      [organizacion_id, fromISO, toISO]
    );
    const noFirstTouch = noFirstTouchQ.rows?.[0]?.n ?? 0;

    // Sin stage / fuera de pipeline canónico en el rango
    const uncategorizedQ = await q(
      `
      SELECT COUNT(*)::int AS n
      FROM clientes c
      WHERE ($1::text IS NULL OR c.organizacion_id = $1)
        AND c.created_at >= $2::timestamptz AND c.created_at < $3::timestamptz
        AND (
          c.stage IS NULL OR TRIM(c.stage) = '' OR
          LOWER(c.stage) NOT IN (${canonLower.map((_, i) => `$${i + 4}`).join(",")})
        )
      `,
      [organizacion_id, fromISO, toISO, ...canonLower]
    );
    const uncategorized = uncategorizedQ.rows?.[0]?.n ?? 0;

    // Estancados en Incoming ≥ N días y sin tareas (no usa rango; fotografía actual)
    const stalledQ = await q(
      `
      SELECT COUNT(*)::int AS n
      FROM clientes c
      WHERE ($1::text IS NULL OR c.organizacion_id = $1)
        AND c.stage = 'Incoming Leads'
        AND c.created_at <= NOW() - (($2::int || ' days')::interval)
        AND NOT EXISTS (
          SELECT 1 FROM tareas t
          WHERE t.cliente_id = c.id
            ${organizacion_id ? "AND t.organizacion_id = c.organizacion_id" : ""}
        )
      `,
      [organizacion_id, stalledDays]
    );
    const stalledIncoming = stalledQ.rows?.[0]?.n ?? 0;

    // Tasa de calificación (Qualified + Bid/Estimate Sent + Won) en el rango
    const qualifiedQ = await q(
      `
      SELECT COUNT(*)::int AS n
      FROM clientes
      WHERE ($1::text IS NULL OR organizacion_id = $1)
        AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
        AND stage IN ('Qualified','Bid/Estimate Sent','Won')
      `,
      [organizacion_id, fromISO, toISO]
    );
    const qualified = qualifiedQ.rows?.[0]?.n ?? 0;

    /* ---------- Armado de respuesta ---------- */
    const total = contactsTotal.rows?.[0]?.total ?? 0;
    const new_by_day = (contactsNewByDay.rows || []).map((r) => ({
      dia: r.dia,
      nuevos: r.nuevos,
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
      qualification: {
        total: totalLeads,
        qualified,
        rate_pct: pct(qualified, totalLeads),
        uncontactable: { total: uncontactable, pct: pct(uncontactable, totalLeads) },
        no_first_touch: { total: noFirstTouch, pct: pct(noFirstTouch, totalLeads) },
        uncategorized: { total: uncategorized, pct: pct(uncategorized, totalLeads) },
        stalled_in_incoming: { total: stalledIncoming, days: stalledDays },
      },
    });
  } catch (e) {
    console.error("[GET /analytics/kpis]", e?.stack || e?.message || e);
    res.status(200).json({
      range: null,
      contacts: { total: 0, new_by_day: [], contactability_pct: 0, first_touch: { p50_min: 0, p90_min: 0, avg_min: 0 } },
      tasks: { overdue: 0, due_next_7d: 0 },
      pipeline: { by_source: [], by_owner: [] },
      qualification: {
        total: 0,
        qualified: 0,
        rate_pct: 0,
        uncontactable: { total: 0, pct: 0 },
        no_first_touch: { total: 0, pct: 0 },
        uncategorized: { total: 0, pct: 0 },
        stalled_in_incoming: { total: 0, days: Number(req?.query?.stalled_days || 7) },
      },
    });
  }
});

function contactsabilitySafe(row) {
  if (!row) return 0;
  const pct = Number(row.pct);
  return Number.isFinite(pct) ? pct : 0;
}

export default router;
