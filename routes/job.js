// routes/job.js — Dispatcher de recordatorios (robusto + multi-tenant, TEXT-safe, sin deps fantasma)
import { Router } from "express";
import { q } from "../utils/db.js";
import { authenticateToken, requireRole } from "../middleware/auth.js";
import { sendSlackMessage, followupBlocks } from "../utils/slack.js";
import { sendWhatsAppText } from "../utils/whatsapp.js";

const router = Router();

/* ------------------------ helpers inline ------------------------ */
const T = (v) => (v == null ? null : String(v).trim() || null);

function getOrgText(req) {
  return (
    T(req.usuario?.organizacion_id) ||
    T(req.headers["x-org-id"]) ||
    T(req.query?.organizacion_id) ||
    T(req.body?.organizacion_id) ||
    null
  );
}

async function regclassExists(name) {
  try {
    const r = await q(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${name}`]);
    return !!r.rows?.[0]?.ok;
  } catch { return false; }
}
async function hasTable(name) { return regclassExists(name); }

async function tableColumns(name) {
  try {
    const r = await q(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1`,
      [name]
    );
    return new Set((r.rows || []).map((x) => x.column_name));
  } catch { return new Set(); }
}

function isValidSlackWebhook(urlStr) {
  try {
    const u = new URL(String(urlStr).trim());
    if (u.protocol !== "https:") return false;
    if (u.hostname !== "hooks.slack.com") return false;
    if (!u.pathname.startsWith("/services/")) return false;
    if (u.search || u.hash) return false;
    return u.pathname.length > "/services/".length;
  } catch { return false; }
}

function sanitizePhone(v) {
  if (v == null) return null;
  const s = String(v).trim();
  const num = s.replace(/[^\d+]/g, "");
  return num.startsWith("+") ? "+" + num.slice(1).replace(/[+]/g, "") : num;
}

/* ------------------------ POST /job/dispatch ------------------------ */
/**
 * Recorre recordatorios vencidos de la org del token y los envía por Slack/WhatsApp.
 * Query: ?limit=1..200 (default 50)
 */
router.post(
  "/dispatch",
  authenticateToken,
  requireRole("owner", "admin", "superadmin"),
  async (req, res) => {
    try {
      const org = getOrgText(req);
      if (!org) return res.status(400).json({ message: "organizacion_id requerido (token/cabeceras/query/body)" });

      // Infra mínima
      if (!(await hasTable("recordatorios"))) {
        return res.status(501).json({ message: "Módulo de recordatorios no instalado" });
      }

      const rCols = await tableColumns("recordatorios");
      const need = ["organizacion_id", "estado", "enviar_en"];
      const missing = need.filter((c) => !rCols.has(c));
      if (missing.length) {
        return res.status(501).json({ message: `Tabla recordatorios sin columnas requeridas: ${missing.join(", ")}` });
      }

      const hasIntegr = await hasTable("integraciones");
      const hasTareas = await hasTable("tareas");
      const hasClientes = await hasTable("clientes");
      const iCols = hasIntegr ? await tableColumns("integraciones") : new Set();
      const tCols = hasTareas ? await tableColumns("tareas") : new Set();
      const cCols = hasClientes ? await tableColumns("clientes") : new Set();

      // Límite seguro
      const rawLimit = Number(req.query?.limit);
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, Math.floor(rawLimit))) : 50;

      // Partes condicionales por esquema variable
      const joinT = hasTareas && rCols.has("tarea_id") && tCols.has("id")
        ? `LEFT JOIN tareas t ON t.id = c.tarea_id`
        : "";

      const coalesceCliPieces = [];
      if (rCols.has("cliente_id")) coalesceCliPieces.push("c.cliente_id");
      if (joinT && tCols.has("cliente_id")) coalesceCliPieces.push("t.cliente_id");
      const joinCli = hasClientes && coalesceCliPieces.length
        ? `LEFT JOIN clientes cli ON cli.id = COALESCE(${coalesceCliPieces.join(", ")})`
        : "";

      const selectTitulo = joinT && tCols.has("titulo") ? "t.titulo" : "NULL::text";
      const selectVence  = joinT && tCols.has("vence_en") ? "t.vence_en" : "NULL::timestamptz";
      const selectCliNom = joinCli && cCols.has("nombre") ? "cli.nombre" : "NULL::text";
      const selectCliTel = joinCli && cCols.has("telefono") ? "cli.telefono" : "NULL::text";

      const joinI = hasIntegr && iCols.has("organizacion_id")
        ? `LEFT JOIN integraciones i ON i.organizacion_id::text = c.organizacion_id::text`
        : "";

      const selectSlack = hasIntegr && iCols.has("slack_webhook_url")
        ? "i.slack_webhook_url"
        : "NULL::text";
      const selectWaTok = hasIntegr && iCols.has("whatsapp_meta_token")
        ? "i.whatsapp_meta_token"
        : "NULL::text";
      const selectWaPid = hasIntegr && iCols.has("whatsapp_phone_id")
        ? "i.whatsapp_phone_id"
        : "NULL::text";

      // SETs condicionados para claim/sent/error
      const claimSets = [];
      if (rCols.has("estado")) claimSets.push(`estado='procesando'`);
      if (rCols.has("intento_count")) claimSets.push(`intento_count = COALESCE(r.intento_count, 0)`);
      if (rCols.has("started_at")) claimSets.push(`started_at = NOW()`);
      if (rCols.has("updated_at")) claimSets.push(`updated_at = NOW()`);

      const sentSets = [];
      if (rCols.has("estado")) sentSets.push(`estado='enviado'`);
      if (rCols.has("sent_at")) sentSets.push(`sent_at=NOW()`);
      if (rCols.has("last_error")) sentSets.push(`last_error=NULL`);
      if (rCols.has("updated_at")) sentSets.push(`updated_at=NOW()`);

      const errSets = [];
      if (rCols.has("estado")) errSets.push(`estado='error'`);
      if (rCols.has("intento_count")) errSets.push(`intento_count = COALESCE(intento_count,0) + 1`);
      if (rCols.has("last_error")) errSets.push(`last_error = $1`);
      if (rCols.has("updated_at")) errSets.push(`updated_at = NOW()`);

      // 1) Claim atómico + fetch de contexto
      const sql = `
        WITH take AS (
          SELECT id
            FROM recordatorios
           WHERE organizacion_id::text = $1::text
             AND ${rCols.has("estado") ? `estado = 'pendiente'` : `TRUE`}
             AND ${rCols.has("enviar_en") ? `enviar_en <= NOW()` : `TRUE`}
           ORDER BY ${rCols.has("enviar_en") ? `enviar_en ASC` : `id ASC`}
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        ),
        claimed AS (
          UPDATE recordatorios r
             SET ${claimSets.join(", ")}
            FROM take
           WHERE r.id = take.id
           RETURNING r.*
        )
        SELECT
          c.*,
          ${selectSlack}  AS slack_webhook_url,
          ${selectWaTok}  AS whatsapp_meta_token,
          ${selectWaPid}  AS whatsapp_phone_id,
          ${selectTitulo} AS tarea_titulo,
          ${selectVence}  AS vence_en,
          ${selectCliNom} AS cliente_nombre,
          ${selectCliTel} AS cliente_telefono
        FROM claimed c
        ${joinI}
        ${joinT}
        ${joinCli}
      `;
      const { rows: claimed } = await q(sql, [org, limit]);

      let ok = 0, err = 0;

      for (const r of claimed) {
        try {
          const text = r.mensaje || r.titulo || "Recordatorio";
          const blocks = followupBlocks({
            titulo: r.tarea_titulo || r.titulo || "Seguimiento",
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

          // ok → update
          await q(
            `UPDATE recordatorios SET ${sentSets.join(", ")} WHERE id=$1`,
            [r.id]
          );
          ok++;
        } catch (e) {
          // error → update
          const params = errSets.some(s => s.includes("$1"))
            ? [String(e?.message || e), r.id]
            : [r.id];
          const setSql = errSets.some(s => s.includes("$1"))
            ? errSets.join(", ")
            : errSets.join(", ");
          await q(
            `UPDATE recordatorios SET ${setSql} WHERE id = $${params.length}`,
            params
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
