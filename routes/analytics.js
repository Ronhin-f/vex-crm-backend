// routes/analytics.js — KPIs CRM (ESM) - estable por tipo
import { Router } from "express";
import { q } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";

const router = Router();

/* ---------------------------- helpers ---------------------------- */
function getUserFromReq(req) {
  const u = req.usuario || req.user || {};
  return {
    email: u.email ?? req.usuario_email ?? u.usuario_email ?? null,
    organizacion_id:
      u.organizacion_id ??
      req.organizacion_id ??
      u.organization_id ??
      null,
  };
}
function firstText(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}
function toIntOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
async function resolveOrgId(req) {
  const u = getUserFromReq(req);
  const fromUser = firstText(u?.organizacion_id);
  if (fromUser) return toIntOrNull(fromUser);

  const fromHeader = firstText(req.headers?.["x-org-id"]);
  if (fromHeader) return toIntOrNull(fromHeader);

  const fromQueryOrBody = firstText(
    req.query?.organizacion_id,
    req.query?.organization_id,
    req.query?.org_id,
    req.body?.organizacion_id,
    req.body?.organization_id,
    req.body?.org_id
  );
  if (fromQueryOrBody) return toIntOrNull(fromQueryOrBody);

  const email = firstText(u?.email);
  if (email) {
    const r = await q(
      `SELECT organizacion_id FROM usuarios WHERE email = $1 LIMIT 1`,
      [email]
    );
    const org = r.rows?.[0]?.organizacion_id;
    if (org != null) return toIntOrNull(org);
  }
  return 10; // fallback controlado
}
function parseRange(query) {
  const now = new Date();
  const to = query?.to ? new Date(query.to) : now;
  const from = query?.from ? new Date(query.from) : new Date(to.getTime() - 30 * 86400000);
  const safeTo = isNaN(to.getTime()) ? now : to;
  const safeFrom = isNaN(from.getTime()) ? new Date(safeTo.getTime() - 30 * 86400000) : from;
  return { fromISO: safeFrom.toISOString(), toISO: safeTo.toISOString() };
}
function pct(n, d) {
  const N = Number(n) || 0;
  const D = Number(d) || 0;
  return D > 0 ? Math.round((N * 100) / D) : 0;
}
let PIPE_CACHE = { name: null, ts: 0 };
async function pickPipelineTable() {
  const now = Date.now();
  if (PIPE_CACHE.name && now - PIPE_CACHE.ts < 10 * 60 * 1000) return PIPE_CACHE.name;
  const r = await q(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema='public' AND table_name='proyectos'
     ) AS ok`
  );
  const name = r.rows?.[0]?.ok ? "proyectos" : "clientes";
  PIPE_CACHE = { name, ts: now };
  return name;
}
function nocache(_req, res, next) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
  res.set("Vary", "Authorization");
  next();
}
function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
async function regclassExists(name) {
  try {
    const r = await q(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${name}`]);
    return !!r.rows?.[0]?.ok;
  } catch {
    return false;
  }
}

/* ============================ KPIs (CRM) ============================ */
router.get("/kpis", authenticateToken, nocache, async (req, res) => {
  try {
    const orgId = await resolveOrgId(req); // int|null
    const { fromISO, toISO } = parseRange(req.query);
    const stalledDays = Math.max(1, Number(req.query.stalled_days || 7));
    const PIPE = await pickPipelineTable();

    /* ---------- CONTACTS (clientes) ---------- */
    const contactsTotal = await q(
      `SELECT COUNT(*)::int AS total
         FROM clientes
        WHERE ($1::int IS NULL OR organizacion_id = $1::int)`,
      [orgId]
    );

    const contactsNewByDay = await q(
      `SELECT DATE_TRUNC('day', created_at) AS dia, COUNT(*)::int AS nuevos
         FROM clientes
        WHERE ($1::int IS NULL OR organizacion_id = $1::int)
          AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
        GROUP BY 1
        ORDER BY 1`,
      [orgId, fromISO, toISO]
    );

    /* ---------- CONTACTABILITY ---------- */
    const contactability = await q(
      `WITH touched AS (
         SELECT DISTINCT t.cliente_id
           FROM tareas t
          WHERE ($1::int IS NULL OR t.organizacion_id = $1::int)
            AND t.created_at >= $2::timestamptz AND t.created_at < $3::timestamptz
            AND t.cliente_id IS NOT NULL
       ),
       base AS (
         SELECT COUNT(*)::int AS total
           FROM clientes c
          WHERE ($1::int IS NULL OR c.organizacion_id = $1::int)
            AND c.created_at < $3::timestamptz
       )
       SELECT
         (SELECT COUNT(*)::int FROM touched) AS con_interaccion,
         base.total,
         COALESCE(ROUND(100.0 * (SELECT COUNT(*) FROM touched) / NULLIF(base.total,0))::int, 0) AS pct
       FROM base`,
      [orgId, fromISO, toISO]
    );

    /* ---------- FIRST TOUCH SLA ---------- */
    const firstTouch = await q(
      `WITH first_task AS (
         SELECT c.id AS cliente_id,
                MIN(t.created_at) AS first_touch,
                c.created_at
           FROM clientes c
      LEFT JOIN tareas t ON t.cliente_id = c.id
                          AND ($1::int IS NULL OR t.organizacion_id = $1::int)
          WHERE ($1::int IS NULL OR c.organizacion_id = $1::int)
            AND c.created_at >= $2::timestamptz AND c.created_at < $3::timestamptz
          GROUP BY 1,3
       ),
       deltas AS (
         SELECT EXTRACT(EPOCH FROM (first_touch - created_at))/60.0 AS mins
           FROM first_task
          WHERE first_touch IS NOT NULL
       )
       SELECT
         PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY mins) AS p50_min,
         PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY mins) AS p90_min,
         AVG(mins) AS avg_min
       FROM deltas`,
      [orgId, fromISO, toISO]
    );

    /* ---------- TASKS: overdue & due_next_7d ---------- */
    const tasksOverdue = await q(
      `SELECT COUNT(*)::int AS overdue
         FROM tareas
        WHERE completada = FALSE
          AND vence_en IS NOT NULL
          AND vence_en < NOW()
          AND ($1::int IS NULL OR organizacion_id = $1::int)`,
      [orgId]
    );

    const tasksNext7d = await q(
      `SELECT COUNT(*)::int AS due_next_7d
         FROM tareas
        WHERE completada = FALSE
          AND vence_en IS NOT NULL
          AND vence_en <= NOW() + INTERVAL '7 days'
          AND ($1::int IS NULL OR organizacion_id = $1::int)`,
      [orgId]
    );

    /* ---------- PIPELINE ---------- */
    const bySource = await q(
      `WITH agg AS (
         SELECT COALESCE(source,'Unknown') AS source,
                SUM(CASE WHEN stage ~* '^(won|ganad)'  OR result='won'  THEN 1 ELSE 0 END)::int AS won,
                SUM(CASE WHEN stage ~* '^(lost|perdid)' OR result='lost' THEN 1 ELSE 0 END)::int AS lost
           FROM ${PIPE}
          WHERE ($1::int IS NULL OR organizacion_id = $1::int)
            AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
          GROUP BY 1
       )
       SELECT source, won, lost,
              CASE WHEN (won+lost)>0 THEN ROUND(100.0*won/(won+lost))::int ELSE 0 END AS win_rate
         FROM agg
        ORDER BY win_rate DESC, won DESC, source ASC`,
      [orgId, fromISO, toISO]
    );

    const byOwner = await q(
      `WITH base AS (
         SELECT
           COALESCE(NULLIF(assignee,''), NULLIF(owner,''), NULLIF(usuario_email,''), 'Unassigned') AS owner,
           stage, result, created_at, organizacion_id
         FROM ${PIPE}
         WHERE ($1::int IS NULL OR organizacion_id = $1::int)
           AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
       ),
       agg AS (
         SELECT owner,
                SUM(CASE WHEN stage ~* '^(won|ganad)'  OR result='won'  THEN 1 ELSE 0 END)::int AS won,
                SUM(CASE WHEN stage ~* '^(lost|perdid)' OR result='lost' THEN 1 ELSE 0 END)::int AS lost
           FROM base
          GROUP BY 1
       )
       SELECT owner, won, lost,
              CASE WHEN (won+lost)>0 THEN ROUND(100.0*won/(won+lost))::int ELSE 0 END AS win_rate
         FROM agg
        ORDER BY win_rate DESC, won DESC, owner ASC`,
      [orgId, fromISO, toISO]
    );

    const wonLostAgg = await q(
      `SELECT
         SUM(CASE WHEN result='won'  OR stage ~* '^(won|ganad)'  THEN 1 ELSE 0 END)::int AS won,
         SUM(CASE WHEN result='lost' OR stage ~* '^(lost|perdid)' THEN 1 ELSE 0 END)::int AS lost
       FROM ${PIPE}
      WHERE ($1::int IS NULL OR organizacion_id = $1::int)
        AND COALESCE(closed_at, updated_at, created_at) >= $2::timestamptz
        AND COALESCE(closed_at, updated_at, created_at) <  $3::timestamptz`,
      [orgId, fromISO, toISO]
    );
    const wonTotal  = num(wonLostAgg.rows?.[0]?.won, 0);
    const lostTotal = num(wonLostAgg.rows?.[0]?.lost, 0);
    const win_rate  = (wonTotal + lostTotal) > 0 ? Math.round((wonTotal * 100) / (wonTotal + lostTotal)) : 0;

    const stagesAgg = await q(
      `SELECT COALESCE(stage,'Uncategorized') AS stage, COUNT(*)::int AS total
         FROM ${PIPE}
        WHERE ($1::int IS NULL OR organizacion_id = $1::int)
          AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
        GROUP BY 1`,
      [orgId, fromISO, toISO]
    );

    /* ---------- AR / DSO ---------- */
    let ar = {
      total: 0,
      overdue: { count: 0, amount: 0 },
      due_next_7: 0,
      aging: { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90p: 0 },
      dso_days: 0,
      source: "none",
    };

    const hasAgingView = await regclassExists("v_ar_aging");
    const hasInvoicesTable = await regclassExists("invoices");

    if (hasAgingView) {
      const r = await q(
        `SELECT * FROM v_ar_aging WHERE ($1::int IS NULL OR organizacion_id = $1::int)`,
        [orgId]
      );
      const v = r.rows?.[0] || {};
      ar = {
        total: num(v.ar_total),
        overdue: { count: num(v.overdue_count), amount: num(v.overdue_amount) },
        due_next_7: num(v.due_next_7),
        aging: {
          current: num(v.bucket_current),
          d1_30: num(v.bucket_1_30),
          d31_60: num(v.bucket_31_60),
          d61_90: num(v.bucket_61_90),
          d90p: num(v.bucket_90p),
        },
        dso_days: 0,
        source: "v_ar_aging",
      };
    } else if (hasInvoicesTable) {
      const base = await q(
        `SELECT
           SUM(GREATEST(amount_total - amount_paid,0)) AS ar_total,
           SUM(GREATEST(amount_total - amount_paid,0)) FILTER (WHERE (now()::date - due_date) > 0) AS overdue_amount,
           COUNT(*) FILTER (WHERE (now()::date - due_date) > 0)::int AS overdue_count,
           SUM(GREATEST(amount_total - amount_paid,0)) FILTER (WHERE due_date BETWEEN now()::date AND (now()::date + 7)) AS due_next_7,
           SUM(GREATEST(amount_total - amount_paid,0)) FILTER (WHERE (now()::date - due_date) <= 0) AS bucket_current,
           SUM(GREATEST(amount_total - amount_paid,0)) FILTER (WHERE (now()::date - due_date) BETWEEN 1 AND 30) AS bucket_1_30,
           SUM(GREATEST(amount_total - amount_paid,0)) FILTER (WHERE (now()::date - due_date) BETWEEN 31 AND 60) AS bucket_31_60,
           SUM(GREATEST(amount_total - amount_paid,0)) FILTER (WHERE (now()::date - due_date) BETWEEN 61 AND 90) AS bucket_61_90,
           SUM(GREATEST(amount_total - amount_paid,0)) FILTER (WHERE (now()::date - due_date) > 90) AS bucket_90p
         FROM invoices
        WHERE status IN ('sent','partial','overdue')
          AND ($1::int IS NULL OR organizacion_id = $1::int)`,
        [orgId]
      );
      const v = base.rows?.[0] || {};
      ar = {
        total: num(v.ar_total),
        overdue: { count: num(v.overdue_count), amount: num(v.overdue_amount) },
        due_next_7: num(v.due_next_7),
        aging: {
          current: num(v.bucket_current),
          d1_30: num(v.bucket_1_30),
          d31_60: num(v.bucket_31_60),
          d61_90: num(v.bucket_61_90),
          d90p: num(v.bucket_90p),
        },
        dso_days: 0,
        source: "invoices",
      };
    }

    if (hasInvoicesTable) {
      const sales30 = await q(
        `SELECT COALESCE(SUM(amount_total),0) AS s
           FROM invoices
          WHERE ($1::int IS NULL OR organizacion_id = $1::int)
            AND issue_date >= (now()::date - INTERVAL '30 days')
            AND status IN ('sent','partial','paid','overdue')`,
        [orgId]
      );
      const s = num(sales30.rows?.[0]?.s, 0);
      const daily = s / 30;
      ar.dso_days = daily > 0 ? Math.round(num(ar.total) / daily) : 0;
    }

    /* ---------- Qualification ---------- */
    const totalContacts = contactsTotal.rows?.[0]?.total ?? 0;

    const qualifiedRes = await q(
      `SELECT COUNT(*)::int AS n
         FROM clientes
        WHERE ($1::int IS NULL OR organizacion_id = $1::int)
          AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
          AND (
            stage IN ('Qualified','Bid/Estimate Sent','Won') OR
            stage ~* '^(calificad|presup|ganad)'
          )`,
      [orgId, fromISO, toISO]
    );
    const qualifiedCount = qualifiedRes.rows?.[0]?.n ?? 0;

    const uncontactableRes = await q(
      `SELECT COUNT(*)::int AS n
         FROM clientes c
        WHERE ($1::int IS NULL OR c.organizacion_id = $1::int)
          AND c.created_at >= $2::timestamptz AND c.created_at < $3::timestamptz
          AND COALESCE(NULLIF(TRIM(c.email), ''), '') = ''
          AND COALESCE(NULLIF(TRIM(c.telefono), ''), '') = ''`,
      [orgId, fromISO, toISO]
    );
    const uncontactableCount = uncontactableRes.rows?.[0]?.n ?? 0;

    const noFirstTouchRes = await q(
      `SELECT COUNT(*)::int AS n
         FROM clientes c
        WHERE ($1::int IS NULL OR c.organizacion_id = $1::int)
          AND c.created_at >= $2::timestamptz AND c.created_at < $3::timestamptz
          AND NOT EXISTS (
            SELECT 1 FROM tareas t
             WHERE t.cliente_id = c.id
               AND ($1::int IS NULL OR t.organizacion_id = $1::int)
          )`,
      [orgId, fromISO, toISO]
    );
    const noFirstTouchCount = noFirstTouchRes.rows?.[0]?.n ?? 0;

    const uncategorizedRes = await q(
      `SELECT COUNT(*)::int AS n
         FROM clientes c
        WHERE ($1::int IS NULL OR c.organizacion_id = $1::int)
          AND c.created_at >= $2::timestamptz AND c.created_at < $3::timestamptz
          AND (
            c.stage IS NULL OR TRIM(c.stage) = '' OR
            NOT (c.stage ~* '(incoming|lead|entrante|unqualified|calificad|qualified|follow|seguim|perdid|lost|bid|estimate|presup|won|ganad)')
          )`,
      [orgId, fromISO, toISO]
    );
    const uncategorizedCount = uncategorizedRes.rows?.[0]?.n ?? 0;

    const stalledIncomingRes = await q(
      `SELECT COUNT(*)::int AS n
         FROM clientes c
        WHERE ($1::int IS NULL OR c.organizacion_id = $1::int)
          AND c.stage ~* '^(incoming|lead|entrante)'
          AND c.created_at <= NOW() - (($2::int || ' days')::interval)
          AND NOT EXISTS (
            SELECT 1 FROM tareas t
             WHERE t.cliente_id = c.id
               AND ($1::int IS NULL OR t.organizacion_id = $1::int)
          )`,
      [orgId, stalledDays]
    );
    const stalledIncomingCount = stalledIncomingRes.rows?.[0]?.n ?? 0;

    /* ---------- Respuesta ---------- */
    const new_by_day = (contactsNewByDay.rows || []).map((r) => ({ dia: r.dia, nuevos: r.nuevos }));
    const contactability_pct = num(contactability.rows?.[0]?.pct, 0);
    const ft = firstTouch.rows?.[0] || {};
    const first_touch = {
      p50_min: num(ft.p50_min, 0),
      p90_min: num(ft.p90_min, 0),
      avg_min: num(ft.avg_min, 0),
    };

    res.json({
      range: { from: fromISO, to: toISO },
      contacts: { total: totalContacts, new_by_day, contactability_pct, first_touch },
      tasks: {
        overdue: num(tasksOverdue.rows?.[0]?.overdue, 0),
        due_next_7d: num(tasksNext7d.rows?.[0]?.due_next_7d, 0),
      },
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
        total: totalContacts,
        qualified: qualifiedCount,
        rate_pct: pct(qualifiedCount, totalContacts),
        uncontactable: { total: uncontactableCount, pct: pct(uncontactableCount, totalContacts) },
        no_first_touch: { total: noFirstTouchCount, pct: pct(noFirstTouchCount, totalContacts) },
        uncategorized: { total: uncategorizedCount, pct: pct(uncategorizedCount, totalContacts) },
        stalled_in_incoming: { total: stalledIncomingCount, days: stalledDays },
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
        source: "none",
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

/* =================== KPIs de tareas =================== */
router.get("/tasks/kpis", authenticateToken, nocache, async (req, res) => {
  try {
    const orgId = await resolveOrgId(req);
    const r = await q(
      `SELECT * FROM public.v_tareas_overview WHERE ($1::int IS NULL OR organizacion_id = $1::int)`,
      [orgId]
    );
    if (r.rows?.length === 1) return res.json(r.rows[0]);
    return res.json(r.rows || []);
  } catch (e) {
    console.error("[GET /analytics/tasks/kpis]", e?.stack || e?.message || e);
    res.status(200).json([]);
  }
});

export default router;
