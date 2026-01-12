// routes/proyectos.js — Oportunidades/Proyectos (blindado + multi-tenant + schema-agnostic, TEXT-safe)
import { Router } from "express";
import { q, CANON_CATS, pipelineForOrg } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";
import { emit as emitFlow } from "../services/flows.client.js";

const router = Router();

/* ---------------------------- helpers ---------------------------- */
const T = (v) => (v == null ? null : (String(v).trim() || null));
const N = (v) => { if (v == null || v === "") return null; const n = +v; return Number.isFinite(n) ? n : null; };
const D = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString(); };
const toInt = (v) => { const n = Number(v); return Number.isInteger(n) ? n : null; };
const getBearer = (req) => req.headers?.authorization || null;
const emailNorm = (v) => (T(v) ? String(v).trim().toLowerCase() : null);

function getOrg(req) {
  const raw =
    T(req.usuario?.organizacion_id) ||
    T(req.headers?.["x-org-id"]) ||
    T(req.organizacion_id) ||
    T(req.query?.organizacion_id) ||
    T(req.body?.organizacion_id) ||
    null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
function getUserFromReq(req) {
  const u = req.usuario || {};
  return {
    email: (u.email ?? req.usuario_email ?? u.usuario_email ?? null) || null,
    organizacion_id: getOrg(req),
  };
}
async function getPipelineForReq(req) {
  const { organizacion_id } = getUserFromReq(req);
  return pipelineForOrg(organizacion_id);
}

async function regclassExists(name) {
  try {
    const r = await q(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${name}`]);
    return !!r.rows?.[0]?.ok;
  } catch { return false; }
}
async function hasTable(name) { return regclassExists(name); }
async function tableColumns(name) {
  try {
    const r = await q(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
      [name]
    );
    return new Set((r.rows || []).map(x => x.column_name));
  } catch { return new Set(); }
}
function quoteIdent(v) {
  return `"${String(v).replace(/"/g, "\"\"")}"`;
}
async function findProjectRefs() {
  try {
    const r = await q(
      `
      SELECT
        tc.table_name AS table_name,
        kcu.column_name AS column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
        AND ccu.table_schema = 'public'
        AND ccu.table_name = 'proyectos'
      `
    );
    return r.rows || [];
  } catch {
    return [];
  }
}

// Filtro multi-tenant TEXT-safe (si la tabla tiene org_id)
function orgFilterText(cols, alias, orgId, paramIndex = 1) {
  if (!cols.has("organizacion_id")) return { where: [], params: [] };
  if (orgId == null) return { where: ["1=0"], params: [] }; // evita mezclar tenants
  return { where: [`${alias}.organizacion_id::text = $${paramIndex}::text`], params: [String(orgId)] };
}

function exp(cols, name, type) {
  return cols.has(name) ? `p.${name}` : `NULL::${type}`;
}
function orderExpr(cols) {
  if (cols.has("updated_at")) return "p.updated_at DESC NULLS LAST, p.id DESC";
  if (cols.has("created_at")) return "p.created_at DESC NULLS LAST, p.id DESC";
  return "p.id DESC";
}
async function buildProjectSelect() {
  const cols = await tableColumns("proyectos");
  const parts = [
    `${exp(cols, "id", "int")} AS id`,
    `${exp(cols, "nombre", "text")} AS nombre`,
    `${exp(cols, "descripcion", "text")} AS descripcion`,
    `${exp(cols, "descripcion", "text")} AS notas`,
    `${exp(cols, "cliente_id", "int")} AS cliente_id`,
    `${exp(cols, "stage", "text")} AS stage`,
    `${exp(cols, "categoria", "text")} AS categoria`,
    `${exp(cols, "source", "text")} AS source`,
    `${exp(cols, "assignee", "text")} AS assignee`,
    `${exp(cols, "due_date", "timestamptz")} AS due_date`,
    `${exp(cols, "estimate_url", "text")} AS estimate_url`,
    `${exp(cols, "estimate_file", "text")} AS estimate_file`,
    `${exp(cols, "estimate_amount", "numeric")} AS estimate_amount`,
    `${exp(cols, "estimate_currency", "text")} AS estimate_currency`,
    `${exp(cols, "prob_win", "numeric")} AS prob_win`,
    `${exp(cols, "fecha_cierre_estimada", "timestamptz")} AS fecha_cierre_estimada`,
    `${exp(cols, "contacto_nombre", "text")} AS contacto_nombre`,
    `${exp(cols, "usuario_email", "text")} AS usuario_email`,
    `${exp(cols, "organizacion_id", "int")} AS organizacion_id`,
    `${exp(cols, "result", "text")} AS result`,
    `${exp(cols, "closed_at", "timestamptz")} AS closed_at`,
    `${exp(cols, "created_at", "timestamptz")} AS created_at`,
    `${exp(cols, "updated_at", "timestamptz")} AS updated_at`,
  ];
  return { cols, selectSQL: `SELECT\n  ${parts.join(",\n  ")}\nFROM proyectos p`, orderBy: orderExpr(cols) };
}
function pickInsert(cols, obj) {
  const fields = [], values = [];
  for (const [k, v] of Object.entries(obj)) { if (cols.has(k)) { fields.push(k); values.push(v); } }
  return { fields, values };
}
function pickUpdate(cols, obj) {
  const sets = [], values = []; let i = 1;
  for (const [k, v] of Object.entries(obj)) {
    if (!cols.has(k)) continue;
    sets.push(`${k} = $${i++}`); values.push(v);
  }
  if (cols.has("updated_at")) sets.push(`updated_at = NOW()`);
  return { sets, values };
}

/* ============== OPTIONS (antes de :id) ============== */
router.get("/options", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id, email } = getUserFromReq(req);
    const pipeline = await getPipelineForReq(req);
    if (!(await hasTable("proyectos"))) {
      return res.json({
        ok: true,
        stages: pipeline,
        sources: ["Website","Referral","Email","WhatsApp","Phone","Instagram","Facebook","Google Ads","LinkedIn","Cold Outreach","Event","Walk-in"],
        assignees: email ? [String(email).toLowerCase()] : [],
      });
    }

    const cols = await tableColumns("proyectos");

    // sources
    let sources = [];
    if (cols.has("source")) {
      const wh = [`p.source IS NOT NULL`, `p.source <> ''`];
      const params = [];
      const of = orgFilterText(cols, "p", organizacion_id, params.length + 1);
      if (of.where.length) { wh.unshift(of.where[0]); params.push(...of.params); }
      const src = await q(`SELECT DISTINCT p.source AS v FROM proyectos p ${wh.length ? "WHERE " + wh.join(" AND ") : ""} ORDER BY 1`, params);
      sources = (src.rows || []).map(r => r.v).filter(Boolean);
    }
    const defaults = ["Website","Referral","Email","WhatsApp","Phone","Instagram","Facebook","Google Ads","LinkedIn","Cold Outreach","Event","Walk-in"];
    const sourcesSet = new Set([...defaults, ...sources]);

    // assignees
    let assignees = [];
    if (cols.has("assignee")) {
      const wha = [`p.assignee IS NOT NULL`, `p.assignee <> ''`];
      const pa = [];
      const of = orgFilterText(cols, "p", organizacion_id, pa.length + 1);
      if (of.where.length) { wha.unshift(of.where[0]); pa.push(...of.params); }
      const asg = await q(`SELECT DISTINCT p.assignee AS v FROM proyectos p ${wha.length ? "WHERE " + wha.join(" AND ") : ""} ORDER BY 1`, pa);
      assignees = (asg.rows || []).map(r => String(r.v || "").toLowerCase()).filter(Boolean);
    }
    const assigneesSet = new Set([...(email ? [String(email).toLowerCase()] : []), ...assignees]);

    res.json({ ok: true, stages: pipeline, sources: Array.from(sourcesSet), assignees: Array.from(assigneesSet) });
  } catch (e) {
    console.error("[GET /proyectos/options]", e?.stack || e?.message || e);
    res.json({ ok: true, stages: CANON_CATS, sources: [], assignees: [] });
  }
});

/* ============== GET /proyectos (lista) ============== */
router.get("/", authenticateToken, async (req, res) => {
  try {
    if (!(await hasTable("proyectos"))) return res.status(200).json({ ok: true, items: [] });

    const { organizacion_id } = getUserFromReq(req);
    const { selectSQL, orderBy, cols } = await buildProjectSelect();

    const { stage, cliente_id, q: qtext } = req.query || {};
    const source = req.query?.source ?? req.query?.origen ?? null;
    const assignee = req.query?.assignee ?? req.query?.responsable ?? null;
    const only_due = req.query?.only_due;

    let { limit = 1000, offset = 0 } = req.query || {};
    limit = Math.max(1, Math.min(2000, Number(limit) || 1000));
    offset = Math.max(0, Number(offset) || 0);

    const where = [];
    const params = [];

    // org TEXT-safe
    const of = orgFilterText(cols, "p", organizacion_id, params.length + 1);
    if (of.where.length) { where.push(of.where[0]); params.push(...of.params); }

    if (stage && (cols.has("stage") || cols.has("categoria"))) {
      params.push(String(stage));
      where.push(`${cols.has("stage") ? "p.stage" : "p.categoria"} = $${params.length}`);
    }
    if (cliente_id != null && cliente_id !== "" && cols.has("cliente_id")) {
      params.push(Number(cliente_id));
      where.push(`p.cliente_id = $${params.length}`);
    }
    if (source && cols.has("source")) { params.push(String(source)); where.push(`p.source = $${params.length}`); }
    if (assignee && cols.has("assignee")) { params.push(String(assignee)); where.push(`p.assignee = $${params.length}`); }
    if (String(only_due) === "1" && cols.has("due_date")) { where.push("p.due_date IS NOT NULL"); }

    if (qtext) {
      const qv = `%${String(qtext).trim()}%`;
      params.push(qv);
      const i = params.length;
      const parts = [`p.nombre ILIKE $${i}`];
      if (cols.has("descripcion")) parts.push(`p.descripcion ILIKE $${i}`);
      if (cols.has("contacto_nombre")) parts.push(`p.contacto_nombre ILIKE $${i}`);
      if (cols.has("assignee")) parts.push(`p.assignee ILIKE $${i}`);
      where.push(`(${parts.join(" OR ")})`);
    }

    params.push(limit, offset);
    const sql = `
      ${selectSQL}
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY ${orderBy}
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    const r = await q(sql, params);
    res.json({ ok: true, items: r.rows || [] });
  } catch (e) {
    console.error("[GET /proyectos]", e?.stack || e?.message || e);
    res.status(200).json({ ok: true, items: [] });
  }
});

/* ============== GET /proyectos/kanban (debe ir antes de :id) ============== */
router.get("/kanban", authenticateToken, async (req, res) => {
  try {
    const pipeline = await getPipelineForReq(req);
    if (!(await hasTable("proyectos"))) {
      return res.json({
        ok: true,
        order: pipeline,
        columns: pipeline.map((s) => ({ key: s, title: s, items: [], count: 0 })),
      });
    }

    const { organizacion_id } = getUserFromReq(req);
    const { selectSQL, orderBy, cols } = await buildProjectSelect();

    const { q: qtext } = req.query || {};
    const source = req.query?.source ?? req.query?.origen ?? null;
    const assignee = req.query?.assignee ?? req.query?.responsable ?? null;
    const only_due = req.query?.only_due;

    const where = [];
    const params = [];

    const of = orgFilterText(cols, "p", organizacion_id, params.length + 1);
    if (of.where.length) { where.push(of.where[0]); params.push(...of.params); }

    if (source && cols.has("source")) { params.push(String(source)); where.push(`p.source = $${params.length}`); }
    if (assignee && cols.has("assignee")) { params.push(String(assignee)); where.push(`p.assignee = $${params.length}`); }
    if (String(only_due) === "1" && cols.has("due_date")) { where.push("p.due_date IS NOT NULL"); }

    if (qtext) {
      const qv = `%${String(qtext).trim()}%`;
      params.push(qv);
      const i = params.length;
      const parts = [`p.nombre ILIKE $${i}`];
      if (cols.has("descripcion")) parts.push(`p.descripcion ILIKE $${i}`);
      if (cols.has("contacto_nombre")) parts.push(`p.contacto_nombre ILIKE $${i}`);
      if (cols.has("assignee")) parts.push(`p.assignee ILIKE $${i}`);
      where.push(`(${parts.join(" OR ")})`);
    }

    const r = await q(
      `
      ${selectSQL}
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY ${orderBy}
      LIMIT 1500
      `,
      params
    );

    const rows = r.rows || [];
    const byStage = new Map(pipeline.map((s) => [s, []]));
    const fallback = (cols.has("stage") || cols.has("categoria"))
      ? (pipeline[0] || "Incoming Leads")
      : (pipeline[pipeline.length - 1] || "Lost");

    for (const it of rows) {
      const stageVal = cols.has("stage") ? it.stage : (cols.has("categoria") ? it.categoria : null);
      const key = stageVal && pipeline.includes(stageVal) ? stageVal : fallback;
      byStage.get(key)?.push(it);
    }

    const columns = pipeline.map((s) => ({
      key: s,
      title: s,
      items: byStage.get(s),
      count: byStage.get(s).length,
    }));

    res.json({ ok: true, order: pipeline, columns });
  } catch (e) {
    console.error("[GET /proyectos/kanban]", e?.stack || e?.message || e);
    res.json({
      ok: true,
      order: CANON_CATS,
      columns: CANON_CATS.map((s) => ({ key: s, title: s, items: [], count: 0 })),
    });
  }
});

/* ============== GET /proyectos/:id ============== */
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    if (!(await hasTable("proyectos"))) return res.status(404).json({ ok: false, message: "Proyecto no encontrado" });

    const { organizacion_id } = getUserFromReq(req);
    const id = toInt(req.params.id);
    if (id == null) return res.status(400).json({ ok: false, message: "ID inválido" });

    const { selectSQL, cols } = await buildProjectSelect();

    const params = [id];
    let where = `p.id = $1`;
    const of = orgFilterText(cols, "p", organizacion_id, params.length + 1);
    if (of.where.length) { where += ` AND ${of.where[0]}`; params.push(...of.params); }

    const r = await q(`${selectSQL} WHERE ${where}`, params);
    if (!r.rowCount) return res.status(404).json({ ok: false, message: "Proyecto no encontrado" });
    res.json({ ok: true, item: r.rows[0] });
  } catch (e) {
    console.error("[GET /proyectos/:id]", e?.stack || e?.message || e);
    res.status(500).json({ ok: false, message: "Error obteniendo proyecto" });
  }
});

/* ============== POST /proyectos ============== */
router.post("/", authenticateToken, async (req, res) => {
  try {
    if (!(await hasTable("proyectos"))) return res.status(501).json({ ok: false, message: "Módulo de proyectos no instalado" });

    const bearer = getBearer(req);
    const { organizacion_id, email: usuario_email } = getUserFromReq(req);
    const cols = await tableColumns("proyectos");
    const pipeline = await getPipelineForReq(req);

    if (!("assignee" in (req.body || {})) && "responsable" in (req.body || {})) req.body.assignee = req.body.responsable;
    if (!("source" in (req.body || {})) && "origen" in (req.body || {})) req.body.source = req.body.origen;

    let {
      nombre,
      descripcion = null,
      notas = null,
      cliente_id = null,
      stage = null,
      categoria = null,
      source = null,
      assignee = null,
      due_date = null,
      estimate_url = null,
      estimate_file = null,
      estimate_amount = null,
      estimate_currency = null,
      prob_win = null,
      fecha_cierre_estimada = null,
      contacto_nombre = null,
    } = req.body || {};

    if (!nombre || !String(nombre).trim()) return res.status(400).json({ ok: false, message: "Nombre requerido" });
    if (!T(descripcion) && T(notas)) descripcion = notas;

    const stageIn = T(stage) ?? T(categoria) ?? (pipeline[0] || "Incoming Leads");
    const finalStage = pipeline.includes(stageIn) ? stageIn : (pipeline[0] || "Incoming Leads");

    const payload = {
      nombre: T(nombre),
      descripcion: T(descripcion),
      cliente_id: (cliente_id == null || cliente_id === "") ? null : Number(cliente_id),
      stage: finalStage,
      categoria: finalStage,
      source: T(source),
      assignee: emailNorm(assignee),
      due_date: D(due_date),
      estimate_url: T(estimate_url),
      estimate_file: T(estimate_file),
      estimate_amount: N(estimate_amount),
      estimate_currency: T(estimate_currency),
      prob_win: N(prob_win),
      fecha_cierre_estimada: D(fecha_cierre_estimada),
      contacto_nombre: T(contacto_nombre),
      usuario_email: emailNorm(usuario_email),
      organizacion_id: organizacion_id, // insert como número si existe la columna
    };
    if (cols.has("created_at")) payload.created_at = new Date();
    if (cols.has("updated_at")) payload.updated_at = new Date();

    const { fields, values } = pickInsert(cols, payload);
    if (!fields.length) return res.status(501).json({ ok: false, message: "Schema inválido: no hay columnas insertables" });

    const placeholders = fields.map((_, i) => `$${i + 1}`).join(",");
    const ins = await q(`INSERT INTO proyectos (${fields.join(",")}) VALUES (${placeholders}) RETURNING id`, values);
    const newId = ins.rows[0].id;

    const { selectSQL } = await buildProjectSelect();
    const item = (await q(`${selectSQL} WHERE p.id = $1`, [newId])).rows[0];

    // Emit create (best-effort)
    emitFlow(
      "crm.lead.created",
      {
        org_id: String(item.organizacion_id || ""),
        idempotency_key: `lead:${item.id}:created`,
        lead: {
          id: String(item.id),
          name: item.nombre,
          stage: item.stage,
          assignee: item.assignee ? { email: item.assignee } : null,
          client_id: item.cliente_id ? String(item.cliente_id) : null,
          estimate: item.estimate_amount
            ? { amount: Number(item.estimate_amount), currency: item.estimate_currency || null }
            : null,
        },
        meta: { source: "vex-crm", version: "v1" },
      },
      { bearer }
    ).catch((e) => console.warn("[Flows emit lead.created]", e?.message));

    res.status(201).json({ ok: true, item });
  } catch (e) {
    console.error("[POST /proyectos]", e?.stack || e?.message || e);
    res.status(500).json({ ok: false, message: "Error creando proyecto" });
  }
});

/* ============== PATCH /proyectos/:id ============== */
router.patch("/:id", authenticateToken, async (req, res) => {
  try {
    if (!(await hasTable("proyectos"))) return res.status(501).json({ ok: false, message: "Módulo de proyectos no instalado" });

    const bearer = getBearer(req);
    const { organizacion_id } = getUserFromReq(req);
    const id = toInt(req.params.id);
    if (id == null) return res.status(400).json({ ok: false, message: "ID inválido" });

    const cols = await tableColumns("proyectos");
    const pipeline = await getPipelineForReq(req);

    if (!("descripcion" in (req.body || {})) && "notas" in (req.body || {})) req.body.descripcion = req.body.notas;
    if (!("assignee" in (req.body || {})) && "responsable" in (req.body || {})) req.body.assignee = req.body.responsable;
    if (!("source" in (req.body || {})) && "origen" in (req.body || {})) req.body.source = req.body.origen;

    const incomingStage = T(req.body?.stage ?? req.body?.categoria);
    const updates = {};

    if (incomingStage) {
      if (!pipeline.includes(incomingStage)) return res.status(400).json({ ok: false, message: "stage fuera del pipeline" });
      if (cols.has("stage")) updates.stage = incomingStage;
      if (cols.has("categoria")) updates.categoria = incomingStage;
      if (!cols.has("stage") && !cols.has("categoria")) {
        return res.status(501).json({ ok: false, message: "Schema no soporta stage/categoria" });
      }
    }

    const allowed = {
      nombre: (v) => T(v),
      descripcion: (v) => T(v),
      cliente_id: (v) => (v == null || v === "" ? null : Number(v)),
      source: (v) => T(v),
      assignee: (v) => emailNorm(v),
      due_date: (v) => D(v),
      estimate_url: (v) => T(v),
      estimate_file: (v) => T(v),
      estimate_amount: (v) => N(v),
      estimate_currency: (v) => T(v),
      prob_win: (v) => N(v),
      fecha_cierre_estimada: (v) => D(v),
      contacto_nombre: (v) => T(v),
    };

    for (const [k, conv] of Object.entries(allowed)) {
      if (k in (req.body || {})) updates[k] = conv(req.body[k]);
    }

    const { sets, values } = pickUpdate(cols, updates);
    if (!sets.length) return res.status(400).json({ ok: false, message: "Nada para actualizar" });

    // WHERE TEXT-safe
    values.push(id);
    let where = `id = $${values.length}`;
    if (cols.has("organizacion_id")) {
      if (organizacion_id == null) return res.status(400).json({ ok: false, message: "organizacion_id requerido" });
      values.push(String(organizacion_id));
      where += ` AND organizacion_id::text = $${values.length}::text`;
    }

    const ret = await q(`UPDATE proyectos SET ${sets.join(", ")} WHERE ${where} RETURNING id`, values);
    if (!ret.rowCount) return res.status(404).json({ ok: false, message: "Proyecto no encontrado" });

    const { selectSQL } = await buildProjectSelect();
    const item = (await q(`${selectSQL} WHERE p.id = $1`, [id])).rows[0];

    const isClosed = (item.stage === "Won" || item.stage === "Lost");
    const evt = isClosed ? "crm.lead.closed" : "crm.lead.updated";
    emitFlow(
      evt,
      {
        org_id: String(item.organizacion_id || ""),
        idempotency_key: `lead:${item.id}:${isClosed ? "closed" : "updated"}:${Number(item.updated_at ? new Date(item.updated_at).getTime() : Date.now())}`,
        lead: {
          id: String(item.id),
          name: item.nombre,
          stage: item.stage,
          result: item.result || (item.stage === "Won" ? "won" : item.stage === "Lost" ? "lost" : null),
          closed_at: item.closed_at ? new Date(item.closed_at).toISOString() : null,
          assignee: item.assignee ? { email: item.assignee } : null,
          estimate: item.estimate_amount ? { amount: Number(item.estimate_amount), currency: item.estimate_currency || null } : null,
        },
        meta: { source: "vex-crm", version: "v1" },
      },
      { bearer }
    ).catch((e) => console.warn("[Flows emit lead.update/closed]", e?.message));

    res.json({ ok: true, item });
  } catch (e) {
    console.error("[PATCH /proyectos/:id]", e?.stack || e?.message || e);
    res.status(500).json({ ok: false, message: "Error actualizando proyecto" });
  }
});

/* ============== PATCH /proyectos/:id/stage ============== */
router.patch("/:id/stage", authenticateToken, async (req, res) => {
  try {
    if (!(await hasTable("proyectos"))) return res.status(501).json({ ok: false, message: "Módulo de proyectos no instalado" });

    const bearer = getBearer(req);
    const { organizacion_id } = getUserFromReq(req);
    const id = toInt(req.params.id);
    if (id == null) return res.status(400).json({ ok: false, message: "ID inválido" });

    const cols = await tableColumns("proyectos");
    const pipeline = await getPipelineForReq(req);
    const next = T(req.body?.stage ?? req.body?.categoria);
    if (!next) return res.status(400).json({ ok: false, message: "stage requerido" });
    if (!pipeline.includes(next)) return res.status(400).json({ ok: false, message: "stage fuera del pipeline" });
    if (!cols.has("stage") && !cols.has("categoria")) return res.status(501).json({ ok: false, message: "Schema no soporta stage/categoria" });

    const sets = [];
    const vals = [];
    if (cols.has("stage")) { sets.push(`stage = $${vals.length + 1}`); vals.push(next); }
    if (cols.has("categoria")) { sets.push(`categoria = $${vals.length + 1}`); vals.push(next); }
    if (cols.has("updated_at")) sets.push(`updated_at = NOW()`);

    // WHERE TEXT-safe
    vals.push(id);
    let where = `id = $${vals.length}`;
    if (cols.has("organizacion_id")) {
      if (organizacion_id == null) return res.status(400).json({ ok: false, message: "organizacion_id requerido" });
      vals.push(String(organizacion_id));
      where += ` AND organizacion_id::text = $${vals.length}::text`;
    }

    const r = await q(`UPDATE proyectos SET ${sets.join(", ")} WHERE ${where} RETURNING id`, vals);
    if (!r.rowCount) return res.status(404).json({ ok: false, message: "Proyecto no encontrado" });

    const { selectSQL } = await buildProjectSelect();
    const item = (await q(`${selectSQL} WHERE p.id = $1`, [id])).rows[0];
    const isClosed = item.stage === "Won" || item.stage === "Lost";

    emitFlow(
      isClosed ? "crm.lead.closed" : "crm.lead.stage_changed",
      {
        org_id: String(item.organizacion_id || ""),
        idempotency_key: `lead:${item.id}:${isClosed ? "closed" : "stage"}:${item.stage}`,
        lead: {
          id: String(item.id),
          name: item.nombre,
          stage: item.stage,
          result: item.result || (item.stage === "Won" ? "won" : item.stage === "Lost" ? "lost" : null),
          closed_at: item.closed_at ? new Date(item.closed_at).toISOString() : null,
          assignee: item.assignee ? { email: item.assignee } : null,
        },
        meta: { source: "vex-crm", version: "v1" },
      },
      { bearer }
    ).catch((e) => console.warn("[Flows emit lead.stage/closed]", e?.message));

    res.json({ ok: true, item });
  } catch (e) {
    console.error("[PATCH /proyectos/:id/stage]", e?.stack || e?.message || e);
    res.status(500).json({ ok: false, message: "Error moviendo de etapa" });
  }
});

/* ============== PATCH /proyectos/:id/estimate ============== */
router.patch("/:id/estimate", authenticateToken, async (req, res) => {
  try {
    if (!(await hasTable("proyectos"))) return res.status(501).json({ ok: false, message: "Módulo de proyectos no instalado" });

    const bearer = getBearer(req);
    const { organizacion_id } = getUserFromReq(req);
    const id = toInt(req.params.id);
    if (id == null) return res.status(400).json({ ok: false, message: "ID inválido" });

    const cols = await tableColumns("proyectos");
    if (!cols.has("estimate_amount") && !cols.has("estimate_currency")) {
      return res.status(501).json({ ok: false, message: "Schema no soporta estimate" });
    }

    const updates = {};
    if (cols.has("estimate_amount")) updates.estimate_amount = N(req.body?.amount);
    if (cols.has("estimate_currency")) updates.estimate_currency = T(req.body?.currency);

    const { sets, values } = pickUpdate(cols, updates);
    if (!sets.length) return res.status(400).json({ ok: false, message: "Nada para actualizar" });

    // WHERE TEXT-safe
    values.push(id);
    let where = `id = $${values.length}`;
    if (cols.has("organizacion_id")) {
      if (organizacion_id == null) return res.status(400).json({ ok: false, message: "organizacion_id requerido" });
      values.push(String(organizacion_id));
      where += ` AND organizacion_id::text = $${values.length}::text`;
    }

    const r = await q(`UPDATE proyectos SET ${sets.join(", ")} WHERE ${where} RETURNING id`, values);
    if (!r.rowCount) return res.status(404).json({ ok: false, message: "Proyecto no encontrado" });

    const { selectSQL } = await buildProjectSelect();
    const item = (await q(`${selectSQL} WHERE p.id = $1`, [id])).rows[0];

    emitFlow(
      "crm.lead.estimated",
      {
        org_id: String(item.organizacion_id || ""),
        idempotency_key: `lead:${item.id}:estimate:${Number(item.updated_at ? new Date(item.updated_at).getTime() : Date.now())}`,
        lead: {
          id: String(item.id),
          name: item.nombre,
          stage: item.stage,
          estimate: item.estimate_amount
            ? { amount: Number(item.estimate_amount), currency: item.estimate_currency || null }
            : null,
        },
        meta: { source: "vex-crm", version: "v1" },
      },
      { bearer }
    ).catch((e) => console.warn("[Flows emit lead.estimated]", e?.message));

    res.json({ ok: true, item });
  } catch (e) {
    console.error("[PATCH /proyectos/:id/estimate]", e?.stack || e?.message || e);
    res.status(500).json({ ok: false, message: "Error actualizando estimate" });
  }
});

/* ============== DELETE /proyectos/:id ============== */
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    if (!(await hasTable("proyectos"))) return res.status(501).json({ ok: false, message: "Módulo de proyectos no instalado" });

    const bearer = getBearer(req);
    const { organizacion_id } = getUserFromReq(req);
    const id = toInt(req.params.id);
    if (id == null) return res.status(400).json({ ok: false, message: "ID inválido" });

    const { selectSQL, cols } = await buildProjectSelect();

    // Traigo previo con guardia TEXT-safe
    const paramsPrev = [id];
    let wherePrev = `p.id=$1`;
    const of = orgFilterText(cols, "p", organizacion_id, paramsPrev.length + 1);
    if (of.where.length) { wherePrev += ` AND ${of.where[0]}`; paramsPrev.push(...of.params); }
    const prev = await q(`${selectSQL} WHERE ${wherePrev}`, paramsPrev);

    // Delete con guardia TEXT-safe
    const paramsDel = [id];
    let whereDel = `id = $1`;
    if (cols.has("organizacion_id")) {
      if (organizacion_id == null) return res.status(400).json({ ok: false, message: "organizacion_id requerido" });
      paramsDel.push(String(organizacion_id));
      whereDel += ` AND organizacion_id::text = $2::text`;
    }
    let del = await q(`DELETE FROM proyectos WHERE ${whereDel}`, paramsDel);
    if (!del.rowCount) return res.status(404).json({ ok: false, message: "Proyecto no encontrado" });

    if (prev.rowCount) {
      const p = prev.rows[0];
      emitFlow(
        "crm.lead.deleted",
        {
          org_id: String(p.organizacion_id || ""),
          idempotency_key: `lead:${p.id}:deleted`,
          lead: { id: String(p.id), name: p.nombre, stage: p.stage, assignee: p.assignee ? { email: p.assignee } : null },
          meta: { source: "vex-crm", version: "v1" },
        },
        { bearer }
      ).catch((e) => console.warn("[Flows emit lead.deleted]", e?.message));
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /proyectos/:id]", e?.stack || e?.message || e);
    if (e?.code === "23503") {
      try {
        const { organizacion_id } = getUserFromReq(req);
        const id = toInt(req.params.id);
        if (id != null) {
          const refs = await findProjectRefs();
          for (const ref of refs) {
            if (!ref?.table_name || !ref?.column_name) continue;
            const colsRef = await tableColumns(ref.table_name);
            const tableIdent = quoteIdent(ref.table_name);
            const colIdent = quoteIdent(ref.column_name);
            const params = [id];
            let where = `${colIdent} = $1`;
            if (colsRef.has("organizacion_id") && organizacion_id != null) {
              params.push(String(organizacion_id));
              where += ` AND organizacion_id::text = $2::text`;
            }
            await q(`DELETE FROM ${tableIdent} WHERE ${where}`, params);
          }
          const { cols } = await buildProjectSelect();
          const paramsDel = [id];
          let whereDel = `id = $1`;
          if (cols.has("organizacion_id")) {
            if (organizacion_id == null) return res.status(400).json({ ok: false, message: "organizacion_id requerido" });
            paramsDel.push(String(organizacion_id));
            whereDel += ` AND organizacion_id::text = $2::text`;
          }
          const retry = await q(`DELETE FROM proyectos WHERE ${whereDel}`, paramsDel);
          if (retry.rowCount) return res.json({ ok: true });
        }
      } catch (inner) {
        console.error("[DELETE /proyectos/:id] cleanup", inner?.stack || inner?.message || inner);
      }
      return res.status(409).json({ ok: false, message: "No se puede borrar: tiene datos asociados" });
    }
    if (e?.code === "22P02") {
      return res.status(400).json({ ok: false, message: "ID inválido" });
    }
    res.status(500).json({ ok: false, message: "Error eliminando proyecto" });
  }
});

export default router;
