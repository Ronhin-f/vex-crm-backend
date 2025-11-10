// routes/proyectos.js — Oportunidades/Proyectos
import { Router } from "express";
import { q, CANON_CATS } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";
import { emit as emitFlow } from "../services/flows.client.js";

const router = Router();

/* ---------------------------- helpers ---------------------------- */
const T = (v) => (v == null ? null : String(v).trim() || null);
const N = (v) => (v == null || v === "" ? null : Number(v));
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

// Selección estándar (incluye alias "notas" para compat FE)
const SELECT_PROJECT = `
  SELECT
    p.id, p.nombre,
    p.descripcion,
    p.descripcion AS notas,             -- alias de compatibilidad
    p.cliente_id,
    p.stage, p.categoria,
    p.source, p.assignee, p.due_date,
    p.estimate_url, p.estimate_file,
    p.estimate_amount, p.estimate_currency,
    p.prob_win, p.fecha_cierre_estimada,
    p.contacto_nombre,
    p.usuario_email, p.organizacion_id,
    p.result, p.closed_at,
    p.created_at, p.updated_at
  FROM proyectos p
`;

/* ============== OPTIONS para dropdowns (antes de :id) ============== */
/**
 * GET /proyectos/options
 * Devuelve { stages, sources, assignees }
 */
router.get("/options", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id, email } = getUserFromReq(req);

    // Distinct sources
    const srcConds = [`p.source IS NOT NULL`, `p.source <> ''`];
    const srcParams = [];
    if (organizacion_id != null) { srcParams.push(organizacion_id); srcConds.unshift(`p.organizacion_id = $${srcParams.length}`); }
    const srcSQL = `
      SELECT DISTINCT p.source AS v
      FROM proyectos p
      ${srcConds.length ? "WHERE " + srcConds.join(" AND ") : ""}
      ORDER BY 1
    `;
    const srcQ = await q(srcSQL, srcParams);
    const dbSources = (srcQ.rows || []).map(r => r.v).filter(Boolean);

    // Distinct assignees
    const asgConds = [`p.assignee IS NOT NULL`, `p.assignee <> ''`];
    const asgParams = [];
    if (organizacion_id != null) { asgParams.push(organizacion_id); asgConds.unshift(`p.organizacion_id = $${asgParams.length}`); }
    const asgSQL = `
      SELECT DISTINCT p.assignee AS v
      FROM proyectos p
      ${asgConds.length ? "WHERE " + asgConds.join(" AND ") : ""}
      ORDER BY 1
    `;
    const asgQ = await q(asgSQL, asgParams);
    const dbAssignees = (asgQ.rows || []).map(r => String(r.v).toLowerCase()).filter(Boolean);

    const defaultSources = [
      "Website","Referral","Email","WhatsApp","Phone",
      "Instagram","Facebook","Google Ads","LinkedIn","Cold Outreach","Event","Walk-in"
    ];

    const sourcesSet = new Set([...defaultSources, ...dbSources]);
    const assigneesSet = new Set([...(email ? [String(email).toLowerCase()] : []), ...dbAssignees]);

    res.json({
      ok: true,
      stages: CANON_CATS,
      sources: Array.from(sourcesSet),
      assignees: Array.from(assigneesSet),
    });
  } catch (e) {
    console.error("[GET /proyectos/options]", e?.stack || e?.message || e);
    res.json({ ok: true, stages: CANON_CATS, sources: [], assignees: [] });
  }
});

/* ============== GET /proyectos ============== */
/**
 * Filtros: q (nombre/descripcion), stage, cliente_id, source, assignee, only_due(=1)
 * Orden: updated_at DESC, id DESC
 * Extras: limit, offset
 */
router.get("/", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id } = getUserFromReq(req);
    const { stage, cliente_id, q: qtext } = req.query || {};
    // alias en filtros
    const source = req.query?.source ?? req.query?.origen ?? null;
    const assignee = req.query?.assignee ?? req.query?.responsable ?? null;
    const only_due = req.query?.only_due;

    let { limit = 1000, offset = 0 } = req.query || {};

    const params = [];
    const where = [];

    if (organizacion_id != null) { params.push(organizacion_id); where.push(`p.organizacion_id = $${params.length}`); }
    if (stage)          { params.push(String(stage));     where.push(`p.stage = $${params.length}`); }
    if (cliente_id != null && cliente_id !== "") { params.push(Number(cliente_id)); where.push(`p.cliente_id = $${params.length}`); }
    if (source)         { params.push(String(source));     where.push(`p.source = $${params.length}`); }
    if (assignee)       { params.push(String(assignee));   where.push(`p.assignee = $${params.length}`); }
    if (String(only_due) === "1") { where.push("p.due_date IS NOT NULL"); }

    if (qtext) {
      const qv = `%${String(qtext).trim()}%`;
      params.push(qv);
      const i = params.length;
      where.push(`(p.nombre ILIKE $${i} OR p.descripcion ILIKE $${i})`);
    }

    limit = Math.max(1, Math.min(2000, Number(limit) || 1000));
    offset = Math.max(0, Number(offset) || 0);
    params.push(limit, offset);

    const sql = `
      ${SELECT_PROJECT}
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY p.updated_at DESC NULLS LAST, p.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    const r = await q(sql, params);
    res.json({ ok: true, items: r.rows || [] });
  } catch (e) {
    console.error("[GET /proyectos]", e?.stack || e?.message || e);
    res.status(200).json({ ok: true, items: [] }); // no romper FE
  }
});

/* ============== GET /proyectos/:id ============== */
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id } = getUserFromReq(req);
    const id = toInt(req.params.id);
    if (id == null) return res.status(400).json({ ok: false, message: "ID inválido" });

    const r = await q(
      `
      ${SELECT_PROJECT}
      WHERE p.id = $1
        AND ($2::int IS NULL OR p.organizacion_id = $2)
      `,
      [id, organizacion_id]
    );
    if (!r.rowCount) return res.status(404).json({ ok: false, message: "Proyecto no encontrado" });
    res.json({ ok: true, item: r.rows[0] });
  } catch (e) {
    console.error("[GET /proyectos/:id]", e?.stack || e?.message || e);
    res.status(500).json({ ok: false, message: "Error obteniendo proyecto" });
  }
});

/* ============== GET /proyectos/kanban ============== */
// (Se quitó el app.use inválido)
router.get("/kanban", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id } = getUserFromReq(req);
    const { q: qtext } = req.query || {};
    const source = req.query?.source ?? req.query?.origen ?? null;
    const assignee = req.query?.assignee ?? req.query?.responsable ?? null;
    const only_due = req.query?.only_due;

    const params = [];
    const where = [];

    if (organizacion_id != null) { params.push(organizacion_id); where.push(`p.organizacion_id = $${params.length}`); }
    if (source)          { params.push(String(source));   where.push(`p.source = $${params.length}`); }
    if (assignee)        { params.push(String(assignee)); where.push(`p.assignee = $${params.length}`); }
    if (String(only_due) === "1") { where.push("p.due_date IS NOT NULL"); }

    if (qtext) {
      const qv = `%${String(qtext).trim()}%`;
      params.push(qv);
      const i = params.length;
      where.push(`(p.nombre ILIKE $${i} OR p.descripcion ILIKE $${i})`);
    }

    const sql = `
      ${SELECT_PROJECT}
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY p.updated_at DESC NULLS LAST, p.id DESC
      LIMIT 1500
    `;
    const r = await q(sql, params);
    const rows = r.rows || [];

    const byStage = new Map(CANON_CATS.map((s) => [s, []]));
    const fallback = CANON_CATS[0] || "Incoming Leads";
    for (const it of rows) {
      const key = CANON_CATS.includes(it.stage) ? it.stage : fallback;
      byStage.get(key).push(it);
    }
    const columns = CANON_CATS.map((s) => ({
      key: s,
      title: s,
      items: byStage.get(s),
      count: byStage.get(s).length,
    }));

    res.json({ ok: true, order: CANON_CATS, columns });
  } catch (e) {
    console.error("[GET /proyectos/kanban]", e?.stack || e?.message || e);
    res.json({ ok: true, order: CANON_CATS, columns: CANON_CATS.map((s) => ({ key: s, title: s, items: [], count: 0 })) });
  }
});

/* ============== POST /proyectos ============== */
router.post("/", authenticateToken, async (req, res) => {
  try {
    const bearer = getBearer(req);
    const { organizacion_id, email: usuario_email } = getUserFromReq(req);

    // alias español → campos internos
    if (!("assignee" in (req.body || {})) && "responsable" in (req.body || {})) {
      req.body.assignee = req.body.responsable;
    }
    if (!("source" in (req.body || {})) && "origen" in (req.body || {})) {
      req.body.source = req.body.origen;
    }

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

    if (!nombre || !String(nombre).trim()) {
      return res.status(400).json({ ok: false, message: "Nombre requerido" });
    }

    if (!T(descripcion) && T(notas)) descripcion = notas;

    const stageIn = T(stage) ?? T(categoria) ?? (CANON_CATS[0] || "Incoming Leads");
    const finalStage = CANON_CATS.includes(stageIn) ? stageIn : (CANON_CATS[0] || "Incoming Leads");

    const r = await q(
      `INSERT INTO proyectos
        (nombre, descripcion, cliente_id, stage, categoria,
         source, assignee, due_date,
         estimate_url, estimate_file,
         estimate_amount, estimate_currency,
         prob_win, fecha_cierre_estimada, contacto_nombre,
         usuario_email, organizacion_id)
       VALUES
        ($1,$2,$3,$4,$5,
         $6,$7,$8,
         $9,$10,
         $11,$12,
         $13,$14,$15,
         $16,$17)
       RETURNING
         id, nombre, descripcion, descripcion AS notas, cliente_id, stage, categoria,
         source, assignee, due_date,
         estimate_url, estimate_file,
         estimate_amount, estimate_currency,
         prob_win, fecha_cierre_estimada, contacto_nombre,
         usuario_email, organizacion_id, result, closed_at, created_at, updated_at`,
      [
        T(nombre),
        T(descripcion),
        cliente_id == null || cliente_id === "" ? null : Number(cliente_id),
        finalStage,
        finalStage,
        T(source),
        emailNorm(assignee),
        D(due_date),
        T(estimate_url),
        T(estimate_file),
        N(estimate_amount),
        T(estimate_currency),
        N(prob_win),
        D(fecha_cierre_estimada),
        T(contacto_nombre),
        emailNorm(usuario_email),
        organizacion_id,
      ]
    );
    const item = r.rows[0];

    // Emit create
    emitFlow(
      "crm.lead.created",
      {
        org_id: String(organizacion_id || ""),
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
    const bearer = getBearer(req);
    const { organizacion_id } = getUserFromReq(req);
    const id = toInt(req.params.id);
    if (id == null) return res.status(400).json({ ok: false, message: "ID inválido" });

    // alias español → internos
    if (!("descripcion" in (req.body || {})) && "notas" in (req.body || {})) {
      req.body.descripcion = req.body.notas;
    }
    if (!("assignee" in (req.body || {})) && "responsable" in (req.body || {})) {
      req.body.assignee = req.body.responsable;
    }
    if (!("source" in (req.body || {})) && "origen" in (req.body || {})) {
      req.body.source = req.body.origen;
    }

    // Si viene stage/categoria, las espejamos y validamos
    const incomingStage = T(req.body?.stage ?? req.body?.categoria);
    const sets = [];
    const values = [];
    let i = 1;

    if (incomingStage) {
      if (!CANON_CATS.includes(incomingStage)) {
        return res.status(400).json({ ok: false, message: "stage fuera del pipeline" });
      }
      sets.push(`stage = $${i++}`); values.push(incomingStage);
      sets.push(`categoria = $${i++}`); values.push(incomingStage);
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

    for (const k of Object.keys(allowed)) {
      if (k in (req.body || {})) {
        const conv = allowed[k](req.body[k]);
        sets.push(`${k} = $${i++}`);
        values.push(conv);
      }
    }

    if (!sets.length) return res.status(400).json({ ok: false, message: "Nada para actualizar" });
    sets.push(`updated_at = NOW()`);

    values.push(id);
    if (organizacion_id != null) values.push(organizacion_id);

    const r = await q(
      `
      UPDATE proyectos
         SET ${sets.join(", ")}
       WHERE id = $${i++} ${organizacion_id != null ? `AND organizacion_id = $${i}` : ""}
       RETURNING
         id, nombre, descripcion, descripcion AS notas, cliente_id, stage, categoria,
         source, assignee, due_date,
         estimate_url, estimate_file,
         estimate_amount, estimate_currency,
         prob_win, fecha_cierre_estimada, contacto_nombre,
         usuario_email, organizacion_id, result, closed_at, created_at, updated_at
      `,
      values
    );
    if (!r.rowCount) return res.status(404).json({ ok: false, message: "Proyecto no encontrado" });

    const item = r.rows[0];

    // Emit update / closed si corresponde
    const isClosed = item.stage === "Won" || item.stage === "Lost";
    const evt = isClosed ? "crm.lead.closed" : "crm.lead.updated";
    emitFlow(
      evt,
      {
        org_id: String(organizacion_id || ""),
        idempotency_key: `lead:${item.id}:${isClosed ? "closed" : "updated"}:${Number(item.updated_at ? new Date(item.updated_at).getTime() : Date.now())}`,
        lead: {
          id: String(item.id),
          name: item.nombre,
          stage: item.stage,
          result: item.result || (item.stage === "Won" ? "won" : item.stage === "Lost" ? "lost" : null),
          closed_at: item.closed_at ? new Date(item.closed_at).toISOString() : null,
          assignee: item.assignee ? { email: item.assignee } : null,
          estimate: item.estimate_amount
            ? { amount: Number(item.estimate_amount), currency: item.estimate_currency || null }
            : null,
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
    const bearer = getBearer(req);
    const { organizacion_id } = getUserFromReq(req);
    const id = toInt(req.params.id);
    if (id == null) return res.status(400).json({ ok: false, message: "ID inválido" });

    const next = T(req.body?.stage ?? req.body?.categoria);
    if (!next) return res.status(400).json({ ok: false, message: "stage requerido" });
    if (!CANON_CATS.includes(next)) return res.status(400).json({ ok: false, message: "stage fuera del pipeline" });

    const r = await q(
      `UPDATE proyectos
          SET stage=$1, categoria=$1, updated_at=NOW()
        WHERE id=$2 ${organizacion_id != null ? "AND organizacion_id = $3" : ""}
        RETURNING
          id, nombre, descripcion, descripcion AS notas, cliente_id, stage, categoria,
          source, assignee, due_date,
          estimate_url, estimate_file,
          estimate_amount, estimate_currency,
          prob_win, fecha_cierre_estimada, contacto_nombre,
          usuario_email, organizacion_id, result, closed_at, created_at, updated_at`,
      organizacion_id != null ? [next, id, organizacion_id] : [next, id]
    );
    if (!r.rowCount) return res.status(404).json({ ok: false, message: "Proyecto no encontrado" });

    const item = r.rows[0];
    const isClosed = item.stage === "Won" || item.stage === "Lost";

    emitFlow(
      isClosed ? "crm.lead.closed" : "crm.lead.stage_changed",
      {
        org_id: String(organizacion_id || ""),
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
    const bearer = getBearer(req);
    const { organizacion_id } = getUserFromReq(req);
    const id = toInt(req.params.id);
    if (id == null) return res.status(400).json({ ok: false, message: "ID inválido" });

    const amount = N(req.body?.amount);
    const currency = T(req.body?.currency);

    const r = await q(
      `UPDATE proyectos
          SET estimate_amount=$1, estimate_currency=$2, updated_at=NOW()
        WHERE id=$3 ${organizacion_id != null ? "AND organizacion_id = $4" : ""}
        RETURNING
          id, nombre, descripcion, descripcion AS notas, cliente_id, stage, categoria,
          source, assignee, due_date,
          estimate_url, estimate_file,
          estimate_amount, estimate_currency,
          prob_win, fecha_cierre_estimada, contacto_nombre,
          usuario_email, organizacion_id, result, closed_at, created_at, updated_at`,
      organizacion_id != null ? [amount, currency, id, organizacion_id] : [amount, currency, id]
    );
    if (!r.rowCount) return res.status(404).json({ ok: false, message: "Proyecto no encontrado" });

    const item = r.rows[0];

    emitFlow(
      "crm.lead.estimated",
      {
        org_id: String(organizacion_id || ""),
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
    const bearer = getBearer(req);
    const { organizacion_id } = getUserFromReq(req);
    const id = toInt(req.params.id);
    if (id == null) return res.status(400).json({ ok: false, message: "ID inválido" });

    // Tomar datos para emitir antes de borrar
    const prev = await q(
      `
      ${SELECT_PROJECT}
      WHERE p.id=$1
        AND ($2::int IS NULL OR p.organizacion_id = $2)
      `,
      [id, organizacion_id]
    );

    const r = await q(
      `DELETE FROM proyectos
        WHERE id = $1 ${organizacion_id != null ? "AND organizacion_id = $2" : ""}`,
      organizacion_id != null ? [id, organizacion_id] : [id]
    );
    if (!r.rowCount) return res.status(404).json({ ok: false, message: "Proyecto no encontrado" });

    if (prev.rowCount) {
      const p = prev.rows[0];
      emitFlow(
        "crm.lead.deleted",
        {
          org_id: String(p.organizacion_id || ""),
          idempotency_key: `lead:${p.id}:deleted`,
          lead: {
            id: String(p.id),
            name: p.nombre,
            stage: p.stage,
            assignee: p.assignee ? { email: p.assignee } : null,
          },
          meta: { source: "vex-crm", version: "v1" },
        },
        { bearer }
      ).catch((e) => console.warn("[Flows emit lead.deleted]", e?.message));
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /proyectos/:id]", e?.stack || e?.message || e);
    res.status(500).json({ ok: false, message: "Error eliminando proyecto" });
  }
});

export default router;
