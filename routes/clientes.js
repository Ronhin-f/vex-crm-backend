// routes/clientes.js — CRUD simple de clientes (sin stages)
import { Router } from "express";
import { q } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";

const router = Router();

function getUserFromReq(req) {
  const u = req.usuario || {};
  return {
    email: u.email ?? req.usuario_email ?? u.usuario_email ?? null,
    organizacion_id: u.organizacion_id ?? req.organizacion_id ?? u.organization_id ?? null,
  };
}
const T = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
};

/* ============== GET ============== */
router.get("/", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id } = getUserFromReq(req);
    const { q: qtext } = req.query || {};
    const params = [];
    const where = [];

    if (organizacion_id) { params.push(organizacion_id); where.push(`organizacion_id = $${params.length}`); }
    if (qtext) {
      const qv = `%${String(qtext).trim()}%`;
      params.push(qv);
      const i = params.length;
      where.push(`(nombre ILIKE $${i} OR email ILIKE $${i} OR CAST(telefono AS TEXT) ILIKE $${i})`);
    }

    const r = await q(
      `SELECT id, nombre, contacto_nombre, email, telefono, direccion, observacion,
              usuario_email, organizacion_id, created_at
         FROM clientes
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY created_at DESC NULLS LAST, id DESC`,
      params
    );
    res.json(r.rows || []);
  } catch (e) {
    console.error("[GET /clientes]", e?.stack || e?.message || e);
    res.status(200).json([]);
  }
});

/* ============== POST ============== */
router.post("/", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id, email: usuario_email } = getUserFromReq(req);
    let { nombre, contacto_nombre, email, telefono, direccion, observacion } = req.body || {};
    if (!nombre || !String(nombre).trim()) return res.status(400).json({ message: "Nombre requerido" });

    const r = await q(
      `INSERT INTO clientes
        (nombre, contacto_nombre, email, telefono, direccion, observacion, usuario_email, organizacion_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, nombre, contacto_nombre, email, telefono, direccion, observacion,
                 usuario_email, organizacion_id, created_at`,
      [String(nombre).trim(), T(contacto_nombre), T(email), T(telefono), T(direccion), T(observacion), usuario_email, organizacion_id]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error("[POST /clientes]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error creando cliente" });
  }
});

/* ============== PATCH ============== */
router.patch("/:id", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });

    const allowed = ["nombre","contacto_nombre","email","telefono","direccion","observacion"];
    const fields = []; const values = []; let i = 1;
    for (const k of allowed) if (k in req.body) { fields.push(`${k}=$${i++}`); values.push(T(req.body[k])); }
    if (!fields.length) return res.status(400).json({ message: "Nada para actualizar" });
    values.push(id);

    const r = await q(
      `UPDATE clientes SET ${fields.join(", ")} WHERE id=$${i}
       RETURNING id, nombre, contacto_nombre, email, telefono, direccion, observacion,
                 usuario_email, organizacion_id, created_at`,
      values
    );
    if (!r.rowCount) return res.status(404).json({ message: "Cliente no encontrado" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error("[PATCH /clientes/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error actualizando cliente" });
  }
});

/* ============== DELETE ============== */
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });

    // Bloquea si tiene proyectos asociados
    const rProj = await q(`SELECT 1 FROM proyectos WHERE cliente_id = $1 LIMIT 1`, [id]);
    if (rProj.rowCount) {
      return res.status(409).json({ message: "No se puede borrar: tiene proyectos asociados" });
    }

    const r = await q(`DELETE FROM clientes WHERE id = $1`, [id]);
    if (!r.rowCount) return res.status(404).json({ message: "Cliente no encontrado" });

    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /clientes/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error eliminando cliente" });
  }
});

export default router;
