// routes/proveedores.js — Proveedores/Subcontratistas
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
const T = (v) => { if (v == null) return null; const s = String(v).trim(); return s.length ? s : null; };

/* ============== GET ============== */
router.get("/", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id } = getUserFromReq(req);
    const { tipo, q: qtext } = req.query || {};
    const params = []; const where = [];

    if (organizacion_id) { params.push(organizacion_id); where.push(`organizacion_id = $${params.length}`); }
    if (tipo)            { params.push(String(tipo));     where.push(`tipo = $${params.length}`); }
    if (qtext) {
      const qv = `%${String(qtext).trim()}%`;
      params.push(qv);
      const i = params.length;
      where.push(`(nombre ILIKE $${i} OR email ILIKE $${i} OR CAST(telefono AS TEXT) ILIKE $${i})`);
    }

    const r = await q(
      `SELECT id, nombre, tipo, email, telefono, direccion, notas,
              usuario_email, organizacion_id, created_at, updated_at
         FROM proveedores
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY created_at DESC NULLS LAST, id DESC`,
      params
    );
    res.json(r.rows || []);
  } catch (e) {
    console.error("[GET /proveedores]", e?.stack || e?.message || e);
    res.status(200).json([]);
  }
});

/* ============== POST ============== */
router.post("/", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id, email: usuario_email } = getUserFromReq(req);
    let { nombre, tipo, email, telefono, direccion, notas } = req.body || {};
    if (!nombre || !String(nombre).trim()) return res.status(400).json({ message: "Nombre requerido" });
    if (!tipo || !["proveedor","subcontratista"].includes(String(tipo)))
      return res.status(400).json({ message: "tipo requerido: proveedor | subcontratista" });

    const r = await q(
      `INSERT INTO proveedores
        (nombre, tipo, email, telefono, direccion, notas, usuario_email, organizacion_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, nombre, tipo, email, telefono, direccion, notas,
                 usuario_email, organizacion_id, created_at, updated_at`,
      [String(nombre).trim(), String(tipo), T(email), T(telefono), T(direccion), T(notas), usuario_email, organizacion_id]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error("[POST /proveedores]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error creando proveedor" });
  }
});

/* ============== PATCH ============== */
router.patch("/:id", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });

    const allowed = ["nombre","tipo","email","telefono","direccion","notas"];
    const fields = []; const values = []; let i = 1;
    for (const k of allowed) if (k in req.body) {
      let v = T(req.body[k]);
      if (k === "tipo" && v && !["proveedor","subcontratista"].includes(v))
        return res.status(400).json({ message: "tipo inválido" });
      fields.push(`${k}=$${i++}`); values.push(v);
    }
    if (!fields.length) return res.status(400).json({ message: "Nada para actualizar" });

    fields.push(`updated_at = NOW()`);
    values.push(id);

    const r = await q(
      `UPDATE proveedores SET ${fields.join(", ")} WHERE id=$${i}
       RETURNING id, nombre, tipo, email, telefono, direccion, notas,
                 usuario_email, organizacion_id, created_at, updated_at`,
      values
    );
    if (!r.rowCount) return res.status(404).json({ message: "Proveedor no encontrado" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error("[PATCH /proveedores/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error actualizando proveedor" });
  }
});

/* ============== DELETE ============== */
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });

    const r = await q(`DELETE FROM proveedores WHERE id=$1`, [id]);
    if (!r.rowCount) return res.status(404).json({ message: "Proveedor no encontrado" });
    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /proveedores/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error eliminando proveedor" });
  }
});

export default router;
