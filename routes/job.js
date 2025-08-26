// Backend/routes/job.js
import { Router } from "express";
import { db } from "../utils/db.js";
import { authenticateToken, requireRole } from "../middleware/auth.js";
import { sendSlackMessage, followupBlocks } from "../utils/slack.js";

const router = Router();

/** Despacha recordatorios vencidos o próximos (<= now) */
router.post("/dispatch", authenticateToken, requireRole(["owner","admin","superadmin"]), async (req, res) => {
  const org = req.organizacion_id;

  try {
    const { rows } = await db.query(
      `SELECT r.*, i.slack_webhook_url, t.titulo AS tarea_titulo, t.vence_en, c.nombre AS cliente_nombre
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
        if (!r.slack_webhook_url) throw new Error("Slack no configurado");
        const text = r.mensaje || r.titulo;
        const blocks = followupBlocks({
          titulo: r.tarea_titulo || r.titulo,
          cliente: r.cliente_nombre,
          vence_en: r.vence_en,
          url: null,
        });
        await sendSlackMessage(r.slack_webhook_url, text, blocks);
        await db.query(
          `UPDATE recordatorios SET estado='enviado', sent_at=NOW() WHERE id = $1`,
          [r.id]
        );
        ok++;
      } catch (e) {
        await db.query(
          `UPDATE recordatorios
              SET estado='error', intento_count=intento_count+1, last_error=$1
            WHERE id = $2`,
          [String(e.message || e), r.id]
        );
        err++;
      }
    }

    res.json({ ok, err, total: rows.length });
  } catch (e) {
    console.error("[POST /jobs/dispatch]", e);
    res.status(500).json({ message: "Error al despachar recordatorios" });
  }
});

export default router;
