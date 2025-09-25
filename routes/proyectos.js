// routes/proyectos.js — Oportunidades/Proyectos
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
const T = (v) => { if (v == null) return null; const s = String(v).trim(); return s.length ? s : null; };
const N = (v) => (v == null || v === "" ? null : Number(v));
const D = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString(); };

/* ============== GET /proyectos ============== */
/**
 * Filtros soportados: q (nombre/descripcion), stage, cliente_id
 * Compat con FE: orden por updated_at DESC (luego id DESC)
 */
router.get("/", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id } = getUserFromReq(req);
    const { stage, cliente_id, q: qtext } = req.query || {};

    const params = [];
    const where = [];

    if (organizacion_id) { params.push(organizacion_id); where.push(`p.organizacion_id = $${params.length}`); }
    if (stage)          { params.push(String(stage));     where.push(`p.stage = $${params.length}`); }
    if (cliente_id)     { params.push(Number(cliente_id)); where.push(`p.cliente_id = $${params.length}`); }
    if (qtext) {
      const qv = `%${String(qtext).trim()}%`;
      params.push(qv);
      const i = params.length;
      where.push(`(p.nombre ILIKE $${i} OR p.descripcion ILIKE $${i})`);
    }

    const sql = `
      SELECT
        p.id, p.nombre, p.descripcion, p.cliente_id,
        p.stage, p.categoria,
        p.source, p.assignee, p.due_date,
        p.estimate_url, p.estimate_file,
        p.estimate_amount, p.estimate_currency,
        p.prob_win, p.fecha_cierre_estimada,
        p.contacto_nombre,
        p.usuario_email, p.organizacion_id,
        p.created_at, p.updated_at
      FROM proyectos p
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY p.updated_at DESC NULLS LAST, p.id DESC
      LIMIT 1000
    `;
    const r = await q(sql, params);
    res.json({ ok: true, items: r.rows || [] });
  } catch (e) {
    console.error("[GET /proyectos]", e?.stack || e?.message || e);
    res.status(200).json({ ok: true, items: [] });
  }
});

/* ============== POST /proyectos ============== */
/**
 * Crea un proyecto (oportunidad).
 * Requeridos: nombre
 * Opcionales: descripcion, cliente_id, stage/categoria, source, assignee, due_date,
 *             estimate_url/file, estimate_amount/currency, prob_win, fecha_cierre_estimada, contacto_nombre
 */
router.post("/", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id, email: usuario_email } = getUserFromReq(req);
    let {
      nombre,
      descripcion = null,
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

    const stageIn = T(stage) ?? T(categoria) ?? "Incoming Leads";
    const finalStage = CANON_CATS.includes(stageIn) ? stageIn : "Incoming Leads";

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
       RETURNING id, nombre, descripcion, cliente_id, stage, categoria,
                 source, assignee, due_date,
                 estimate_url, estimate_file,
                 estimate_amount, estimate_currency,
                 prob_win, fecha_cierre_estimada, contacto_nombre,
                 usuario_email, organizacion_id, created_at, updated_at`,
      [
        T(nombre),
        T(descripcion),
        cliente_id == null ? null : Number(cliente_id),
        finalStage,
        finalStage,
        T(source),
        T(assignee),
        D(due_date),
        T(estimate_url),
        T(estimate_file),
        N(estimate_amount),
        T(estimate_currency),
        N(prob_win),
        D(fecha_cierre_estimada),
        T(contacto_nombre),
        usuario_email,
        organizacion_id,
      ]
    );
    res.status(201).json({ ok: true, item: r.rows[0] });
  } catch (e) {
    console.error("[POST /proyectos]", e?.stack || e?.message || e);
    res.status(500).json({ ok: false, message: "Error creando proyecto" });
  }
});

/* ============== PATCH /proyectos/:id ============== */
router.patch("/:id", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id } = getUserFromReq(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, message: "ID inválido" });

    // Si viene stage/categoria, las espejamos y validamos
    const incomingStage = T(req.body?.stage ?? req.body?.categoria);
    const sets = [];
    const values = [];
    let i = 1;

    if (incomingStage) {
      if (!CANON_CATS.includes(incomingStage)) {
        return res.status(400).json({ ok: false, message: "stage fuera del pipeline" });
      }
      sets.push(`stage = $${i++}`);
      values.push(incomingStage);
      sets.push(`categoria = $${i++}`);
      values.push(incomingStage);
    }

    // Resto de campos permitidos
    const allowed = {
      nombre: (v) => T(v),
      descripcion: (v) => T(v),
      cliente_id: (v) => (v == null || v === "" ? null : Number(v)),
      source: (v) => T(v),
      assignee: (v) => T(v),
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

    // updated_at
    sets.push(`updated_at = NOW()`);

    values.push(id);
    if (organizacion_id != null) values.push(organizacion_id);

    const r = await q(
      `
      UPDATE proyectos
         SET ${sets.join(", ")}
       WHERE id = $${i++} ${organizacion_id != null ? `AND organizacion_id = $${i}` : ""}
       RETURNING id, nombre, descripcion, cliente_id, stage, categoria,
                 source, assignee, due_date,
                 estimate_url, estimate_file,
                 estimate_amount, estimate_currency,
                 prob_win, fecha_cierre_estimada, contacto_nombre,
                 usuario_email, organizacion_id, created_at, updated_at
      `,
      values
    );
    if (!r.rowCount) return res.status(404).json({ ok: false, message: "Proyecto no encontrado" });
    res.json({ ok: true, item: r.rows[0] });
  } catch (e) {
    console.error("[PATCH /proyectos/:id]", e?.stack || e?.message || e);
    res.status(500).json({ ok: false, message: "Error actualizando proyecto" });
  }
});

/* ============== PATCH /proyectos/:id/stage ============== */
/**
 * Body: { stage }  (acepta "categoria" por compat)
 * Espeja stage <-> categoria, con guardia por organización.
 */
router.patch("/:id/stage", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id } = getUserFromReq(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, message: "ID inválido" });

    const next = T(req.body?.stage ?? req.body?.categoria);
    if (!next) return res.status(400).json({ ok: false, message: "stage requerido" });
    if (!CANON_CATS.includes(next)) return res.status(400).json({ ok: false, message: "stage fuera del pipeline" });

    const r = await q(
      `UPDATE proyectos
          SET stage=$1, categoria=$1, updated_at=NOW()
        WHERE id=$2 ${organizacion_id != null ? "AND organizacion_id = $3" : ""}
        RETURNING id, nombre, descripcion, cliente_id, stage, categoria,
                  source, assignee, due_date,
                  estimate_url, estimate_file,
                  estimate_amount, estimate_currency,
                  prob_win, fecha_cierre_estimada, contacto_nombre,
                  usuario_email, organizacion_id, created_at, updated_at`,
      organizacion_id != null ? [next, id, organizacion_id] : [next, id]
    );
    if (!r.rowCount) return res.status(404).json({ ok: false, message: "Proyecto no encontrado" });
    res.json({ ok: true, item: r.rows[0] });
  } catch (e) {
    console.error("[PATCH /proyectos/:id/stage]", e?.stack || e?.message || e);
    res.status(500).json({ ok: false, message: "Error moviendo de etapa" });
  }
});

/* ============== PATCH /proyectos/:id/estimate ============== */
/**
 * Body: { amount, currency }
 */
router.patch("/:id/estimate", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id } = getUserFromReq(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, message: "ID inválido" });

    const amount = N(req.body?.amount);
    const currency = T(req.body?.currency);

    const r = await q(
      `UPDATE proyectos
          SET estimate_amount=$1, estimate_currency=$2, updated_at=NOW()
        WHERE id=$3 ${organizacion_id != null ? "AND organizacion_id = $4" : ""}
        RETURNING id, nombre, descripcion, cliente_id, stage, categoria,
                  source, assignee, due_date,
                  estimate_url, estimate_file,
                  estimate_amount, estimate_currency,
                  prob_win, fecha_cierre_estimada, contacto_nombre,
                  usuario_email, organizacion_id, created_at, updated_at`,
      organizacion_id != null ? [amount, currency, id, organizacion_id] : [amount, currency, id]
    );
    if (!r.rowCount) return res.status(404).json({ ok: false, message: "Proyecto no encontrado" });
    res.json({ ok: true, item: r.rows[0] });
  } catch (e) {
    console.error("[PATCH /proyectos/:id/estimate]", e?.stack || e?.message || e);
    res.status(500).json({ ok: false, message: "Error actualizando estimate" });
  }
});

/* ============== DELETE /proyectos/:id ============== */
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id } = getUserFromReq(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, message: "ID inválido" });

    const r = await q(
      `DELETE FROM proyectos WHERE id = $1 ${organizacion_id != null ? "AND organizacion_id = $2" : ""}`,
      organizacion_id != null ? [id, organizacion_id] : [id]
    );
    if (!r.rowCount) return res.status(404).json({ ok: false, message: "Proyecto no encontrado" });
    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /proyectos/:id]", e?.stack || e?.message || e);
    res.status(500).json({ ok: false, message: "Error eliminando proyecto" });
  }
});

export default router;
