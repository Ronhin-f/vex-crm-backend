// routes/dashboard.js — Dashboard KPIs (blindado, multi-tenant, snapshot AR/DSO) 
import { Router } from "express";
import { q } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";
import { resolveOrgId, hasTable, tableColumns } from "../utils/schema.js";

const router = Router();

/* ------------------------ helpers ------------------------ */
async function regclassExists(name) {
  try {
    const r = await q(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${name}`]);
    return !!r.rows?.[0]?.ok;
  } catch {
    return false;
  }
}
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);

function pickOne(set, candidates) {
  for (const c of candidates) if (set.has(c)) return c;
  return null;
}

/**
 * Filtro seguro por organización:
 * - Si hay org y la tabla tiene columna -> usa cast TEXT (`organizacion_id::text = $X::text`)
 * - Si NO hay columna o NO hay org -> devuelve "1=0" para no mezclar tenants (y evitar fugas).
 */
function orgFilterText(cols, orgId) {
  const where = [];
  const params = [];
  if (orgId && cols.has("organizacion_id")) {
    params.push(String(orgId));
    where.push(`organizacion_id::text = $${params.length}::text`);
  } else {
    where.push("1=0");
  }
  return { where, params };
}

/* ========================= GET / ========================= */
router.get("/", authenticateToken, async (req, res) => {
  const out = {
    metrics: {
      won: 0, lost: 0, win_rate: 0,
      unqualified: 0,
      followups_7d: 0, overdue: 0,
      total_clientes: 0, total_tareas: 0, total_proyectos: 0,
      contactability: 0,
      first_touch_p50_min: 0, first_touch_avg_min: 0,
      ar_total: 0, ar_overdue_amount: 0, ar_overdue_count: 0, ar_due_next_7: 0, ar_dso_days: 0,
    },
    topClientes: [],
    proximosSeguimientos: [],
  };

  try {
    let orgId = null;
    try { orgId = await resolveOrgId(req); } catch { orgId = null; }

    /* ======= Detección de tablas/columnas ======= */
    const hasClientes  = await hasTable("clientes");
    const hasTareas    = await hasTable("tareas");
    const hasProyectos = await hasTable("proyectos");
    const hasInvoices  = await hasTable("invoices");
    const hasARView    = await regclassExists("v_ar_aging");

    const colsClientes  = hasClientes  ? await tableColumns("clientes")  : new Set();
    const colsTareas    = hasTareas    ? await tableColumns("tareas")    : new Set();
    const colsProyectos = hasProyectos ? await tableColumns("proyectos") : new Set();
    const colsInvoices  = hasInvoices  ? await tableColumns("invoices")  : new Set();
    const colsAgingView = hasARView    ? await tableColumns("v_ar_aging") : new Set();

    /* ======= Totales base ======= */
    try {
      if (hasClientes) {
        const { where, params } = orgFilterText(colsClientes, orgId);
        const r = await q(`SELECT COUNT(*)::int AS total FROM public.clientes WHERE ${where.join(" AND ")}`, params);
        out.metrics.total_clientes = num(r.rows?.[0]?.total, 0);
      }
      if (hasTareas) {
        const { where, params } = orgFilterText(colsTareas, orgId);
        const r = await q(`SELECT COUNT(*)::int AS total FROM public.tareas WHERE ${where.join(" AND ")}`, params);
        out.metrics.total_tareas = num(r.rows?.[0]?.total, 0);
      }
      if (hasProyectos) {
        const { where, params } = orgFilterText(colsProyectos, orgId);
        const r = await q(`SELECT COUNT(*)::int AS total FROM public.proyectos WHERE ${where.join(" AND ")}`, params);
        out.metrics.total_proyectos = num(r.rows?.[0]?.total, 0);
      }
    } catch {}

    /* ======= Won/Lost/Unqualified (proyectos) ======= */
    try {
      if (hasProyectos) {
        const stageCol  = pickOne(colsProyectos, ["stage", "estado", "etapa"]);
        const resultCol = pickOne(colsProyectos, ["result", "resultado", "status"]);
        if (stageCol || resultCol) {
          const wonCond  = `(${stageCol ? `${stageCol} ~* '^(won|ganad)'` : "FALSE"}${resultCol ? ` OR ${resultCol}='won'` : ""})`;
          const lostCond = `(${stageCol ? `${stageCol} ~* '^(lost|perdid)'` : "FALSE"}${resultCol ? ` OR ${resultCol}='lost'` : ""})`;
          const unqCond  = `(${stageCol ? `${stageCol} ~* 'unqualif|no\\s*calif'` : "FALSE"}${resultCol ? ` OR ${resultCol}='unqualified'` : ""})`;

          const { where, params } = orgFilterText(colsProyectos, orgId);
          const r = await q(
            `
            SELECT
              SUM(CASE WHEN ${wonCond}  THEN 1 ELSE 0 END)::int AS won,
              SUM(CASE WHEN ${lostCond} THEN 1 ELSE 0 END)::int AS lost,
              SUM(CASE WHEN ${unqCond}  THEN 1 ELSE 0 END)::int AS unqualified
            FROM public.proyectos
            WHERE ${where.join(" AND ")}
            `,
            params
          );
          const won  = num(r.rows?.[0]?.won, 0);
          const lost = num(r.rows?.[0]?.lost, 0);
          const unq  = num(r.rows?.[0]?.unqualified, 0);
          out.metrics.won = won;
          out.metrics.lost = lost;
          out.metrics.unqualified = unq;
          out.metrics.win_rate = (won + lost) > 0 ? Math.round((won * 100) / (won + lost)) : 0;
        }
      }
    } catch {}

    /* ======= Follow-ups 7d / Overdue (tareas) ======= */
    try {
      if (hasTareas && colsTareas.has("vence_en") && colsTareas.has("completada")) {
        const { where, params } = orgFilterText(colsTareas, orgId);
        const extra = where.length ? ` AND ${where.join(" AND ")}` : "";
        const r = await q(
          `
          SELECT
            SUM(CASE WHEN completada = FALSE AND vence_en IS NOT NULL
                      AND vence_en <= NOW() + INTERVAL '7 days'
                      AND vence_en >= NOW() THEN 1 ELSE 0 END)::int AS f7,
            SUM(CASE WHEN completada = FALSE AND vence_en IS NOT NULL
                      AND vence_en < NOW() THEN 1 ELSE 0 END)::int AS overdue
          FROM public.tareas
          WHERE TRUE ${extra}
          `,
          params
        );
        out.metrics.followups_7d = num(r.rows?.[0]?.f7, 0);
        out.metrics.overdue      = num(r.rows?.[0]?.overdue, 0);
      }
    } catch {}

    /* ======= Contactability (clientes con email o teléfono) ======= */
    try {
      if (hasClientes) {
        const hasEmail = colsClientes.has("email");
        const hasTel   = colsClientes.has("telefono");
        const { where, params } = orgFilterText(colsClientes, orgId);
        const contactExpr = hasEmail || hasTel
          ? `COALESCE(NULLIF(TRIM(${hasEmail ? "email" : "NULL"}),''), NULLIF(TRIM(${hasTel ? "telefono" : "NULL"}),''))`
          : "NULL";
        const r = await q(
          `
          SELECT
            COUNT(*)::int AS total,
            SUM(CASE WHEN ${contactExpr} IS NOT NULL THEN 1 ELSE 0 END)::int AS contactable
          FROM public.clientes
          WHERE ${where.join(" AND ")}
          `,
          params
        );
        const totalCli = num(r.rows?.[0]?.total, 0);
        const contact  = num(r.rows?.[0]?.contactable, 0);
        out.metrics.contactability = totalCli > 0 ? Math.round((contact * 100) / totalCli) : 0;
      }
    } catch {}

    /* ======= First touch (p50/avg en minutos) ======= */
    try {
      if (hasClientes && hasTareas && colsClientes.has("created_at") && colsTareas.has("created_at") && colsTareas.has("cliente_id")) {
        const { where, params } = orgFilterText(colsClientes, orgId);
        const cond = where.length ? `WHERE ${where.join(" AND ")}` : "WHERE 1=0";
        const r = await q(
          `
          WITH firsts AS (
            SELECT c.id AS cliente_id,
                   EXTRACT(EPOCH FROM (MIN(t.created_at) - c.created_at))/60.0 AS mins
            FROM public.clientes c
            JOIN public.tareas   t ON t.cliente_id = c.id
            ${cond}
            GROUP BY c.id, c.created_at
            HAVING MIN(t.created_at) IS NOT NULL AND c.created_at IS NOT NULL
          )
          SELECT
            COALESCE(ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY mins)::numeric), 0) AS p50,
            COALESCE(ROUND(AVG(mins)::numeric), 0) AS avg
          FROM firsts
          `,
          params
        );
        out.metrics.first_touch_p50_min = num(r.rows?.[0]?.p50, 0);
        out.metrics.first_touch_avg_min = num(r.rows?.[0]?.avg, 0);
      }
    } catch {}

    /* ======= Snapshot AR (Aging / Overdue / Due next 7 / DSO) ======= */
    try {
      if (hasARView) {
        const where = (orgId && colsAgingView.has("organizacion_id"))
          ? `WHERE organizacion_id::text = $1::text`
          : `WHERE 1=0`;
        const params = (orgId && colsAgingView.has("organizacion_id")) ? [String(orgId)] : [];
        const v = (await q(`SELECT * FROM public.v_ar_aging ${where} LIMIT 1`, params)).rows?.[0] || {};
        out.metrics.ar_total          = num(v.ar_total, 0);
        out.metrics.ar_overdue_amount = num(v.overdue_amount, 0);
        out.metrics.ar_overdue_count  = num(v.overdue_count, 0);
        out.metrics.ar_due_next_7     = num(v.due_next_7, 0);
      } else if (hasInvoices) {
        const { where, params } = orgFilterText(colsInvoices, orgId);
        const w = where.length ? ` AND ${where.join(" AND ")}` : " AND 1=0";
        const base = await q(
          `
          SELECT
            SUM(GREATEST(amount_total - amount_paid,0)) AS ar_total,
            COUNT(*) FILTER (WHERE (now()::date - due_date) > 0)::int AS overdue_count,
            SUM(GREATEST(amount_total - amount_paid,0)) FILTER (WHERE (now()::date - due_date) > 0) AS overdue_amount,
            SUM(GREATEST(amount_total - amount_paid,0)) FILTER (WHERE due_date BETWEEN now()::date AND (now()::date + 7)) AS due_next_7
          FROM public.invoices
          WHERE status IN ('sent','partial','overdue') ${w}
          `,
          params
        );
        const v = base.rows?.[0] || {};
        out.metrics.ar_total          = num(v.ar_total, 0);
        out.metrics.ar_overdue_amount = num(v.overdue_amount, 0);
        out.metrics.ar_overdue_count  = num(v.overdue_count, 0);
        out.metrics.ar_due_next_7     = num(v.due_next_7, 0);
      }

      // DSO simple: AR / (ventas_últimos_30 / 30)
      if (hasInvoices) {
        const { where, params } = orgFilterText(colsInvoices, orgId);
        const w = where.length ? ` AND ${where.join(" AND ")}` : " AND 1=0";
        const s30 = await q(
          `
          SELECT COALESCE(SUM(amount_total),0) AS s
          FROM public.invoices
          WHERE issue_date >= (now()::date - INTERVAL '30 days')
            AND status IN ('sent','partial','paid','overdue') ${w}
          `,
          params
        );
        const sales = num(s30.rows?.[0]?.s, 0);
        const daily = sales / 30;
        out.metrics.ar_dso_days = daily > 0 ? Math.round(num(out.metrics.ar_total) / daily) : 0;
      }
    } catch {}

    /* ======= Top clientes recientes ======= */
    try {
      if (hasClientes) {
        const { where, params } = orgFilterText(colsClientes, orgId);
        const hasCreatedAt = colsClientes.has("created_at");
        const sqlTop = `
          SELECT id, nombre,
                 ${colsClientes.has("email") ? "email" : "NULL::text AS email"},
                 ${colsClientes.has("telefono") ? "telefono" : "NULL::text AS telefono"},
                 ${hasCreatedAt ? "created_at" : "NULL::timestamptz AS created_at"}
          FROM public.clientes
          WHERE ${where.join(" AND ")}
          ORDER BY ${hasCreatedAt ? "created_at DESC NULLS LAST" : "id DESC"}
          LIMIT 5
        `;
        let top = (await q(sqlTop, params)).rows || [];

        if (!top.length && hasProyectos) {
          const { where: wp, params: pp } = orgFilterText(colsProyectos, orgId);
          const joinCli = hasClientes && colsClientes.has("id");
          const sameTenantJoin = (colsClientes.has("organizacion_id") && colsProyectos.has("organizacion_id"))
            ? ` AND c.organizacion_id::text = p.organizacion_id::text` : ``;

          const rTopP = await q(
            `
            SELECT
              COALESCE(c.id, p.cliente_id) AS id,
              COALESCE(c.nombre, p.nombre)  AS nombre,
              ${colsClientes.has("email") ? "COALESCE(c.email, NULL) AS email" : "NULL::text AS email"},
              ${colsClientes.has("telefono") ? "COALESCE(c.telefono, NULL) AS telefono" : "NULL::text AS telefono"},
              ${colsProyectos.has("created_at") ? "p.created_at" : "NULL::timestamptz AS created_at"}
            FROM public.proyectos p
            ${joinCli ? "LEFT JOIN public.clientes c ON c.id = p.cliente_id" : ""}
            ${joinCli ? sameTenantJoin : ""}
            WHERE ${wp.join(" AND ")}
            ORDER BY ${colsProyectos.has("created_at") ? "p.created_at DESC NULLS LAST," : ""} p.id DESC
            LIMIT 5
            `,
            pp
          );
          top = rTopP.rows || [];
        }
        out.topClientes = top;
      }
    } catch {}

    /* ======= Próximos seguimientos (<= 7 días) ======= */
    try {
      if (hasTareas && colsTareas.has("vence_en") && colsTareas.has("completada")) {
        const { where, params } = orgFilterText(colsTareas, orgId);
        const joinCli = hasClientes; // opcional
        const colsCli = joinCli ? await tableColumns("clientes") : new Set();

        const sameTenantJoin = (joinCli && colsCli.has("organizacion_id") && colsTareas.has("organizacion_id"))
          ? ` AND c.organizacion_id::text = t.organizacion_id::text` : ``;

        const r = await q(
          `
          SELECT
            t.id, 
            ${colsTareas.has("titulo") ? "t.titulo" : "NULL::text AS titulo"},
            ${colsTareas.has("descripcion") ? "t.descripcion" : "NULL::text AS descripcion"},
            t.vence_en, t.completada,
            ${colsTareas.has("cliente_id") ? "t.cliente_id" : "NULL::int AS cliente_id"},
            ${joinCli && colsCli.has("nombre") ? "c.nombre AS cliente_nombre" : "NULL::text AS cliente_nombre"}
          FROM public.tareas t
          ${joinCli ? "LEFT JOIN public.clientes c ON c.id = t.cliente_id" : ""}
          ${joinCli ? sameTenantJoin : ""}
          WHERE ${where.join(" AND ")}
            AND t.completada = FALSE
            AND t.vence_en IS NOT NULL
            AND t.vence_en <= NOW() + INTERVAL '7 days'
          ORDER BY t.vence_en ASC NULLS LAST, t.id DESC
          LIMIT 20
          `,
          params
        );
        out.proximosSeguimientos = r.rows || [];
      }
    } catch {}

    return res.json(out);
  } catch (e) {
    console.error("[GET /dashboard] error:", e?.stack || e?.message || e);
    // Nunca 500; estructura válida, valores 0
    return res.status(200).json(out);
  }
});

export default router;
