// routes/recordatorios.js
import { Router } from "express";
import { q } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";

const router = Router();

function getOrg(req) {
  return (req.usuario?.organizacion_id ?? req.organizacion_id) || null;
}

// Listar (filtro por estado opcional)
router.get("/", authenticateToken, async (req, res) => {
  try {
    const org = getOrg(req);
    const estado = req.query?.estado ? String(req.query.estado) : null;
    const params = [org];
    let sql = "SELECT * FROM recordatorios WHERE organizacion_id = $1";
    if (estado) { params.push(estado); sql += ` AND estado = $${params.length}`; }
    sql += " ORDER BY enviar_en ASC";
    const r = await q(sql, params);
    res.json(r.rows || []);
  } catch (e) {
    console.error("[GET /recordatorios]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error al obtener recordatorios" });
  }
});

// Crear
router.post("/", authenticateToken, async (req, res) => {
  try {
    const org = getOrg(req);
    const { titulo, mensaje, enviar_en, cliente_id = null, tarea_id = null } = req.body || {};
    if (!titulo?.trim() || !mensaje?.trim() || !enviar_en) {
      return res.status(400).json({ message: "Campos requeridos: titulo, mensaje, enviar_en" });
    }
    const ins = await q(
      `INSERT INTO recordatorios (organizacion_id, titulo, mensaje, enviar_en, cliente_id, tarea_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id`,
      [org, titulo.trim(), mensaje.trim(), new Date(enviar_en).toISOString(), cliente_id, tarea_id]
    );
    res.status(201).json({ id: ins.rows[0].id });
  } catch (e) {
    console.error("[POST /recordatorios]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error al crear recordatorio" });
  }
});

// Eliminar
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const org = getOrg(req);
    const id = Number(req.params.id);
    await q(`DELETE FROM recordatorios WHERE id=$1 AND organizacion_id=$2`, [id, org]);
    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /recordatorios/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error al eliminar recordatorio" });
  }
});

export default router;
