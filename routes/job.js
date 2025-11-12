// routes/job.js — Dispatcher de recordatorios (robusto + multi-tenant)
import { Router } from "express";
import { q } from "../utils/db.js";
import { authenticateToken, requireRole } from "../middleware/auth.js";
import { sendSlackMessage, followupBlocks } from "../utils/slack.js";
import { sendWhatsAppText } from "../utils/whatsapp.js";
import { resolveOrgId, hasTable } from "../utils/schema.js";
import { nocache } from "../middleware/nocache.js";

const router = Router();

/* ------------------------ helpers ------------------------ */
function isValidSlackWebhook(urlStr) {
  try {
    const u = new URL(String(urlStr).trim());
    if (u.protocol !== "https:") return false;
    if (u.hostname !== "hooks.slack.com") return false;
    if (!u.pathname.startsWith("/services/")) return false;
    if (u.search || u.hash) return false;
    return u.pathname.length > "/services/".length;
  } catch {
    return false;
  }
}

function sanitizePhone(v) {
  if (v == null) return null;
  // deja dígitos y + al inicio
  const s = String(v).trim();
  const num = s.replace(/[^\d+]/g, "");
  // evita múltiples '+' y casos raros
  if (num.startsWith("+")) return "+" + num.slice(1).replace(/[+]/g, "");
  return num;
}

/* ------------------------ POST /job/dispatch ------------------------ */
/**
 * Recorre recordatorios vencidos de la org del token y los envía por Slack/WhatsApp.
 * Seguridad:
 *   - Multi-tenant: filtra por organizacion_id.
 *   - Concurrencia: CLAIM atómico con FOR UPDATE SKIP LOCKED en un único statement.
 *   - Esquema variable: JOIN a integraciones solo si existe la tabla.
 * Query params:
 *   - limit (1..200) default 50
 */
router.post(
  "/dispatch",
  authenticateToken,
  requireRole("owner", "admin", "superadmin"),
  nocache,
  async (req, res) => {
    try {
      const orgId = await resolveOrgId(req);
      const org = orgId == null ? null : String(orgId);
      if (!org) return res.status(400).json({ message: "organizacion_id requerido en el token o cabeceras" });

      // Infra mínima
      const hasRec = await hasTable("recordatorios");
      if (!hasRec) {
        return res.status(501).json({ message: "Módulo de recordatorios no instalado" });
      }

      const hasIntegr = await hasTable("integraciones");
      const hasTareas = await hasTable("tareas");
      const hasClientes = await hasTable("clientes");

      // Límite seguro
      const rawLimit = Number(req.query?.limit);
      const limit = Number.isFinite(rawLimit)
        ? Math.max(1, Math.min(200, Math.floor(rawLimit)))
        : 50;

      // Partes condicionales por esquema variable
      const joinT = hasTareas ? `LEFT JOIN tareas t ON t.id = c.tarea_id` : "";
      const joinCli = hasClientes ? `LEFT JOIN clientes cli ON cli.id = COALESCE(c.cliente_id, ${hasTareas ? "t.cliente_id" : "NULL"})` : "";
      const selectTitulo = hasTareas ? "t.titulo AS tarea_titulo" : "NULL::text AS tarea_titulo";
      const selectVence = hasTareas ? "t.vence_en" : "NULL::timestamptz AS vence_en";
      const selectCliNom = hasClientes ? "cli.nombre AS cliente_nombre" : "NULL::text AS cliente_nombre";
      const selectCliTel = hasClientes ? "cli.telefono AS cliente_telefono" : "NULL::text AS cliente_telefono";

      const joinI = hasIntegr ? `LEFT JOIN integraciones i ON i.organizacion_id = c.organizacion_id::text` : "";
      const selectSlack = hasIntegr ? "i.slack_webhook_url" : "NULL::text AS slack_webhook_url";
      const selectWaTok = hasIntegr ? "i.whatsapp_meta_token" : "NULL::text AS whatsapp_meta_token";
      const selectWaPid = hasIntegr ? "i.whatsapp_phone_id" : "NULL::text AS whatsapp_phone_id";

      // 1) Claim atómico + fetch de contexto
      const { rows: claimed } = await q(
        `
        WITH take AS (
          SELECT id
            FROM recordatorios
           WHERE organizacion_id::text = $1::text
             AND estado = 'pendiente'
             AND enviar_en <= NOW()
           ORDER BY enviar_en ASC
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        ),
        claimed AS (
          UPDATE recordatorios r
             SET estado      = 'procesando',
                 intento_count = COALESCE(r.intento_count, 0),
                 started_at  = NOW(),
                 updated_at  = NOW()
            FROM take
           WHERE r.id = take.id
           RETURNING r.*
        )
        SELECT
          c.*,
          ${selectSlack},
          ${selectWaTok},
          ${selectWaPid},
          ${selectTitulo},
          ${selectVence},
          ${selectCliNom},
          ${selectCliTel}
        FROM claimed c
        ${joinI}
        ${joinT}
        ${joinCli}
        `,
        [org, limit]
      );

      let ok = 0, err = 0;

      for (const r of claimed) {
        try {
          const text = r.mensaje || r.titulo || "Recordatorio";
          const blocks = followupBlocks({
            titulo: r.tarea_titulo || r.titulo,
            cliente: r.cliente_nombre || null,
            vence_en: r.vence_en || null,
            url: null,
          });

          let delivered = false;

          // 1) Slack
          if (!delivered && r.slack_webhook_url && isValidSlackWebhook(r.slack_webhook_url)) {
            await sendSlackMessage(r.slack_webhook_url, text, blocks);
            delivered = true;
          }

          // 2) WhatsApp
          if (!delivered && r.whatsapp_meta_token && r.whatsapp_phone_id && r.cliente_telefono) {
            const to = sanitizePhone(r.cliente_telefono);
            if (to) {
              await sendWhatsAppText({
                metaToken: r.whatsapp_meta_token,
                phoneId: r.whatsapp_phone_id,
                to,
                text,
              });
              delivered = true;
            }
          }

          if (!delivered) throw new Error("Sin canales configurados o datos insuficientes (Slack/WhatsApp)");

          await q(
            `UPDATE recordatorios
                SET estado='enviado', sent_at=NOW(), last_error=NULL, updated_at=NOW()
              WHERE id=$1`,
            [r.id]
          );
          ok++;
        } catch (e) {
          await q(
            `UPDATE recordatorios
                SET estado='error',
                    intento_count = COALESCE(intento_count,0) + 1,
                    last_error = $1,
                    updated_at = NOW()
              WHERE id = $2`,
            [String(e?.message || e), r.id]
          );
          err++;
        }
      }

      return res.json({ ok, err, total: claimed.length, limit });
    } catch (e) {
      console.error("[POST /job/dispatch]", e?.stack || e?.message || e);
      return res.status(500).json({ message: "Error al despachar recordatorios" });
    }
  }
);

export default router;
