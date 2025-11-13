// routes/integraciones.js — Integraciones (Slack/WhatsApp) blindado + multi-tenant (TEXT-safe)
import { Router } from "express";
import { q } from "../utils/db.js";
import { authenticateToken, requireRole } from "../middleware/auth.js";
import { nocache } from "../middleware/nocache.js";
import { getOrgText } from "../utils/org.js"; // ← unificamos helper TEXT-safe

const router = Router();

/* ------------------------ helpers ------------------------ */
async function ensureTable() {
  // Crea tabla si no existe (manteniendo TEXT para back-compat)
  await q(`
    CREATE TABLE IF NOT EXISTS public.integraciones (
      id SERIAL PRIMARY KEY,
      organizacion_id TEXT UNIQUE,
      slack_webhook_url TEXT,
      slack_default_channel TEXT,
      whatsapp_meta_token TEXT,
      whatsapp_phone_id TEXT,
      ios_push_key_id TEXT,
      ios_team_id TEXT,
      ios_bundle_id TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Columnas que podrían faltar en esquemas viejos
  await q(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='integraciones' AND column_name='slack_default_channel'
      ) THEN
        ALTER TABLE public.integraciones ADD COLUMN slack_default_channel TEXT;
      END IF;
    END $$;
  `);

  // Índice único explícito por si la UNIQUE de columna no existe (no rompe si ya hay constraint)
  await q(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_integraciones_org
      ON public.integraciones (organizacion_id);
  `);
}

function toStrOrNull(v) {
  return v == null ? null : String(v);
}

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

/* ------------------------ GET /integraciones ------------------------ */
// Estado “safe” (sin exponer secretos). Con fallback a ENV. Nunca 404/500.
router.get("/", authenticateToken, nocache, async (req, res) => {
  const safeEmpty = {
    slack: { configured: false, default_channel: null, source: null },
    whatsapp: { configured: false, phone_id: null },
  };

  try {
    const org = toStrOrNull(getOrgText(req)); // siempre string (puede venir de header/JWT)
    await ensureTable();

    // Sin org: solo ENV (si existe)
    if (!org) {
      const envWebhook = toStrOrNull(process.env.SLACK_WEBHOOK_URL);
      const envChannel = toStrOrNull(process.env.SLACK_DEFAULT_CHANNEL);
      return res.json({
        ...safeEmpty,
        slack: {
          configured: !!envWebhook,
          default_channel: envChannel || null,
          source: envWebhook ? "env" : null,
        },
      });
    }

    const r = await q(
      `SELECT slack_webhook_url, slack_default_channel, whatsapp_meta_token, whatsapp_phone_id
         FROM public.integraciones
        WHERE organizacion_id::text = $1::text
        LIMIT 1`,
      [org]
    );
    const row = r.rows?.[0] || null;

    // Fallback a ENV si no hay fila
    if (!row) {
      const envWebhook = toStrOrNull(process.env.SLACK_WEBHOOK_URL);
      const envChannel = toStrOrNull(process.env.SLACK_DEFAULT_CHANNEL);
      return res.json({
        ...safeEmpty,
        slack: {
          configured: !!envWebhook,
          default_channel: envChannel || null,
          source: envWebhook ? "env" : null,
        },
      });
    }

    return res.json({
      slack: {
        configured: !!row.slack_webhook_url,
        default_channel: row.slack_default_channel || null,
        source: "db",
      },
      whatsapp: {
        configured: !!row.whatsapp_meta_token,
        phone_id: row.whatsapp_phone_id || null,
      },
    });
  } catch (e) {
    if (e?.code === "42P01") {
      try { await ensureTable(); } catch {}
      return res.json(safeEmpty);
    }
    console.error("[GET /integraciones]", e?.stack || e?.message || e);
    return res.json(safeEmpty);
  }
});

/* ------------------------ PUT /integraciones/slack ------------------------ */
// Guarda Incoming Webhook de Slack y canal por defecto (opcional).
router.put(
  "/slack",
  authenticateToken,
  requireRole("owner", "admin", "superadmin"),
  async (req, res) => {
    try {
      const org = toStrOrNull(getOrgText(req));
      if (!org) return res.status(400).json({ message: "organizacion_id requerido en token/cabeceras" });

      const webhook = toStrOrNull(req.body?.slack_webhook_url)?.trim() || "";
      const defaultChannel = toStrOrNull(req.body?.slack_default_channel)?.trim() || null;

      if (!isValidSlackWebhook(webhook)) {
        return res.status(400).json({
          message: "Slack webhook inválido. Debe ser https://hooks.slack.com/services/...",
        });
      }

      await ensureTable();
      await q(
        `INSERT INTO public.integraciones (organizacion_id, slack_webhook_url, slack_default_channel)
         VALUES ($1::text,$2,$3)
         ON CONFLICT (organizacion_id)
         DO UPDATE SET
           slack_webhook_url     = EXCLUDED.slack_webhook_url,
           slack_default_channel = EXCLUDED.slack_default_channel,
           updated_at            = NOW()`,
        [org, webhook, defaultChannel]
      );

      return res.json({ ok: true });
    } catch (e) {
      console.error("[PUT /integraciones/slack]", e?.stack || e?.message || e);
      return res.status(500).json({ message: "Error al guardar Slack" });
    }
  }
);

/* ------------------------ DELETE /integraciones/slack ------------------------ */
router.delete(
  "/slack",
  authenticateToken,
  requireRole("owner", "admin", "superadmin"),
  async (req, res) => {
    try {
      const org = toStrOrNull(getOrgText(req));
      if (!org) return res.status(400).json({ message: "organizacion_id requerido" });

      await ensureTable();
      const r = await q(
        `UPDATE public.integraciones
            SET slack_webhook_url = NULL,
                slack_default_channel = NULL,
                updated_at = NOW()
          WHERE organizacion_id::text = $1::text`,
        [org]
      );
      return res.json({ ok: true, cleared: r.rowCount > 0 });
    } catch (e) {
      console.error("[DELETE /integraciones/slack]", e?.stack || e?.message || e);
      return res.status(500).json({ message: "Error limpiando Slack" });
    }
  }
);

/* ------------------------ PUT /integraciones/whatsapp ------------------------ */
// Guarda credenciales de WhatsApp Cloud (Meta). No se expone token en GET.
router.put(
  "/whatsapp",
  authenticateToken,
  requireRole("owner", "admin", "superadmin"),
  async (req, res) => {
    try {
      const org = toStrOrNull(getOrgText(req));
      if (!org) return res.status(400).json({ message: "organizacion_id requerido en token/cabeceras" });

      const metaToken = toStrOrNull(req.body?.whatsapp_meta_token)?.trim();
      const phoneId   = toStrOrNull(req.body?.whatsapp_phone_id)?.trim();

      if (!metaToken || !phoneId) {
        return res.status(400).json({ message: "Se requieren whatsapp_meta_token y whatsapp_phone_id" });
      }

      await ensureTable();
      await q(
        `INSERT INTO public.integraciones (organizacion_id, whatsapp_meta_token, whatsapp_phone_id)
         VALUES ($1::text,$2,$3)
         ON CONFLICT (organizacion_id)
         DO UPDATE SET
           whatsapp_meta_token = EXCLUDED.whatsapp_meta_token,
           whatsapp_phone_id   = EXCLUDED.whatsapp_phone_id,
           updated_at          = NOW()`,
        [org, metaToken, phoneId]
      );

      return res.json({ ok: true });
    } catch (e) {
      console.error("[PUT /integraciones/whatsapp]", e?.stack || e?.message || e);
      return res.status(500).json({ message: "Error al guardar WhatsApp" });
    }
  }
);

/* ------------------------ DELETE /integraciones/whatsapp ------------------------ */
// Limpia credenciales de WhatsApp (sin borrar fila).
router.delete(
  "/whatsapp",
  authenticateToken,
  requireRole("owner", "admin", "superadmin"),
  async (req, res) => {
    try {
      const org = toStrOrNull(getOrgText(req));
      if (!org) return res.status(400).json({ message: "organizacion_id requerido" });

      await ensureTable();
      const r = await q(
        `UPDATE public.integraciones
            SET whatsapp_meta_token = NULL,
                whatsapp_phone_id  = NULL,
                updated_at = NOW()
          WHERE organizacion_id::text = $1::text`,
        [org]
      );
      return res.json({ ok: true, cleared: r.rowCount > 0 });
    } catch (e) {
      console.error("[DELETE /integraciones/whatsapp]", e?.stack || e?.message || e);
      return res.status(500).json({ message: "Error limpiando WhatsApp" });
    }
  }
);

export default router;
