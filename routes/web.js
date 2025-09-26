// routes/web.js
import { Router } from "express";
import { q } from "../utils/db.js";
import { ensureFollowupForAssignment } from "../services/followups.service.js";

const router = Router();

/**
 * POST /web/leads
 * Body: { email, nombre, telefono, nota, source='web', organizacion_id, asignado_email, cliente_id, link }
 */
router.post("/leads", async (req, res) => {
  try {
    const {
      email,
      nombre,
      telefono,
      nota,
      source = "web",
      organizacion_id,
      asignado_email,
      cliente_id,
      link,
    } = req.body;

    if (!organizacion_id) return res.status(400).json({ ok: false, error: "organizacion_id requerido" });
    if (!nombre) return res.status(400).json({ ok: false, error: "nombre requerido" });

    // 1) Lead “rápido” (acá uso proyectos; si tu lead real está en otra tabla, ajustamos)
    const { rows } = await q(
      `INSERT INTO proyectos (nombre, cliente_id, stage, usuario_email, organizacion_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [nombre, cliente_id || null, 'Incoming Leads', asignado_email || null, organizacion_id]
    );
    const leadId = rows[0].id;

    // 2) Follow-up + recordatorio + Slack
    await ensureFollowupForAssignment({
      organizacion_id,
      leadId,
      leadNombre: nombre,
      cliente_id: cliente_id || null,
      asignado_email: asignado_email || null,
      link: link || `https://tu-frontend/proyectos/${leadId}`,
    });

    res.json({ ok: true, leadId });
  } catch (e) {
    console.error("POST /web/leads error:", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

export default router;
