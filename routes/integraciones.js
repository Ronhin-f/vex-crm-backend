// routes/integraciones.js
import { Router } from "express";
import { q } from "../utils/db.js";
import { authenticateToken, requireRole } from "../middleware/auth.js";

const router = Router();

// GET: estado de integraciones (no expone secretos)
router.get("/", authenticateToken, async (req, res) => {
  try {
    const org = (req.usuario?.organizacion_id ?? req.organizacion_id) || null;
    const r = await q(
      `SELECT slack_webhook_url, whatsapp_meta_token, whatsapp_phone_id
         FROM integraciones
        WHERE organizacion_id = $1`,
      [org]
    );
    const row = r.rows?.[0] || {};
    res.json({
      slack: { configured: !!row.slack_webhook_url },
      whatsapp: { configured: !!row.whatsapp_meta_token, phone_id: row.whatsapp_phone_id || null },
    });
  } catch (e) {
    console.error("[GET /integraciones]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error al obtener integraciones" });
  }
});

// PUT Slack webhook (roles altos)
router.put("/slack", authenticateToken, requireRole("owner","admin","superadmin"), async (req, res) => {
  const webhook = String(req.body?.slack_webhook_url || "").trim();
  if (!/^https:\/\/hooks\.slack\.com\//.test(webhook)) {
    return res.status(400).json({ message: "Slack webhook inválido" });
  }
  try {
    const org = (req.usuario?.organizacion_id ?? req.organizacion_id) || null;
    await q(
      `INSERT INTO integraciones (organizacion_id, slack_webhook_url)
       VALUES ($1,$2)
       ON CONFLICT (organizacion_id)
       DO UPDATE SET slack_webhook_url = EXCLUDED.slack_webhook_url, updated_at = NOW()`,
      [org, webhook]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("[PUT /integraciones/slack]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error al guardar Slack" });
  }
});

// PUT WhatsApp Cloud (roles altos)
router.put("/whatsapp", authenticateToken, requireRole("owner","admin","superadmin"), async (req, res) => {
  const metaToken = String(req.body?.whatsapp_meta_token || "").trim();
  const phoneId   = String(req.body?.whatsapp_phone_id || "").trim();
  if (!metaToken || !phoneId) return res.status(400).json({ message: "Se requieren meta_token y phone_id" });

  try {
    const org = (req.usuario?.organizacion_id ?? req.organizacion_id) || null;
    await q(
      `INSERT INTO integraciones (organizacion_id, whatsapp_meta_token, whatsapp_phone_id)
       VALUES ($1,$2,$3)
       ON CONFLICT (organizacion_id)
       DO UPDATE SET whatsapp_meta_token = EXCLUDED.whatsapp_meta_token,
                     whatsapp_phone_id  = EXCLUDED.whatsapp_phone_id,
                     updated_at = NOW()`,
      [org, metaToken, phoneId]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("[PUT /integraciones/whatsapp]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error al guardar WhatsApp" });
  }
});

export default router;
