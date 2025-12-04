// Backend/routes/dashboard.js
import { Router } from "express";
import { q } from "../utils/db.js";
import { authenticateToken as auth } from "../middleware/auth.js";

const router = Router();

/* ------------------------ helpers ------------------------ */
const T = (v) => (v == null ? null : String(v).trim() || null);

/** Obtiene org como TEXT desde token/header/query/body (sin castear a int) */
function getOrgText(req) {
  return (
    T(req.usuario?.organizacion_id) ||
    T(req.headers["x-org-id"]) ||
    T(req.query?.organizacion_id) ||
    T(req.body?.organizacion_id) ||
    null
  );
}

/** ¿Existe regclass (tabla/vista) en schema public? */
async function regclassExists(name) {
  try {
    const r = await q(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${name}`]);
    return !!r.rows?.[0]?.ok;
  } catch {
    return false;
  }
}

/** Alias semántico para tablas (usa regclass) */
async function hasTable(name) {
  return regclassExists(name);
}

/** Set de columnas de tabla/vista en public */
async function tableColumns(name) {
  try {
    const r = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1`,
      [name]
    );
    const set = new Set();
    for (const row of r.rows || []) set.add(row.column_name);
    return set;
  } catch {
    return new Set();
  }
}

const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);

function pickOne(set, candidates) {
  for (const c of candidates) if (set.has(c)) return c;
  return null;
}

/**
 * Filtro multi-tenant TEXT-safe:
 * - Si hay columna `organizacion_id`, compara como TEXT.
 * - Si NO hay columna o no hay org => `1=0` para no mezclar tenants.
 */
function orgFilterText(cols, orgId, alias = null) {
  const where = [];
  const params = [];
  if (orgId && cols.has("organizacion_id")) {
    params.push(String(orgId));
    const q = alias ? `${alias}.organizacion_id` : "organizacion_id";
    where.push(`${q}::text = $${params.length}::text`);
  } else {
    where.push("1=0");
  }
  return { where, params };
}

/* ========================= GET / ========================= */
/**
 * Dashboard payload:
 *  - metrics: {
 *      won, lost, win_rate, unqualified,
 *      followups_7d, proximos_7d, overdue,
 *      total_clientes, total_tareas, total_proyectos,
 *      contactability, first_touch_p50_min, first_touch_avg_min,
 *      ar_total, ar_overdue_amount, ar_overdue_count, ar_due_next_7, ar_dso_days
 *    }
 *  - topClientes: últimos 5
 *  - proximosSeguimientos: tareas a 7d
 */
router.get("/", auth, async (req, res) => {
  const out = {
    metrics: {
      won: 0,
      lost: 0,
      win_rate: 0,
      unqualified: 0,
      followups_7d: 0,
      proximos_7d: 0,
      overdue: 0,
      total_clientes: 0,
      total_tareas: 0,
      total_proyectos: 0,
      contactability: 0,
      first_touch_p50_min: 0,
      first_touch_avg_min: 0,
      ar_total: 0,
      ar_overdue_amount: 0,
      ar_overdue_count: 0,
      ar_due_next_7: 0,
      ar_dso_days: 0,
    },
    topClientes: [],
    proximosSeguimientos: [],
    vacunas: [],
  };

  try {
    const orgId = getOrgText(req);

    /* ======= Detección de tablas/columnas ======= */
    const hasClientes = await hasTable("clientes");
    const hasContactos = await hasTable("contactos");
    const hasTareas = await hasTable("tareas");
    const hasProyectos = await hasTable("proyectos");
    const hasInvoices = await hasTable("invoices");
    const hasARView = await regclassExists("v_ar_aging");

    const colsClientes = hasClientes ? await tableColumns("clientes") : new Set();
    const colsContactos = hasContactos ? await tableColumns("contactos") : new Set();
    const colsTareas = hasTareas ? await tableColumns("tareas") : new Set();
    const colsProyectos = hasProyectos ? await tableColumns("proyectos") : new Set();
    const colsInvoices = hasInvoices ? await tableColumns("invoices") : new Set();
    const colsAR = hasARView ? await tableColumns("v_ar_aging") : new Set();

    /* ======= Totales base ======= */
    try {
      if (hasClientes) {
        const { where, params } = orgFilterText(colsClientes, orgId);
        const r = await q(
          `SELECT COUNT(*)::int AS total FROM clientes ${where.length ? "WHERE " + where.join(" AND ") : ""}`,
          params
        );
        out.metrics.total_clientes = num(r.rows?.[0]?.total, 0);
      }
      if (hasTareas) {
        const { where, params } = orgFilterText(colsTareas, orgId);
        const r = await q(
          `SELECT COUNT(*)::int AS total FROM tareas ${where.length ? "WHERE " + where.join(" AND ") : ""}`,
          params
        );
        out.metrics.total_tareas = num(r.rows?.[0]?.total, 0);
      }
      if (hasProyectos) {
        const { where, params } = orgFilterText(colsProyectos, orgId);
        const r = await q(
          `SELECT COUNT(*)::int AS total FROM proyectos ${where.length ? "WHERE " + where.join(" AND ") : ""}`,
          params
        );
        out.metrics.total_proyectos = num(r.rows?.[0]?.total, 0);
      }
    } catch {
      /* deja 0 */
    }

    /* ======= Won/Lost/Unqualified (proyectos si existen) ======= */
    try {
      if (hasProyectos) {
        const stageCol = pickOne(colsProyectos, ["stage", "estado", "etapa"]);
        const resultCol = pickOne(colsProyectos, ["result", "resultado", "status"]);
        if (stageCol || resultCol) {
          const wonCond = `(${stageCol ? `${stageCol} ~* '^(won|ganad)'` : "FALSE"}${resultCol ? ` OR ${resultCol}='won'` : ""})`;
          const lostCond = `(${stageCol ? `${stageCol} ~* '^(lost|perdid)'` : "FALSE"}${resultCol ? ` OR ${resultCol}='lost'` : ""})`;
          const unqCond = `(${stageCol ? `${stageCol} ~* 'unqualif|no calif|no_calif'` : "FALSE"}${resultCol ? ` OR ${resultCol}='unqualified'` : ""})`;

          const { where, params } = orgFilterText(colsProyectos, orgId);
          const r = await q(
            `
              SELECT
                SUM(CASE WHEN ${wonCond}  THEN 1 ELSE 0 END)::int AS won,
                SUM(CASE WHEN ${lostCond} THEN 1 ELSE 0 END)::int AS lost,
                SUM(CASE WHEN ${unqCond}  THEN 1 ELSE 0 END)::int AS unqualified
              FROM proyectos
              ${where.length ? "WHERE " + where.join(" AND ") : ""}
              `,
            params
          );
          const won = num(r.rows?.[0]?.won, 0);
          const lost = num(r.rows?.[0]?.lost, 0);
          const unq = num(r.rows?.[0]?.unqualified, 0);
          out.metrics.won = won;
          out.metrics.lost = lost;
          out.metrics.unqualified = unq;
          out.metrics.win_rate = won + lost > 0 ? Math.round((won * 100) / (won + lost)) : 0;
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
            FROM tareas
            WHERE TRUE ${extra}
            `,
          params
        );
        out.metrics.followups_7d = num(r.rows?.[0]?.f7, 0);
        out.metrics.proximos_7d = out.metrics.followups_7d;
        out.metrics.overdue = num(r.rows?.[0]?.overdue, 0);
      }
    } catch {}

    /* ======= Contactability (clientes con email o teléfono) ======= */
    try {
      if (hasClientes) {
        const hasEmail = colsClientes.has("email");
        const hasTel = colsClientes.has("telefono");
        const { where, params } = orgFilterText(colsClientes, orgId);
        const w = where.length ? `WHERE ${where.join(" AND ")}` : "";

        let contactExpr = "NULL";
        if (hasEmail && hasTel) contactExpr = `COALESCE(NULLIF(TRIM(email),''), NULLIF(TRIM(telefono),''))`;
        else if (hasEmail) contactExpr = `NULLIF(TRIM(email),'')`;
        else if (hasTel) contactExpr = `NULLIF(TRIM(telefono),'')`;

        const r = await q(
          `
            SELECT
              COUNT(*)::int AS total,
              SUM(CASE WHEN ${contactExpr} IS NOT NULL THEN 1 ELSE 0 END)::int AS contactable
            FROM clientes
            ${w}
            `,
          params
        );
        const totalCli = num(r.rows?.[0]?.total, 0);
        const contact = num(r.rows?.[0]?.contactable, 0);
        out.metrics.contactability = totalCli > 0 ? Math.round((contact * 100) / totalCli) : 0;
      }
    } catch {}

    /* ======= First touch (p50/avg en minutos) ======= */
    try {
      if (hasClientes && hasTareas && colsClientes.has("created_at") && colsTareas.has("created_at") && colsTareas.has("cliente_id")) {
        const pc = [];
        const wc = [];
        if (orgId && colsClientes.has("organizacion_id")) {
          pc.push(String(orgId));
          wc.push(`c.organizacion_id::text = $${pc.length}::text`);
        }
        const condCli = wc.length ? `WHERE ${wc.join(" AND ")}` : "";

        // Si ambas tienen organizacion_id, forzamos join por org también
        const joinOrg =
          colsClientes.has("organizacion_id") && colsTareas.has("organizacion_id")
            ? ` AND t.organizacion_id::text = c.organizacion_id::text`
            : ``;

        const r = await q(
          `
            WITH firsts AS (
              SELECT c.id AS cliente_id,
                    EXTRACT(EPOCH FROM (MIN(t.created_at) - c.created_at))/60.0 AS mins
              FROM clientes c
              JOIN tareas   t ON t.cliente_id = c.id${joinOrg}
              ${condCli}
              GROUP BY c.id, c.created_at
              HAVING MIN(t.created_at) IS NOT NULL AND c.created_at IS NOT NULL
            )
            SELECT
              COALESCE(ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY mins)::numeric), 0) AS p50,
              COALESCE(ROUND(AVG(mins)::numeric), 0) AS avg
            FROM firsts
            `,
          pc
        );
        out.metrics.first_touch_p50_min = num(r.rows?.[0]?.p50, 0);
        out.metrics.first_touch_avg_min = num(r.rows?.[0]?.avg, 0);
      }
    } catch {}

    /* ======= Snapshot AR (Aging / Overdue / Due next 7 / DSO) ======= */
    try {
      if (hasARView) {
        // Chequeo columnas de la VISTA (no de invoices)
        const params = [];
        let sql = `SELECT * FROM v_ar_aging`;
        if (colsAR.has("organizacion_id") && orgId) {
          params.push(String(orgId));
          sql += ` WHERE organizacion_id::text = $1::text`;
        }
        sql += ` LIMIT 1`;
        const v = (await q(sql, params)).rows?.[0] || {};
        out.metrics.ar_total = num(v.ar_total, 0);
        out.metrics.ar_overdue_amount = num(v.overdue_amount, 0);
        out.metrics.ar_overdue_count = num(v.overdue_count, 0);
        out.metrics.ar_due_next_7 = num(v.due_next_7, 0);
      } else if (hasInvoices) {
        const { where, params } = orgFilterText(colsInvoices, orgId);
        const w = where.length ? ` AND ${where.join(" AND ")}` : "";
        const base = await q(
          `
            SELECT
              SUM(GREATEST(amount_total - amount_paid,0)) AS ar_total,
              COUNT(*) FILTER (WHERE (now()::date - due_date) > 0)::int AS overdue_count,
              SUM(GREATEST(amount_total - amount_paid,0)) FILTER (WHERE (now()::date - due_date) > 0) AS overdue_amount,
              SUM(GREATEST(amount_total - amount_paid,0)) FILTER (WHERE due_date BETWEEN now()::date AND (now()::date + 7)) AS due_next_7
            FROM invoices
            WHERE status IN ('sent','partial','overdue') ${w}
            `,
          params
        );
        const v = base.rows?.[0] || {};
        out.metrics.ar_total = num(v.ar_total, 0);
        out.metrics.ar_overdue_amount = num(v.overdue_amount, 0);
        out.metrics.ar_overdue_count = num(v.overdue_count, 0);
        out.metrics.ar_due_next_7 = num(v.due_next_7, 0);
      }

      // DSO simple: AR / (ventas_últimos_30 / 30)
      if (hasInvoices) {
        const { where, params } = orgFilterText(colsInvoices, orgId);
        const w = where.length ? ` AND ${where.join(" AND ")}` : "";
        const s30 = await q(
          `
            SELECT COALESCE(SUM(amount_total),0) AS s
            FROM invoices
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
            FROM clientes
            ${where.length ? "WHERE " + where.join(" AND ") : ""}
            ORDER BY ${hasCreatedAt ? "created_at DESC NULLS LAST" : "id DESC"}
            LIMIT 5
          `;
        let top = (await q(sqlTop, params)).rows || [];

        if (!top.length && hasProyectos) {
          const { where: wp, params: pp } = orgFilterText(colsProyectos, orgId, "p");
          const colsCli = colsClientes; // ya calculado
          const joinOrg =
            colsCli.has("organizacion_id") && colsProyectos.has("organizacion_id")
              ? ` AND (c.organizacion_id::text = p.organizacion_id::text)`
              : ``;

          const rTopP = await q(
            `
              SELECT
                COALESCE(c.id, p.cliente_id) AS id,
                COALESCE(c.nombre, p.nombre)  AS nombre,
                ${colsCli.has("email") ? "COALESCE(c.email, NULL) AS email" : "NULL::text AS email"},
                ${colsCli.has("telefono") ? "COALESCE(c.telefono, NULL) AS telefono" : "NULL::text AS telefono"},
                ${colsProyectos.has("created_at") ? "p.created_at" : "NULL::timestamptz AS created_at"}
              FROM proyectos p
              LEFT JOIN clientes c ON c.id = p.cliente_id${joinOrg}
              ${wp.length ? "WHERE " + wp.join(" AND ") : ""}
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
        const params = [];
        const where = [];
        if (orgId && colsTareas.has("organizacion_id")) {
          params.push(String(orgId));
          where.push(`t.organizacion_id::text = $${params.length}::text`);
        }
        const joinCli = await hasTable("clientes"); // opcional
        const colsCli = joinCli ? await tableColumns("clientes") : new Set();

        const joinOrg =
          colsTareas.has("organizacion_id") && colsCli.has("organizacion_id")
            ? ` AND c.organizacion_id::text = t.organizacion_id::text`
            : ``;

        const r = await q(
          `
            SELECT
              t.id, 
              ${colsTareas.has("titulo") ? "t.titulo" : "NULL::text AS titulo"},
              ${colsTareas.has("descripcion") ? "t.descripcion" : "NULL::text AS descripcion"},
              t.vence_en, t.completada,
              ${colsTareas.has("cliente_id") ? "t.cliente_id" : "NULL::int AS cliente_id"},
              ${joinCli && colsCli.has("nombre") ? "c.nombre AS cliente_nombre" : "NULL::text AS cliente_nombre"}
            FROM tareas t
            ${joinCli ? `LEFT JOIN clientes c ON c.id = t.cliente_id${joinOrg}` : ""}
            WHERE t.completada = FALSE
              AND t.vence_en IS NOT NULL
              AND t.vence_en <= NOW() + INTERVAL '7 days'
              ${where.length ? "AND " + where.join(" AND ") : ""}
            ORDER BY t.vence_en ASC NULLS LAST, t.id DESC
            LIMIT 20
            `,
          params
        );
        out.proximosSeguimientos = r.rows || [];
      }
    } catch {}

    /* Vacunas proximas (14/7/3 dias) */
    try {
      if (hasContactos && colsContactos.has("proxima_vacuna")) {
        const params = [];
        const where = [];
        if (orgId && colsContactos.has("organizacion_id")) {
          params.push(String(orgId));
          where.push(`ct.organizacion_id::text = $${params.length}::text`);
        }
        const joinCli = hasClientes;
        const colsCli = colsClientes;
        const joinOrg =
          joinCli && colsCli.has("organizacion_id") && colsContactos.has("organizacion_id")
            ? ` AND c.organizacion_id::text = ct.organizacion_id::text`
            : ``;

        const r = await q(
          `
            SELECT
              ct.id,
              ${colsContactos.has("nombre") ? "ct.nombre" : "NULL::text AS nombre"},
              ${colsContactos.has("cliente_id") ? "ct.cliente_id" : "NULL::int AS cliente_id"},
              ${colsContactos.has("proxima_vacuna") ? "ct.proxima_vacuna::date" : "NULL::date"} AS proxima_vacuna,
              ${colsContactos.has("vacunas") ? "ct.vacunas" : "NULL::text AS vacunas"},
              ${colsContactos.has("peso") ? "ct.peso" : "NULL::text AS peso"},
              ${colsContactos.has("telefono") ? "ct.telefono" : "NULL::text AS telefono"},
              ${colsContactos.has("email") ? "ct.email" : "NULL::text AS email"},
              ${joinCli && colsCli.has("nombre") ? "c.nombre AS cliente_nombre" : "NULL::text AS cliente_nombre"}
            FROM contactos ct
            ${joinCli ? `LEFT JOIN clientes c ON c.id = ct.cliente_id${joinOrg}` : ""}
            WHERE ct.proxima_vacuna IS NOT NULL
              AND ct.proxima_vacuna::date <= (now()::date + INTERVAL '14 days')
              ${where.length ? "AND " + where.join(" AND ") : ""}
            ORDER BY ct.proxima_vacuna::date ASC NULLS LAST, ct.id DESC
            LIMIT 100
          `,
          params
        );
        out.vacunas = r.rows || [];
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
