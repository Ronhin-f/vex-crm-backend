// routes/analytics.js — KPIs CRM (ESM)
// Ahora incluye KPIs financieros de AR (Aging / Overdue / Due Next 7 / DSO)
import { Router } from "express";
import { q, CANON_CATS } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";

const router = Router();

/* ---------------------------- helpers ---------------------------- */
function getUserFromReq(req) {
  const u = req.usuario || {};
  return {
    email: u.email ?? req.usuario_email ?? u.usuario_email ?? null,
    organizacion_id: u.organizacion_id ?? req.organizacion_id ?? u.organization_id ?? null,
  };
}

function parseRange(query) {
  const now = new Date();
  const to = query.to ? new Date(query.to) : now;
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 86400000); // 30 días
  const safeTo = isNaN(to.getTime()) ? now : to;
  const safeFrom = isNaN(from.getTime()) ? new Date(safeTo.getTime() - 30 * 86400000) : from;
  return { fromISO: safeFrom.toISOString(), toISO: safeTo.toISOString() };
}

function pct(n, d) {
  const N = Number(n) || 0;
  const D = Number(d) || 0;
  return D > 0 ? Math.round((N * 100) / D) : 0;
}

async function pickPipelineTable() {
  const r = await q(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema='public' AND table_name='proyectos'
     ) AS ok`
  );
  return r.rows?.[0]?.ok ? "proyectos" : "clientes";
}

function nocache(_req, res, next) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
  res.set("CDN-Cache-Control", "no-store");
  res.set("Vary", "Authorization");
  next();
}

function contactsabilitySafe(row) {
  if (!row) return 0;
  const p = Number(row.pct);
  return Number.isFinite(p) ? p : 0;
}

async function regclassExists(name) {
  try {
    const r = await q(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${name}`]);
    return !!r.rows?.[0]?.ok;
  } catch {
    return false;
  }
}

/* ============================ KPIs ============================ */
/**
 * GET /analytics/kpis?from=YYYY-MM-DD&to=YYYY-MM-DD&stalled_days=7
 */
router.get("/kpis", authenticateToken, nocache, async (req, res) => {
  try {
    const { organizacion_id } = getUserFromReq(req);
    const { fromISO, toISO } = parseRange(req.query);
    const stalledDays = Math.max(1, Number(req.query.stalled_days || 7));
    const PIPE = await pickPipelineTable();

    /* ---------- CONTACTS (clientes) ---------- */
    const contactsTotal = await q(
      `SELECT COUNT(*)::int AS total
         FROM clientes
        WHERE ($1::text IS NULL OR organizacion_id = $1)`,
      [organizacion_id]
    );

    const contactsNewByDay = await q(
      `SELECT DATE_TRUNC('day', created_at) AS dia, COUNT(*)::int AS nuevos
         FROM clientes
        WHERE ($1::text IS NULL OR organizacion_id = $1)
          AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
        GROUP BY 1
        ORDER BY 1`,
      [organizacion_id, fromISO, toISO]
    );

    /* ---------- CONTACTABILITY (primer contacto vía tareas) ---------- */
    const contactability = await q(
      `WITH touched AS (
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
       FROM base`,
      [organizacion_id, fromISO, toISO]
    );

    /* ---------- FIRST TOUCH SLA (p50/p90/avg en min) ---------- */
    const firstTouch = await q(
      `WITH first_task AS (
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
       FROM deltas`,
      [organizacion_id, fromISO, toISO]
    );

    /* ---------- TASKS: overdue & due_next_7d ---------- */
    const tasksOverdue = await q(
      `SELECT COUNT(*)::int AS overdue
         FROM tareas
        WHERE completada = FALSE
          AND vence_en IS NOT NULL
          AND vence_en < NOW()
          AND ($1::text IS NULL OR organizacion_id = $1)`,
      [organizacion_id]
    );

    const tasksNext7d = await q(
      `SELECT COUNT(*)::int AS due_next_7d
         FROM tareas
        WHERE completada = FALSE
          AND vence_en IS NOT NULL
          AND vence_en <= NOW() + INTERVAL '7 days'
          AND ($1::text IS NULL OR organizacion_id = $1)`,
      [organizacion_id]
    );

    /* ---------- PIPELINE (sobre PROYECTOS si existen) ---------- */
    const bySource = await q(
      `WITH agg AS (
         SELECT COALESCE(source,'Unknown') AS source,
                SUM(CASE WHEN stage='Won'  THEN 1 ELSE 0 END)::int AS won,
                SUM(CASE WHEN stage='Lost' THEN 1 ELSE 0 END)::int AS lost
           FROM ${PIPE}
          WHERE ($1::text IS NULL OR organizacion_id = $1)
            AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
          GROUP BY 1
       )
       SELECT source, won, lost,
              CASE WHEN (won+lost)>0
                   THEN ROUND(100.0*won/(won+lost))::int
                   ELSE 0 END AS win_rate
         FROM agg
        ORDER BY win_rate DESC, won DESC, source ASC`,
      [organizacion_id, fromISO, toISO]
    );

    const byOwner = await q(
      `WITH agg AS (
         SELECT COALESCE(assignee,'Unassigned') AS owner,
                SUM(CASE WHEN stage='Won'  THEN 1 ELSE 0 END)::int AS won,
                SUM(CASE WHEN stage='Lost' THEN 1 ELSE 0 END)::int AS lost
           FROM ${PIPE}
          WHERE ($1::text IS NULL OR organizacion_id = $1)
            AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
          GROUP BY 1
       )
       SELECT owner, won, lost,
              CASE WHEN (won+lost)>0
                   THEN ROUND(100.0*won/(won+lost))::int
                   ELSE 0 END AS win_rate
         FROM agg
        ORDER BY win_rate DESC, won DESC, owner ASC`,
      [organizacion_id, fromISO, toISO]
    );

    const stagesAgg = await q(
      `SELECT COALESCE(stage,'Uncategorized') AS stage, COUNT(*)::int AS total
         FROM ${PIPE}
        WHERE ($1::text IS NULL OR organizacion_id = $1)
          AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
        GROUP BY 1`,
      [organizacion_id, fromISO, toISO]
    );
    const wonTotal  = stagesAgg.rows?.find?.((r) => r.stage === "Won")?.total ?? 0;
    const lostTotal = stagesAgg.rows?.find?.((r) => r.stage === "Lost")?.total ?? 0;
    const win_rate  = (wonTotal + lostTotal) > 0 ? Math.round((wonTotal * 100) / (wonTotal + lostTotal)) : 0;

    /* ---------- AR (Aging / Overdue / Due next 7 / DSO) ---------- */
    let ar = {
      total: 0,
      overdue: { count: 0, amount: 0 },
      due_next_7: 0,
      aging: { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90p: 0 },
      dso_days: 0,
      source: "none",
    };

    // ¿existe la vista v_ar_aging o la tabla invoices?
    const hasView = await regclassExists("v_ar_aging");
    const hasInvoices = hasView ? true : await regclassExists("invoices");

    if (hasView) {
      const r = await q(
        `SELECT * FROM v_ar_aging WHERE organizacion_id = $1`,
        [organizacion_id]
      );
      const v = r.rows?.[0] || {};
      ar = {
        total: Number(v.ar_total || 0),
        overdue: {
          count: Number(v.overdue_count || 0),
          amount: Number(v.overdue_amount || 0),
        },
        due_next_7: Number(v.due_next_7 || 0),
        aging: {
          current: Number(v.bucket_current || 0),
          d1_30: Number(v.bucket_1_30 || 0),
          d31_60: Number(v.bucket_31_60 || 0),
          d61_90: Number(v.bucket_61_90 || 0),
          d90p: Number(v.bucket_90p || 0),
        },
        dso_days: 0, // lo calculamos abajo con ventas de 30 días
        source: "v_ar_aging",
      };
    } else if (hasInvoices) {
      // cálculo directo sobre invoices (menos eficiente que la vista, pero seguro)
      const base = await q(
        `SELECT
           SUM(GREATEST(amount_total - amount_paid,0))                   AS ar_total,
           SUM(GREATEST(amount_total - amount_paid,0))
             FILTER (WHERE (now()::date - due_date) > 0)                AS overdue_amount,
           COUNT(*) FILTER (WHERE (now()::date - due_date) > 0)::int    AS overdue_count,
           SUM(GREATEST(amount_total - amount_paid,0))
             FILTER (WHERE due_date BETWEEN now()::date AND (now()::date + 7)) AS due_next_7,
           SUM(GREATEST(amount_total - amount_paid,0))
             FILTER (WHERE (now()::date - due_date) <= 0)               AS bucket_current,
           SUM(GREATEST(amount_total - amount_paid,0))
             FILTER (WHERE (now()::date - due_date) BETWEEN 1 AND 30)   AS bucket_1_30,
           SUM(GREATEST(amount_total - amount_paid,0))
             FILTER (WHERE (now()::date - due_date) BETWEEN 31 AND 60)  AS bucket_31_60,
           SUM(GREATEST(amount_total - amount_paid,0))
             FILTER (WHERE (now()::date - due_date) BETWEEN 61 AND 90)  AS bucket_61_90,
           SUM(GREATEST(amount_total - amount_paid,0))
             FILTER (WHERE (now()::date - due_date) > 90)               AS bucket_90p
         FROM invoices
        WHERE status IN ('sent','partial','overdue')
          AND ($1::text IS NULL OR organizacion_id = $1)`,
        [organizacion_id]
      );
      const v = base.rows?.[0] || {};
      ar = {
        total: Number(v.ar_total || 0),
        overdue: {
          count: Number(v.overdue_count || 0),
          amount: Number(v.overdue_amount || 0),
        },
        due_next_7: Number(v.due_next_7 || 0),
        aging: {
          current: Number(v.bucket_current || 0),
          d1_30: Number(v.bucket_1_30 || 0),
          d31_60: Number(v.bucket_31_60 || 0),
          d61_90: Number(v.bucket_61_90 || 0),
          d90p: Number(v.bucket_90p || 0),
        },
        dso_days: 0,
        source: "invoices",
      };
    }

    // DSO simple: AR / (ventas_últimos_30 / 30)
    if (hasInvoices) {
      const sales30 = await q(
        `SELECT COALESCE(SUM(amount_total),0)::numeric AS s
           FROM invoices
          WHERE ($1::text IS NULL OR organizacion_id = $1)
            AND issue_date >= (now()::date - INTERVAL '30 days')
            AND status IN ('sent','partial','paid','overdue')`,
        [organizacion_id]
      );
      const s = Number(sales30.rows?.[0]?.s || 0);
      const daily = s / 30;
      ar.dso_days = daily > 0 ? Math.round(Number(ar.total) / daily) : 0;
    }

    /* ---------- Armado de respuesta ---------- */
    const total = contactsTotal.rows?.[0]?.total ?? 0;
    const new_by_day = (contactsNewByDay.rows || []).map((r) => ({ dia: r.dia, nuevos: r.nuevos }));
    const contactability_pct = contactsabilitySafe(contactability.rows?.[0]);
    const ft = firstTouch.rows?.[0] || {};
    const first_touch = { p50_min: ft.p50_min ?? 0, p90_min: ft.p90_min ?? 0, avg_min: ft.avg_min ?? 0 };

    res.json({
      range: { from: fromISO, to: toISO },
      contacts: { total, new_by_day, contactability_pct, first_touch },
      tasks: {
        overdue: tasksOverdue.rows?.[0]?.overdue ?? 0,
        due_next_7d: tasksNext7d.rows?.[0]?.due_next_7d ?? 0,
      },
      // 🔹 NUEVO bloque financiero
      ar,
      pipeline: {
        by_source: bySource.rows || [],
        by_owner: byOwner.rows || [],
        summary: {
          won: wonTotal,
          lost: lostTotal,
          win_rate,
          stages: stagesAgg.rows || [],
          table: PIPE,
        },
      },
      qualification: {
        total: total,
        qualified: (await q(
          `SELECT COUNT(*)::int AS n
             FROM clientes
            WHERE ($1::text IS NULL OR organizacion_id = $1)
              AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
              AND stage IN ('Qualified','Bid/Estimate Sent','Won')`,
          [organizacion_id, fromISO, toISO]
        )).rows?.[0]?.n ?? 0,
        rate_pct: (r => pct(r, total))(((await q(
          `SELECT COUNT(*)::int AS n
             FROM clientes
            WHERE ($1::text IS NULL OR organizacion_id = $1)
              AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
              AND stage IN ('Qualified','Bid/Estimate Sent','Won')`,
          [organizacion_id, fromISO, toISO]
        )).rows?.[0]?.n ?? 0), total),
        uncontactable: {
          total: (await q(
            `SELECT COUNT(*)::int AS n
               FROM clientes c
              WHERE ($1::text IS NULL OR c.organizacion_id = $1)
                AND c.created_at >= $2::timestamptz AND c.created_at < $3::timestamptz
                AND COALESCE(NULLIF(TRIM(c.email), ''), '') = ''
                AND COALESCE(NULLIF(TRIM(c.telefono), ''), '') = ''`,
            [organizacion_id, fromISO, toISO]
          )).rows?.[0]?.n ?? 0,
          pct: 0 // se calcula abajo para evitar repetir query
        },
        no_first_touch: {
          total: (await q(
            `SELECT COUNT(*)::int AS n
               FROM clientes c
              WHERE ($1::text IS NULL OR c.organizacion_id = $1)
                AND c.created_at >= $2::timestamptz AND c.created_at < $3::timestamptz
                AND NOT EXISTS (
                  SELECT 1 FROM tareas t
                   WHERE t.cliente_id = c.id
                     ${organizacion_id ? "AND t.organizacion_id = c.organizacion_id" : ""}
                )`,
            [organizacion_id, fromISO, toISO]
          )).rows?.[0]?.n ?? 0,
          pct: 0
        },
        uncategorized: {
          total: (await q(
            `SELECT COUNT(*)::int AS n
               FROM clientes c
              WHERE ($1::text IS NULL OR c.organizacion_id = $1)
                AND c.created_at >= $2::timestamptz AND c.created_at < $3::timestamptz
                AND (
                  c.stage IS NULL OR TRIM(c.stage) = '' OR
                  LOWER(c.stage) NOT IN (${CANON_CATS.map((_, i) => `$${i + 4}`).join(",")})
                )`,
            [organizacion_id, fromISO, toISO, ...CANON_CATS.map(s => s.toLowerCase())]
          )).rows?.[0]?.n ?? 0,
          pct: 0
        },
        stalled_in_incoming: {
          total: (await q(
            `SELECT COUNT(*)::int AS n
               FROM clientes c
              WHERE ($1::text IS NULL OR c.organizacion_id = $1)
                AND c.stage = 'Incoming Leads'
                AND c.created_at <= NOW() - (($2::int || ' days')::interval)
                AND NOT EXISTS (
                  SELECT 1 FROM tareas t
                   WHERE t.cliente_id = c.id
                     ${organizacion_id ? "AND t.organizacion_id = c.organizacion_id" : ""}
                )`,
            [organizacion_id, stalledDays]
          )).rows?.[0]?.n ?? 0,
          days: stalledDays
        },
      },
    });
  } catch (e) {
    console.error("[GET /analytics/kpis]", e?.stack || e?.message || e);
    res.status(200).json({
      range: null,
      contacts: { total: 0, new_by_day: [], contactability_pct: 0, first_touch: { p50_min: 0, p90_min: 0, avg_min: 0 } },
      tasks: { overdue: 0, due_next_7d: 0 },
      ar: {
        total: 0,
        overdue: { count: 0, amount: 0 },
        due_next_7: 0,
        aging: { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90p: 0 },
        dso_days: 0,
        source: "none"
      },
      pipeline: { by_source: [], by_owner: [], summary: { won: 0, lost: 0, win_rate: 0, stages: [], table: "clientes" } },
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

export default router;
