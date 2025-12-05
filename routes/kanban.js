// routes/kanban.js — Kanban (proyectos/clientes/tareas) + KPIs (blindado, sin deps fantasmas)
import { Router } from "express";
import { q, CANON_CATS, pipelineForOrg } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";

const router = Router();

/* ---------------------------- helpers inline ---------------------------- */
const T = (v) => (v == null ? null : String(v).trim() || null);
const Nint = (v, d = null) => {
  if (v == null) return d;
  const n = Number.parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : d;
};

// OrgID desde headers/query/body/user (normaliza a int o null)
const resolveOrgId = (req) => {
  const raw =
    T(req.usuario?.organizacion_id) ||
    T(req.headers["x-org-id"]) ||
    T(req.query?.organizacion_id) ||
    T(req.body?.organizacion_id) ||
    null;
  const n = Nint(raw, null);
  return n;
};

// Cache simple de columnas por tabla
const _colsCache = new Map(); // table -> Set(cols)
const hasTable = async (table) => {
  const { rows } = await q(`SELECT to_regclass('public.${table}') IS NOT NULL AS ok`);
  return !!rows?.[0]?.ok;
};
const tableColumns = async (table) => {
  if (_colsCache.has(table)) return _colsCache.get(table);
  const { rows } = await q(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  const set = new Set(rows.map((r) => r.column_name));
  _colsCache.set(table, set);
  return set;
};

// Cache-control equivalente al viejo nocache (sin middleware)
const noStore = (res) => {
  res.set("Cache-Control", "no-store");
};

const ORDER =
  Array.isArray(CANON_CATS) && CANON_CATS.length
    ? CANON_CATS
    : [
        "Incoming Leads",
        "Unqualified",
        "Qualified",
        "Follow-up Missed",
        "Bid/Estimate Sent",
        "Won",
        "Lost",
      ];
const PIPELINE_SET = new Set(ORDER);

const coerceText = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
};
const isTruthy = (v) => {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "t" || s === "yes" || s === "y" || s === "on";
};

async function pipelineCtx(req) {
  const order = await pipelineForOrg(resolveOrgId(req));
  return { order, set: new Set(order) };
}

/* ============================ KPIs ============================ */
router.get("/kpis", authenticateToken, async (req, res) => {
  noStore(res);
  try {
    const orgId = resolveOrgId(req);

    // ---- PROYECTOS
    let proyectosPorStage = { rows: [] };
    let proximos7d_proyectos = 0;

    if (await hasTable("proyectos")) {
      const pCols = await tableColumns("proyectos");
      const stageExpr = pCols.has("stage")
        ? "COALESCE(p.stage,'Uncategorized')"
        : pCols.has("categoria")
          ? "COALESCE(p.categoria,'Uncategorized')"
          : "'Uncategorized'";
      const whereP = [];
      const paramsP = [];
      if (pCols.has("organizacion_id") && orgId != null) {
        paramsP.push(orgId);
        whereP.push(`p.organizacion_id = $${paramsP.length}`);
      }
      proyectosPorStage = await q(
        `SELECT ${stageExpr} AS stage, COUNT(*)::int AS total
           FROM proyectos p
          ${whereP.length ? "WHERE " + whereP.join(" AND ") : ""}
          GROUP BY 1
          ORDER BY total DESC`,
        paramsP
      );

      if (pCols.has("due_date")) {
        const p2 = [];
        const w2 = [`p.due_date IS NOT NULL`, `p.due_date <= NOW() + INTERVAL '7 days'`];
        if (pCols.has("organizacion_id") && orgId != null) {
          p2.push(orgId);
          w2.push(`p.organizacion_id = $${p2.length}`);
        }
        const r = await q(
          `SELECT COUNT(*)::int AS total FROM proyectos p WHERE ${w2.join(" AND ")}`,
          p2
        );
        proximos7d_proyectos = r.rows?.[0]?.total ?? 0;
      }
    }

    // ---- CLIENTES
    let clientesPorStage = { rows: [] };
    let clientesPorCat = { rows: [] };
    if (await hasTable("clientes")) {
      const cCols = await tableColumns("clientes");
      const whereC = [];
      const paramsC = [];
      if (cCols.has("organizacion_id") && orgId != null) {
        paramsC.push(orgId);
        whereC.push(`organizacion_id = $${paramsC.length}`);
      }

      const cliStageExpr = cCols.has("stage")
        ? "COALESCE(stage,'Uncategorized')"
        : cCols.has("categoria")
          ? "COALESCE(categoria,'Uncategorized')"
          : "'Uncategorized'";

      clientesPorStage = await q(
        `SELECT ${cliStageExpr} AS stage, COUNT(*)::int AS total
           FROM clientes
          ${whereC.length ? "WHERE " + whereC.join(" AND ") : ""}
          GROUP BY 1
          ORDER BY total DESC`,
        paramsC
      );
      clientesPorCat = await q(
        `SELECT COALESCE(${cCols.has("categoria") ? "categoria" : "NULL::text"},'Uncategorized') AS categoria, COUNT(*)::int AS total
           FROM clientes
          ${whereC.length ? "WHERE " + whereC.join(" AND ") : ""}
          GROUP BY 1
          ORDER BY total DESC`,
        paramsC
      );
    }

    // ---- TAREAS
    let tareasPorEstado = { rows: [] };
    let proximos7d = 0;
    if (await hasTable("tareas")) {
      const tCols = await tableColumns("tareas");
      const whereT = [];
      const paramsT = [];
      if (tCols.has("organizacion_id") && orgId != null) {
        paramsT.push(orgId);
        whereT.push(`organizacion_id = $${paramsT.length}`);
      }

      const estadoExpr = tCols.has("estado")
        ? "COALESCE(estado,'todo')"
        : tCols.has("completada")
          ? "CASE WHEN completada THEN 'done' ELSE 'todo' END"
          : "'todo'";

      tareasPorEstado = await q(
        `SELECT ${estadoExpr} AS estado, COUNT(*)::int AS total
           FROM tareas
          ${whereT.length ? "WHERE " + whereT.join(" AND ") : ""}
          GROUP BY 1
          ORDER BY total DESC`,
        paramsT
      );

      if (tCols.has("vence_en")) {
        const p2 = [];
        const w2 = [
          `t.vence_en IS NOT NULL`,
          `t.vence_en <= NOW() + INTERVAL '7 days'`,
        ];
        if (tCols.has("completada")) w2.unshift(`t.completada = FALSE`);
        if (tCols.has("organizacion_id") && orgId != null) {
          p2.push(orgId);
          w2.push(`t.organizacion_id = $${p2.length}`);
        }
        const r = await q(
          `SELECT COUNT(*)::int AS total FROM tareas t WHERE ${w2.join(" AND ")}`,
          p2
        );
        proximos7d = r.rows?.[0]?.total ?? 0;
      }
    }

    res.json({
      proyectosPorStage: proyectosPorStage.rows || [],
      proximos7d_proyectos,
      clientesPorStage: clientesPorStage.rows || [],
      clientesPorCat: clientesPorCat.rows || [],
      tareasPorEstado: tareasPorEstado.rows || [],
      proximos7d,
      proximos_7d: proximos7d, // compat
    });
  } catch (e) {
    console.error("[GET /kanban/kpis]", e?.stack || e?.message || e);
    res.status(200).json({
      proyectosPorStage: [],
      proximos7d_proyectos: 0,
      clientesPorStage: [],
      clientesPorCat: [],
      tareasPorEstado: [],
      proximos7d: 0,
      proximos_7d: 0,
    });
  }
});

/* ====================== Kanban de PROYECTOS ===================== */
router.get("/proyectos", authenticateToken, async (req, res) => {
  noStore(res);
  try {
    const { order: orderPipeline, set: pipelineSet } = await pipelineCtx(req);

    if (!(await hasTable("proyectos"))) {
      const columns = orderPipeline.map((name) => ({ key: name, title: name, count: 0, items: [] }));
      return res.status(200).json({ columns, order: orderPipeline });
    }

    const orgId = resolveOrgId(req);
    const hasCli = await hasTable("clientes");
    const pCols = await tableColumns("proyectos");
    const cCols = hasCli ? await tableColumns("clientes") : new Set();

    const { q: qtext, source, assignee, stage, only_due } = req.query || {};
    const params = [];
    const where = [];

    if (pCols.has("organizacion_id") && orgId != null) {
      params.push(orgId);
      where.push(`p.organizacion_id = $${params.length}`);
    }
    if (stage && pCols.has("stage")) {
      params.push(String(stage));
      where.push(`p.stage = $${params.length}`);
    }
    if (source && pCols.has("source")) {
      params.push(String(source));
      where.push(`p.source = $${params.length}`);
    }
    if (assignee && pCols.has("assignee")) {
      if (/^(sin asignar|unassigned)$/i.test(String(assignee))) {
        where.push(`(p.assignee IS NULL OR TRIM(p.assignee) = '')`);
      } else {
        params.push(String(assignee));
        where.push(`p.assignee = $${params.length}`);
      }
    }
    if (isTruthy(only_due) && pCols.has("due_date")) where.push(`p.due_date IS NOT NULL`);

    if (qtext) {
      const qval = `%${String(qtext).trim()}%`;
      params.push(qval);
      const i = params.length;
      const ors = [];
      if (pCols.has("nombre")) ors.push(`p.nombre ILIKE $${i}`);
      if (pCols.has("email")) ors.push(`p.email ILIKE $${i}`);
      if (pCols.has("telefono")) ors.push(`CAST(p.telefono AS TEXT) ILIKE $${i}`);
      if (hasCli && cCols.has("email")) ors.push(`c.email ILIKE $${i}`);
      if (hasCli && cCols.has("telefono")) ors.push(`CAST(c.telefono AS TEXT) ILIKE $${i}`);
      if (hasCli && cCols.has("nombre")) ors.push(`c.nombre ILIKE $${i}`);
      if (ors.length) where.push("(" + ors.join(" OR ") + ")");
    }

    const joinCli = hasCli ? `LEFT JOIN clientes c ON c.id = p.cliente_id` : "";

    const sel = (colName, tableAlias, asType = "text") => {
      const colSet = tableAlias === "p" ? pCols : cCols;
      if (colSet.has(colName)) return `${tableAlias}.${colName}`;
      if (asType === "timestamptz") return "NULL::timestamptz";
      if (asType === "int") return "NULL::int";
      return "NULL::text";
    };

    const rs = await q(
      `SELECT
         ${sel("id", "p", "int")} AS id,
         ${sel("cliente_id", "p", "int")} AS cliente_id,
         ${sel("nombre", "p")} AS nombre,
         ${hasCli ? sel("nombre", "c") : "NULL::text"} AS cliente_nombre,
         COALESCE(${sel("email", "p")}, ${hasCli ? sel("email", "c") : "NULL::text"}) AS email,
         CAST(COALESCE(${sel("telefono", "p")}, ${
           hasCli ? sel("telefono", "c") : "NULL::text"
         }) AS TEXT) AS telefono,
         ${sel("stage", "p")}   AS stage,
         ${sel("categoria", "p")} AS categoria,
         ${sel("source", "p")}  AS source,
         ${sel("assignee", "p")} AS assignee,
         ${sel("due_date", "p", "timestamptz")} AS due_date,
         ${sel("estimate_url", "p")} AS estimate_url,
         ${sel("estimate_file", "p")} AS estimate_file,
         ${sel("created_at", "p", "timestamptz")} AS created_at,
         COALESCE(${sel("contacto_nombre", "p")}, ${
           hasCli ? sel("contacto_nombre", "c") : "NULL::text"
         }) AS contacto_nombre
       FROM proyectos p
       ${joinCli}
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY ${pCols.has("created_at") ? "p.created_at DESC NULLS LAST," : ""} p.id DESC`,
      params
    );

    const bucket = new Map(orderPipeline.map((k) => [k, []]));
    for (const row of rs.rows) {
      const key =
        (row.stage && pipelineSet.has(row.stage))
          ? row.stage
          : (row.categoria && pipelineSet.has(row.categoria))
            ? row.categoria
            : orderPipeline[orderPipeline.length - 1] || "Lost";

      const estimateChip = !!(row.estimate_url || row.estimate_file);
      bucket.get(key)?.push({
        id: row.id,
        cliente_id: row.cliente_id,
        cliente_nombre: row.cliente_nombre || null,
        nombre: row.nombre,
        empresa: row.cliente_nombre || null,
        email: row.email,
        telefono: row.telefono,
        stage: row.stage,
        source: row.source,
        assignee: row.assignee,
        assignee_email: row.assignee,
        due_date: row.due_date,
        estimate_url: row.estimate_url,
        estimate: estimateChip,
        created_at: row.created_at,
      });
    }

    const columns = orderPipeline.map((name) => ({
      key: name,
      title: name,
      count: bucket.get(name)?.length || 0,
      items: bucket.get(name) || [],
    }));

    res.json({ columns, order: orderPipeline });
  } catch (e) {
    console.error("[GET /kanban/proyectos]", e?.stack || e?.message || e);
    const columns = CANON_CATS.map((name) => ({ key: name, title: name, count: 0, items: [] }));
    res.status(200).json({ columns, order: CANON_CATS });
  }
});

router.patch("/proyectos/:id/move", authenticateToken, async (req, res) => {
  try {
    const { order: orderPipeline, set: pipelineSet } = await pipelineCtx(req);
    if (!(await hasTable("proyectos"))) return res.status(404).json({ message: "Tabla proyectos no existe" });
    const pCols = await tableColumns("proyectos");
    const orgId = resolveOrgId(req);

    const id = Number(req.params.id);
    let next = coerceText(req.body?.stage ?? req.body?.categoria);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });
    if (!next) return res.status(400).json({ message: "stage requerido" });
    if (!pipelineSet.has(next) && !orderPipeline.includes(next)) {
      return res.status(400).json({ message: "stage fuera del pipeline" });
    }

    const sets = [];
    const params = [next, id];
    let i = 3;

    if (pCols.has("stage")) sets.push(`stage = $1`);
    if (pCols.has("categoria")) sets.push(`categoria = $1`);
    if (pCols.has("updated_at")) sets.push(`updated_at = NOW()`);

    let where = `id = $2`;
    if (pCols.has("organizacion_id") && orgId != null) {
      params.push(orgId);
      where += ` AND organizacion_id = $${i++}`;
    }

    const r = await q(
      `UPDATE proyectos SET ${sets.join(", ")} WHERE ${where}
       RETURNING id,
         ${pCols.has("nombre") ? "nombre" : "NULL::text AS nombre"},
         ${pCols.has("stage") ? "stage" : "NULL::text AS stage"},
         ${pCols.has("categoria") ? "categoria" : "NULL::text AS categoria"}`,
      params
    );
    if (!r.rowCount) return res.status(404).json({ message: "Proyecto no encontrado" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error("[PATCH /kanban/proyectos/:id/move]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error moviendo proyecto" });
  }
});

/* ====================== Kanban de CLIENTES ===================== */
router.get("/clientes", authenticateToken, async (req, res) => {
  noStore(res);
  try {
    if (!(await hasTable("clientes"))) {
      const columns = ORDER.map((name) => ({ key: name, title: name, count: 0, items: [] }));
      return res.status(200).json({ columns, order: ORDER });
    }

    const orgId = resolveOrgId(req);
    const cCols = await tableColumns("clientes");

    const { q: qtext, source, assignee, stage, only_due } = req.query || {};
    const params = [];
    const where = [];

    if (cCols.has("organizacion_id") && orgId != null) {
      params.push(orgId);
      where.push(`c.organizacion_id = $${params.length}`);
    }
    if (stage && cCols.has("stage")) {
      params.push(String(stage));
      where.push(`c.stage = $${params.length}`);
    }
    if (source && cCols.has("source")) {
      params.push(String(source));
      where.push(`c.source = $${params.length}`);
    }
    if (assignee && cCols.has("assignee")) {
      if (/^(sin asignar|unassigned)$/i.test(String(assignee))) {
        where.push(`(c.assignee IS NULL OR TRIM(c.assignee) = '')`);
      } else {
        params.push(String(assignee));
        where.push(`c.assignee = $${params.length}`);
      }
    }
    if (isTruthy(only_due) && cCols.has("due_date")) where.push(`c.due_date IS NOT NULL`);

    if (qtext) {
      const qval = `%${String(qtext).trim()}%`;
      params.push(qval);
      const i = params.length;
      const ors = [];
      if (cCols.has("nombre")) ors.push(`c.nombre ILIKE $${i}`);
      if (cCols.has("email")) ors.push(`c.email ILIKE $${i}`);
      if (cCols.has("telefono")) ors.push(`CAST(c.telefono AS TEXT) ILIKE $${i}`);
      if (ors.length) where.push("(" + ors.join(" OR ") + ")");
    }

    const sel = (col, asType = "text") => {
      if (cCols.has(col)) return `c.${col}`;
      if (asType === "timestamptz") return "NULL::timestamptz";
      if (asType === "int") return "NULL::int";
      return "NULL::text";
    };

    const rs = await q(
      `SELECT
         ${sel("id", "int")} AS id,
         ${sel("nombre")}    AS nombre,
         CAST(${cCols.has("telefono") ? "c.telefono" : "NULL::text"} AS TEXT) AS telefono,
         ${sel("email")}     AS email,
         ${sel("stage")}     AS stage,
         ${sel("categoria")} AS categoria,
         ${sel("source")}    AS source,
         ${sel("assignee")}  AS assignee,
         ${sel("due_date", "timestamptz")} AS due_date,
         ${sel("estimate_url")}  AS estimate_url,
         ${sel("estimate_file")} AS estimate_file,
         ${sel("created_at", "timestamptz")} AS created_at
       FROM clientes c
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY ${cCols.has("created_at") ? "c.created_at DESC NULLS LAST," : ""} c.id DESC`,
      params
    );

    const bucket = new Map(ORDER.map((k) => [k, []]));
    for (const row of rs.rows) {
      const key =
        (row.stage && PIPELINE_SET.has(row.stage))
          ? row.stage
          : (row.categoria && PIPELINE_SET.has(row.categoria))
            ? row.categoria
            : ORDER[ORDER.length - 1] || "Lost";

      const estimateChip = !!(row.estimate_url || row.estimate_file);
      bucket.get(key)?.push({
        id: row.id,
        nombre: row.nombre,
        email: row.email,
        telefono: row.telefono,
        stage: row.stage,
        source: row.source,
        assignee: row.assignee,
        assignee_email: row.assignee,
        due_date: row.due_date,
        estimate_url: row.estimate_url,
        estimate: estimateChip,
        created_at: row.created_at,
      });
    }

    const columns = ORDER.map((name) => ({
      key: name,
      title: name,
      count: bucket.get(name)?.length || 0,
      items: bucket.get(name) || [],
    }));

    res.json({ columns, order: ORDER });
  } catch (e) {
    console.error("[GET /kanban/clientes]", e?.stack || e?.message || e);
    const columns = ORDER.map((name) => ({ key: name, title: name, count: 0, items: [] }));
    res.status(200).json({ columns, order: ORDER });
  }
});

router.patch("/clientes/:id/move", authenticateToken, async (req, res) => {
  try {
    if (!(await hasTable("clientes"))) return res.status(404).json({ message: "Tabla clientes no existe" });
    const cCols = await tableColumns("clientes");
    const orgId = resolveOrgId(req);

    const id = Number(req.params.id);
    let next = coerceText(req.body?.stage ?? req.body?.categoria);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });
    if (!next) return res.status(400).json({ message: "stage requerido" });
    if (!PIPELINE_SET.has(next) && !ORDER.includes(next)) {
      return res.status(400).json({ message: "stage fuera del pipeline" });
    }

    const sets = [];
    if (cCols.has("stage")) sets.push(`stage = $1`);
    if (cCols.has("categoria")) sets.push(`categoria = $1`);
    if (cCols.has("updated_at")) sets.push(`updated_at = NOW()`);

    const params = [next, id];
    let i = 3;
    let where = `id = $2`;
    if (cCols.has("organizacion_id") && orgId != null) {
      params.push(orgId);
      where += ` AND organizacion_id = $${i++}`;
    }

    const r = await q(
      `UPDATE clientes SET ${sets.join(", ")} WHERE ${where}
       RETURNING id,
         ${cCols.has("nombre") ? "nombre" : "NULL::text AS nombre"},
         ${cCols.has("stage") ? "stage" : "NULL::text AS stage"},
         ${cCols.has("categoria") ? "categoria" : "NULL::text AS categoria"}`,
      params
    );
    if (!r.rowCount) return res.status(404).json({ message: "Cliente no encontrado" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error("[PATCH /kanban/clientes/:id/move]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error moviendo cliente" });
  }
});

/* ======================= Kanban de TAREAS ====================== */
// GET compatible: devuelve items[], columns{}, lanes[]
router.get("/tareas", authenticateToken, async (req, res) => {
  noStore(res);
  try {
    if (!(await hasTable("tareas"))) {
      return res.status(200).json({
        ok: true,
        items: [],
        columns: { todo: [], doing: [], waiting: [], done: [] },
        lanes: [
          { id: "todo", title: "Por hacer", items: [] },
          { id: "doing", title: "En curso", items: [] },
          { id: "waiting", title: "En espera", items: [] },
          { id: "done", title: "Hecho", items: [] },
        ],
      });
    }

    const orgId = resolveOrgId(req);
    const tCols = await tableColumns("tareas");
    const hasClientes = await hasTable("clientes");
    const cCols = hasClientes ? await tableColumns("clientes") : new Set();

    const params = [];
    const where = [];
    if (tCols.has("organizacion_id") && orgId != null) {
      params.push(orgId);
      where.push(`t.organizacion_id = $${params.length}`);
    }

    const sel = (col, asType = "text") => {
      if (tCols.has(col)) return `t.${col}`;
      if (asType === "timestamptz") return "NULL::timestamptz";
      if (asType === "int") return "NULL::int";
      if (asType === "bool") return "FALSE::boolean";
      return "NULL::text";
    };

    const r = await q(
      `SELECT
         ${sel("id", "int")} AS id,
         ${sel("titulo")} AS titulo,
         ${sel("descripcion")} AS descripcion,
         ${
           tCols.has("estado")
             ? "t.estado"
             : tCols.has("completada")
               ? "CASE WHEN t.completada THEN 'done' ELSE 'todo' END AS estado"
               : "'todo' AS estado"
         },
         ${tCols.has("orden") ? "t.orden" : "0 AS orden"},
         ${sel("completada", "bool")} AS completada,
         ${sel("vence_en", "timestamptz")} AS vence_en,
         ${sel("created_at", "timestamptz")} AS created_at,
         ${sel("cliente_id", "int")} AS cliente_id,
         ${sel("usuario_email")} AS usuario_email,
         ${hasClientes && cCols.has("nombre") ? "c.nombre" : "NULL::text"} AS cliente_nombre
       FROM tareas t
       ${hasClientes ? "LEFT JOIN clientes c ON c.id = t.cliente_id" : ""}
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY ${tCols.has("estado") ? "t.estado ASC," : ""} ${
         tCols.has("orden") ? "t.orden ASC," : ""
       } ${tCols.has("created_at") ? "t.created_at DESC NULLS LAST," : ""} t.id DESC`,
      params
    );

    const rows = r.rows || [];

    // Plano
    const items = rows.map((row) => ({
      id: row.id,
      titulo: row.titulo,
      descripcion: row.descripcion,
      estado: row.estado || "todo",
      orden: row.orden ?? 0,
      completada: !!row.completada,
      vence_en: row.vence_en,
      created_at: row.created_at,
      cliente_id: row.cliente_id,
      cliente_nombre: row.cliente_nombre || null,
      usuario_email: row.usuario_email || null,
    }));

    // Columns + lanes
    const columns = { todo: [], doing: [], waiting: [], done: [] };
    for (const it of items) {
      const lane = columns[it.estado] ? it.estado : "todo";
      columns[lane].push(it);
    }
    const lanes = [
      { id: "todo", title: "Por hacer", items: columns.todo },
      { id: "doing", title: "En curso", items: columns.doing },
      { id: "waiting", title: "En espera", items: columns.waiting },
      { id: "done", title: "Hecho", items: columns.done },
    ];

    res.json({ ok: true, items, columns, lanes });
  } catch (e) {
    console.error("[GET /kanban/tareas]", e?.stack || e?.message || e);
    res.status(200).json({
      ok: true,
      items: [],
      columns: { todo: [], doing: [], waiting: [], done: [] },
      lanes: [
        { id: "todo", title: "Por hacer", items: [] },
        { id: "doing", title: "En curso", items: [] },
        { id: "waiting", title: "En espera", items: [] },
        { id: "done", title: "Hecho", items: [] },
      ],
    });
  }
});

router.patch("/tareas/:id/move", authenticateToken, async (req, res) => {
  try {
    if (!(await hasTable("tareas"))) return res.status(404).json({ message: "Tabla tareas no existe" });
    const tCols = await tableColumns("tareas");
    const orgId = resolveOrgId(req);

    const id = Number(req.params.id);
    let { estado, orden } = req.body || {};
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });

    const valid = ["todo", "doing", "waiting", "done"];
    if (!estado || !valid.includes(estado)) {
      return res.status(400).json({ message: "Estado inválido" });
    }

    // Si no se envía orden → al final del carril
    if (orden == null && tCols.has("orden")) {
      const p = [];
      let w = `estado = $1`;
      p.push(estado);
      if (tCols.has("organizacion_id") && orgId != null) {
        p.push(orgId);
        w += ` AND organizacion_id = $2`;
      }
      const mr = await q(`SELECT COALESCE(MAX(orden),0) AS m FROM tareas WHERE ${w}`, p);
      orden = (mr.rows?.[0]?.m ?? 0) + 1;
    } else if (orden == null) {
      orden = 0;
    }

    const sets = [];
    const params = [];
    let idx = 1;

    if (tCols.has("estado")) {
      sets.push(`estado = $${idx++}`);
      params.push(estado);
    }
    if (tCols.has("orden")) {
      sets.push(`orden = $${idx++}`);
      params.push(orden);
    }
    if (tCols.has("completada")) {
      sets.push(`completada = $${idx++}`);
      params.push(estado === "done");
    }
    if (tCols.has("updated_at")) {
      sets.push(`updated_at = NOW()`);
    }

    params.push(id);
    let where = `id = $${idx++}`;
    if (tCols.has("organizacion_id") && orgId != null) {
      params.push(orgId);
      where += ` AND organizacion_id = $${idx++}`;
    }

    // Aseguramos placeholder válido para el estado en el RETURNING cuando no hay columna 'estado'
    const estadoParamIndex = 1; // el primer placeholder (estado) ya está en params

    const returnEstadoExpr = tCols.has("estado")
      ? "estado"
      : `CASE WHEN $${estadoParamIndex}='done' THEN 'done' ELSE 'todo' END AS estado`;
    const returnOrdenExpr = tCols.has("orden") ? "orden" : "0 AS orden";
    const returnCompletadaExpr = tCols.has("completada")
      ? "completada"
      : `($${estadoParamIndex}='done') AS completada`;

    const r = await q(
      `UPDATE tareas SET ${sets.join(", ")} WHERE ${where}
       RETURNING
         id,
         ${tCols.has("titulo") ? "titulo" : "NULL::text AS titulo"},
         ${returnEstadoExpr},
         ${returnOrdenExpr},
         ${returnCompletadaExpr}`,
      params
    );
    if (!r.rowCount) return res.status(404).json({ message: "Tarea no encontrada" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error("[PATCH /kanban/tareas/:id/move]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error moviendo tarea" });
  }
});

export default router;
