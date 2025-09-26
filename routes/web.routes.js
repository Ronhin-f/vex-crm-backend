// routes/web.routes.js
import { Router } from "express";
import { pool } from "../utils/db.js";
import { ensureFollowupForAssignment } from "../services/followups.service.js";

const r = Router();

/**
 * POST /web/leads
 * Body: { email, nombre, telefono, nota, source='web', org_id, asignado_email, cliente_id, link }
 */
r.post("/leads", async (req, res) => {
  try {
    const {
      email,
      nombre,
      telefono,
      nota,
      source = "web",
      org_id,
      asignado_email,
      cliente_id,
      link,
    } = req.body;

    if (!org_id) return res.status(400).json({ ok: false, error: "org_id requerido" });
    if (!nombre) return res.status(400).json({ ok: false, error: "nombre requerido" });

    // 1) crear lead (ajustá a tu esquema real)
    const { rows } = await pool.query(
      `INSERT INTO leads (org_id, nombre, email, telefono, nota, source, asignado_email, estado)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'incoming')
       RETURNING id`,
      [org_id, nombre, email || null, telefono || null, nota || null, source, asignado_email || null]
    );
    const leadId = rows[0].id;

    // 2) follow-up + recordatorio + slack
    await ensureFollowupForAssignment({
      orgId: org_id,
      leadId,
      leadNombre: nombre,
      clienteId: cliente_id || null,
      asignadoEmail: asignado_email || null,
      link: link || `https://tu-frontend/leads/${leadId}`,
    });

    res.json({ ok: true, leadId });
  } catch (err) {
    console.error("POST /web/leads error", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

export default r;
