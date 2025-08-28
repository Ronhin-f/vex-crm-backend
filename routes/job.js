// routes/job.js
import { Router } from "express";
import { q } from "../utils/db.js";
import { authenticateToken, requireRole } from "../middleware/auth.js";
import { sendSlackMessage, followupBlocks } from "../utils/slack.js";
import { sendWhatsAppText } from "../utils/whatsapp.js";

const router = Router();

/** Despacha recordatorios vencidos (<= now). Idempotente por estado. */
router.post("/dispatch", authenticateToken, requireRole("owner","admin","superadmin"), async (req, res) => {
  const org = (req.usuario?.organizacion_id ?? req.organizacion_id) || null;

  try {
    const { rows } = await q(
      `SELECT r.*,
              i.slack_webhook_url,
              i.whatsapp_meta_token,
              i.whatsapp_phone_id,
              t.titulo AS tarea_titulo, t.vence_en,
              c.nombre AS cliente_nombre,
              c.telefono AS cliente_telefono
         FROM recordatorios r
         LEFT JOIN integraciones i ON i.organizacion_id = r.organizacion_id
         LEFT JOIN tareas t ON t.id = r.tarea_id
         LEFT JOIN clientes c ON c.id = COALESCE(r.cliente_id, t.cliente_id)
        WHERE r.organizacion_id = $1
          AND r.estado = 'pendiente'
          AND r.enviar_en <= NOW()
        ORDER BY r.enviar_en ASC
        LIMIT 50`,
      [org]
    );

    let ok = 0, err = 0;
    for (const r of rows) {
      try {
        const text = r.mensaje || r.titulo;
        const blocks = followupBlocks({
          titulo: r.tarea_titulo || r.titulo,
          cliente: r.cliente_nombre,
          vence_en: r.vence_en,
          url: null,
        });

        let delivered = false;

        // 1) Slack si está configurado
        if (!delivered && r.slack_webhook_url) {
          await sendSlackMessage(r.slack_webhook_url, text, blocks);
          delivered = true;
        }

        // 2) WhatsApp si está configurado y hay teléfono del cliente
        if (!delivered && r.whatsapp_meta_token && r.whatsapp_phone_id && r.cliente_telefono) {
          await sendWhatsAppText({
            metaToken: r.whatsapp_meta_token,
            phoneId: r.whatsapp_phone_id,
            to: String(r.cliente_telefono).replace(/[^\d+]/g, ""), // naive sanitize
            text,
          });
          delivered = true;
        }

        // Si no hay canales configurados, marcamos error descriptivo
        if (!delivered) throw new Error("Sin canales configurados (Slack/WhatsApp)");

        await q(`UPDATE recordatorios SET estado='enviado', sent_at=NOW() WHERE id = $1`, [r.id]);
        ok++;
      } catch (e) {
        await q(
          `UPDATE recordatorios
              SET estado='error', intento_count=intento_count+1, last_error=$1
            WHERE id = $2`,
          [String(e?.message || e), r.id]
        );
        err++;
      }
    }

    res.json({ ok, err, total: rows.length });
  } catch (e) {
    console.error("[POST /jobs/dispatch]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error al despachar recordatorios" });
  }
});

export default router;
