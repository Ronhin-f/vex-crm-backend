// routes/analytics.js — KPIs CRM (ESM) TEXT-safe
import { Router } from "express";
import { q } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";
import { getOrgText } from "../utils/org.js";

const router = Router();

/* ---------------------------- helpers ---------------------------- */
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
function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function nocache(_req, res, next) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
  res.set("Vary", "Authorization");
  next();
}
async function regclassExists(name) {
  try {
    const r = await q(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${name}`]);
    return !!r.rows?.[0]?.ok;
  } catch {
    return false;
  }
}

/* ---------- detección de tabla pipeline (con cache) ---------- */
let PIPE_CACHE = { name: null, ts: 0 };
async function pickPipelineTable() {
  const now = Date.now();
  if (PIPE_CACHE.name && now - PIPE_CACHE.ts < 10 * 60 * 1000) return PIPE_CACHE.name;
  const hasProy = await regclassExists("proyectos");
  const hasCli = await regclassExists("clientes");
  const name = hasProy ? "proyectos" : hasCli ? "clientes" : null;
  PIPE_CACHE = { name, ts: now };
  return name;
}

/* ---------- detección de columnas por tabla (cache) ---------- */
const COLS_CACHE = new Map(); // key: table, val: { ts, set:Set<string> }
async function tableColumns(table) {
  const now = Date.now();
  const cached = COLS_CACHE.get(table);
  if (cached && now - cached.ts < 10 * 60 * 1000) return cached.set;

  const r = await q(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  const set = new Set((r.rows || []).map((x) => x.column_name));
  COLS_CACHE.set(table, { ts: now, set });
  return set;
}
function pickOne(set, candidates) {
  for (const c of candidates) if (set.has(c)) return c;
  return null;
}

/* ============================ KPIs (CRM) ============================ */
router.get("/kpis", authenticateToken, nocache, async (req, res) => {
  let orgId;
  try {
    orgId = getOrgText(req); // siempre TEXT, requerido
  } catch {
    return res.status(400).json({ error: "organizacion_id requerido" });
  }

  try {
    const { fromISO, toISO } = parseRange(req.query);

    // stalled_days seguro: entero >=1; si no, 7
    const stalledDays = (() => {
      const raw = Number(req.query?.stalled_days);
      if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw);
      return 7;
    })();

    const hasClientes = await regclassExists("clientes");
    const hasTareas = await regclassExists("tareas");

    const PIPE = await pickPipelineTable();

    // Si no hay ni clientes ni proyectos, devolvemos estructura vacía sin romper
    if (!hasClientes && !PIPE) {
      return res.json({
        range: { from: fromISO, to: toISO },
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
        pipeline: { by_source: [], by_owner: [], summary: { won: 0, lost: 0, win_rate: 0, stages: [], table: null } },
        qualification: {
          total: 0,
          qualified: 0,
          rate_pct: 0,
          uncontactable: { total: 0, pct: 0 },
          no_first_touch: { total: 0, pct: 0 },
          uncategorized: { total: 0, pct: 0 },
          stalled_in_incoming: { total: 0, days: stalledDays },
        },
      });
    }

    /* ---------- CONTACTS (clientes) ---------- */
    let totalContacts = 0;
    let new_by_day = [];
    let contactability_pct = 0;
    let first_touch = { p50_min: 0, p90_min: 0, avg_min: 0 };

    if (hasClientes) {
      const contactsTotal = await q(
        `SELECT COUNT(*)::int AS total
           FROM clientes
          WHERE organizacion_id::text = $1::text`,
        [orgId]
      );
      totalContacts = contactsTotal.rows?.[0]?.total ?? 0;

      const contactsNewByDay = await q(
        `SELECT DATE_TRUNC('day', created_at) AS dia, COUNT(*)::int AS nuevos
           FROM clientes
          WHERE organizacion_id::text = $1::text
            AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
          GROUP BY 1
          ORDER BY 1`,
        [orgId, fromISO, toISO]
      );
      new_by_day = (contactsNewByDay.rows || []).map((r) => ({ dia: r.dia, nuevos: r.nuevos }));

      /* ---------- CONTACTABILITY ---------- */
      if (hasTareas) {
        const contactability = await q(
          `WITH touched AS (
             SELECT DISTINCT t.cliente_id
               FROM tareas t
              WHERE t.organizacion_id::text = $1::text
                AND t.created_at >= $2::timestamptz AND t.created_at < $3::timestamptz
                AND t.cliente_id IS NOT NULL
           ),
           base AS (
             SELECT COUNT(*)::int AS total
               FROM clientes c
              WHERE c.organizacion_id::text = $1::text
                AND c.created_at < $3::timestamptz
           )
           SELECT
             (SELECT COUNT(*)::int FROM touched) AS con_interaccion,
             base.total,
             COALESCE(ROUND(100.0 * (SELECT COUNT(*) FROM touched) / NULLIF(base.total,0))::int, 0) AS pct
           FROM base`,
          [orgId, fromISO, toISO]
        );
        contactability_pct = num(contactability.rows?.[0]?.pct, 0);
      } else {
        contactability_pct = 0;
      }

      /* ---------- FIRST TOUCH SLA ---------- */
      const firstTouch = await q(
        `WITH first_task AS (
           SELECT c.id AS cliente_id,
                  MIN(t.created_at) AS first_touch,
                  c.created_at
             FROM clientes c
        LEFT JOIN tareas t ON t.cliente_id = c.id
                            AND t.organizacion_id::text = $1::text
            WHERE c.organizacion_id::text = $1::text
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
      const ft = firstTouch.rows?.[0] || {};
      first_touch = {
        p50_min: num(ft.p50_min, 0),
        p90_min: num(ft.p90_min, 0),
        avg_min: num(ft.avg_min, 0),
      };
    }

    /* ---------- TASKS: overdue & due_next_7d ---------- */
    let tasks_overdue = 0;
    let tasks_next_7d = 0;
    if (hasTareas) {
      const tasksOverdue = await q(
        `SELECT COUNT(*)::int AS overdue
           FROM tareas
          WHERE completada = FALSE
            AND vence_en IS NOT NULL
            AND vence_en < NOW()
            AND organizacion_id::text = $1::text`,
        [orgId]
      );
      tasks_overdue = num(tasksOverdue.rows?.[0]?.overdue, 0);

      const tasksNext7d = await q(
        `SELECT COUNT(*)::int AS due_next_7d
           FROM tareas
          WHERE completada = FALSE
            AND vence_en IS NOT NULL
            AND vence_en <= NOW() + INTERVAL '7 days'
            AND organizacion_id::text = $1::text`,
        [orgId]
      );
      tasks_next_7d = num(tasksNext7d.rows?.[0]?.due_next_7d, 0);
    }

    /* ---------- PIPELINE (robusto) ---------- */
    let pipeline_by_source = [];
    let pipeline_by_owner = [];
    let pipeline_summary = { won: 0, lost: 0, win_rate: 0, stages: [], table: PIPE || (hasClientes ? "clientes" : null) };

    if (PIPE) {
      const cols = await tableColumns(PIPE);

      // columnas candidatas
      const createdCol = pickOne(cols, ["created_at", "createdon", "created"]);
      const updatedCol = pickOne(cols, ["updated_at", "updatedon", "updated"]);
      const closedCol = pickOne(cols, ["closed_at", "closedon", "closed"]);
      const stageCol = pickOne(cols, ["stage", "estado", "etapa"]);
      const resultCol = pickOne(cols, ["result", "resultado", "status"]);

      const ownerCandidates = ["assignee", "owner", "usuario_email", "user_email", "email"];
      const ownerExprParts = ownerCandidates.filter((c) => cols.has(c)).map((c) => `NULLIF(${c},'')`);
      const ownerExpr = ownerExprParts.length ? `COALESCE(${ownerExprParts.join(", ")}, 'Unassigned')` : `'Unassigned'`;

      const sourceCandidates = ["source", "origin", "lead_source", "origen"];
      const sourceExprParts = sourceCandidates.filter((c) => cols.has(c)).map((c) => c);
      const sourceExpr = sourceExprParts.length ? `COALESCE(${sourceExprParts.join(", ")}, 'Unknown')` : `'Unknown'`;

      // cláusulas de fecha (si no hay columna, consumimos $2/$3 con tautología)
      const dateCol = createdCol || updatedCol || closedCol;
      const rangeClause = dateCol
        ? `${dateCol} >= $2::timestamptz AND ${dateCol} < $3::timestamptz`
        : `($2::timestamptz IS NOT NULL AND $3::timestamptz IS NOT NULL)`;

      // condiciones won/lost robustas (si no hay stage/result, solo lo que exista)
      const wonCond = `(${stageCol ? `${stageCol} ~* '^(won|ganad)'` : "FALSE"}${
        resultCol ? ` OR ${resultCol}='won'` : ""
      })`;
      const lostCond = `(${stageCol ? `${stageCol} ~* '^(lost|perdid)'` : "FALSE"}${
        resultCol ? ` OR ${resultCol}='lost'` : ""
      })`;

      const bySourceSQL = `
        WITH agg AS (
          SELECT ${sourceExpr} AS source,
                 SUM(CASE WHEN ${wonCond}  THEN 1 ELSE 0 END)::int AS won,
                 SUM(CASE WHEN ${lostCond} THEN 1 ELSE 0 END)::int AS lost
            FROM ${PIPE}
           WHERE organizacion_id::text = $1::text
             AND ${rangeClause}
           GROUP BY 1
        )
        SELECT source, won, lost,
               CASE WHEN (won+lost)>0 THEN ROUND(100.0*won/(won+lost))::int ELSE 0 END AS win_rate
          FROM agg
         ORDER BY win_rate DESC, won DESC, source ASC`;
      const bySource = await q(bySourceSQL, [orgId, fromISO, toISO]);
      pipeline_by_source = bySource.rows || [];

      const byOwnerSQL = `
        WITH base AS (
          SELECT
            ${ownerExpr} AS owner,
            ${stageCol ? stageCol : "NULL"} AS stage,
            ${resultCol ? resultCol : "NULL"} AS result,
            organizacion_id
          FROM ${PIPE}
          WHERE organizacion_id::text = $1::text
            AND ${rangeClause}
        ),
        agg AS (
          SELECT owner,
                 SUM(CASE WHEN ${wonCond}  THEN 1 ELSE 0 END)::int AS won,
                 SUM(CASE WHEN ${lostCond} THEN 1 ELSE 0 END)::int AS lost
            FROM base
           GROUP BY 1
        )
        SELECT owner, won, lost,
               CASE WHEN (won+lost)>0 THEN ROUND(100.0*won/(won+lost))::int ELSE 0 END AS win_rate
          FROM agg
         ORDER BY win_rate DESC, won DESC, owner ASC`;
      const byOwner = await q(byOwnerSQL, [orgId, fromISO, toISO]);
      pipeline_by_owner = byOwner.rows || [];

      const dateAggExpr = `COALESCE(${[closedCol, updatedCol, createdCol].filter(Boolean).join(", ") || "NULL"}, NOW())`;
      const wonLostAgg = await q(
        `SELECT
           SUM(CASE WHEN ${wonCond}  THEN 1 ELSE 0 END)::int AS won,
           SUM(CASE WHEN ${lostCond} THEN 1 ELSE 0 END)::int AS lost
         FROM ${PIPE}
        WHERE organizacion_id::text = $1::text
          AND ${dateAggExpr} >= $2::timestamptz
          AND ${dateAggExpr} <  $3::timestamptz`,
        [orgId, fromISO, toISO]
      );
      const wonTotal = num(wonLostAgg.rows?.[0]?.won, 0);
      const lostTotal = num(wonLostAgg.rows?.[0]?.lost, 0);
      const win_rate = (wonTotal + lostTotal) > 0 ? Math.round((wonTotal * 100) / (wonTotal + lostTotal)) : 0;

      const stagesAggSQL = `
        SELECT COALESCE(${stageCol ? stageCol : "'Uncategorized'"} ,'Uncategorized') AS stage, COUNT(*)::int AS total
          FROM ${PIPE}
         WHERE organizacion_id::text = $1::text
           AND ${rangeClause}
         GROUP BY 1`;
      const stagesAgg = await q(stagesAggSQL, [orgId, fromISO, toISO]);

      pipeline_summary = {
        won: wonTotal,
        lost: lostTotal,
        win_rate,
        stages: stagesAgg.rows || [],
        table: PIPE,
      };
    }

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
      const r = await q(`SELECT * FROM v_ar_aging WHERE organizacion_id::text = $1::text`, [orgId]);
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
          AND organizacion_id::text = $1::text`,
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

      const sales30 = await q(
        `SELECT COALESCE(SUM(amount_total),0) AS s
           FROM invoices
          WHERE organizacion_id::text = $1::text
            AND issue_date >= (CURRENT_DATE - INTERVAL '30 days')
            AND status IN ('sent','partial','paid','overdue')`,
        [orgId]
      );
      const s = num(sales30.rows?.[0]?.s, 0);
      const daily = s / 30;
      ar.dso_days = daily > 0 ? Math.round(num(ar.total) / daily) : 0;
    }

    /* ---------- Qualification (sobre clientes) ---------- */
    let qualifiedCount = 0;
    let uncontactableCount = 0;
    let noFirstTouchCount = 0;
    let uncategorizedCount = 0;
    let stalledIncomingCount = 0;

    if (hasClientes) {
      const qualifiedRes = await q(
        `SELECT COUNT(*)::int AS n
           FROM clientes
          WHERE organizacion_id::text = $1::text
            AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
            AND (
              stage IN ('Qualified','Bid/Estimate Sent','Won') OR
              stage ~* '^(calificad|presup|ganad)'
            )`,
        [orgId, fromISO, toISO]
      );
      qualifiedCount = qualifiedRes.rows?.[0]?.n ?? 0;

      const uncontactableRes = await q(
        `SELECT COUNT(*)::int AS n
           FROM clientes c
          WHERE c.organizacion_id::text = $1::text
            AND c.created_at >= $2::timestamptz AND c.created_at < $3::timestamptz
            AND COALESCE(NULLIF(TRIM(c.email), ''), '') = ''
            AND COALESCE(NULLIF(TRIM(c.telefono), ''), '') = ''`,
        [orgId, fromISO, toISO]
      );
      uncontactableCount = uncontactableRes.rows?.[0]?.n ?? 0;

      const noFirstTouchRes = await q(
        `SELECT COUNT(*)::int AS n
           FROM clientes c
          WHERE c.organizacion_id::text = $1::text
            AND c.created_at >= $2::timestamptz AND c.created_at < $3::timestamptz
            AND NOT EXISTS (
              SELECT 1 FROM tareas t
               WHERE t.cliente_id = c.id
                 AND t.organizacion_id::text = $1::text
            )`,
        [orgId, fromISO, toISO]
      );
      noFirstTouchCount = noFirstTouchRes.rows?.[0]?.n ?? 0;

      const uncategorizedRes = await q(
        `SELECT COUNT(*)::int AS n
           FROM clientes c
          WHERE c.organizacion_id::text = $1::text
            AND c.created_at >= $2::timestamptz AND c.created_at < $3::timestamptz
            AND (
              c.stage IS NULL OR TRIM(c.stage) = '' OR
              NOT (c.stage ~* '(incoming|lead|entrante|unqualified|calificad|qualified|follow|seguim|perdid|lost|bid|estimate|presup|won|ganad)')
            )`,
        [orgId, fromISO, toISO]
      );
      uncategorizedCount = uncategorizedRes.rows?.[0]?.n ?? 0;

      const stalledIncomingRes = await q(
        `SELECT COUNT(*)::int AS n
           FROM clientes c
          WHERE c.organizacion_id::text = $1::text
            AND c.stage ~* '^(incoming|lead|entrante)'
            AND c.created_at <= NOW() - (($2::int || ' days')::interval)
            AND NOT EXISTS (
              SELECT 1 FROM tareas t
               WHERE t.cliente_id = c.id
                 AND t.organizacion_id::text = $1::text
            )`,
        [orgId, stalledDays]
      );
      stalledIncomingCount = stalledIncomingRes.rows?.[0]?.n ?? 0;
    }

    /* ---------- Respuesta ---------- */
    res.json({
      range: { from: fromISO, to: toISO },
      contacts: { total: totalContacts, new_by_day, contactability_pct, first_touch },
      tasks: { overdue: tasks_overdue, due_next_7d: tasks_next_7d },
      ar,
      pipeline: {
        by_source: pipeline_by_source,
        by_owner: pipeline_by_owner,
        summary: pipeline_summary,
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
        stalled_in_incoming: { total: 0, days: 7 },
      },
    });
  }
});

/* =================== KPIs de tareas =================== */
router.get("/tasks/kpis", authenticateToken, nocache, async (req, res) => {
  try {
    const orgId = getOrgText(req);
    const hasView = await regclassExists("v_tareas_overview");
    if (!hasView) return res.json([]);
    const r = await q(`SELECT * FROM public.v_tareas_overview WHERE organizacion_id::text = $1::text`, [orgId]);
    if (r.rows?.length === 1) return res.json(r.rows[0]);
    return res.json(r.rows || []);
  } catch (e) {
    console.error("[GET /analytics/tasks/kpis]", e?.stack || e?.message || e);
    res.status(200).json([]);
  }
});

export default router;
