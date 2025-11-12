// routes/integraciones.js — Integraciones (Slack/WhatsApp) blindado + multi-tenant
import { Router } from "express";
import { q } from "../utils/db.js";
import { authenticateToken, requireRole } from "../middleware/auth.js";
import { nocache } from "../middleware/nocache.js";
import { resolveOrgId } from "../utils/schema.js";

const router = Router();

/* ------------------------ helpers ------------------------ */
async function ensureTable() {
  // Crea tabla si no existe
  await q(`
    CREATE TABLE IF NOT EXISTS integraciones (
      id SERIAL PRIMARY KEY,
      -- mantenemos TEXT para back-compat con entornos ya creados
      organizacion_id TEXT UNIQUE,
      slack_webhook_url TEXT,
      slack_default_channel TEXT,
      whatsapp_meta_token TEXT,
      whatsapp_phone_id TEXT,
      ios_push_key_id TEXT,
      ios_team_id TEXT,
      ios_bundle_id TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Columnas que podrían faltar en esquemas viejos
  await q(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'integraciones' AND column_name = 'slack_default_channel'
      ) THEN
        ALTER TABLE integraciones ADD COLUMN slack_default_channel TEXT;
      END IF;
    END $$;
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
// Estado “safe” (sin exponer secretos). Con fallback a ENV.
// No 404 ni 500: el dashboard no debe romper.
router.get("/", authenticateToken, nocache, async (req, res) => {
  const safeEmpty = {
    slack: {
      configured: false,
      default_channel: null,
      source: null,
    },
    whatsapp: {
      configured: false,
      phone_id: null,
    },
  };

  try {
    const orgId = await resolveOrgId(req);
    const org = toStrOrNull(orgId);
    await ensureTable();

    // Si no hay org en token/headers, devolvemos sólo ENV (si existiera)
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
         FROM integraciones
        WHERE organizacion_id = $1
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
      const orgId = await resolveOrgId(req);
      const org = toStrOrNull(orgId);
      if (!org) return res.status(400).json({ message: "organizacion_id requerido en el token o cabeceras" });

      const webhook = toStrOrNull(req.body?.slack_webhook_url)?.trim() || "";
      const defaultChannel = toStrOrNull(req.body?.slack_default_channel)?.trim() || null;

      if (!isValidSlackWebhook(webhook)) {
        return res.status(400).json({
          message: "Slack webhook inválido. Debe ser un Incoming Webhook con formato https://hooks.slack.com/services/...",
        });
      }

      await ensureTable();
      await q(
        `INSERT INTO integraciones (organizacion_id, slack_webhook_url, slack_default_channel)
         VALUES ($1,$2,$3)
         ON CONFLICT (organizacion_id)
         DO UPDATE SET
           slack_webhook_url   = EXCLUDED.slack_webhook_url,
           slack_default_channel = EXCLUDED.slack_default_channel,
           updated_at = NOW()`,
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
// Limpia la configuración de Slack (útil en staging).
router.delete(
  "/slack",
  authenticateToken,
  requireRole("owner", "admin", "superadmin"),
  async (req, res) => {
    try {
      const orgId = await resolveOrgId(req);
      const org = toStrOrNull(orgId);
      if (!org) return res.status(400).json({ message: "organizacion_id requerido" });

      await ensureTable();
      const r = await q(
        `UPDATE integraciones
            SET slack_webhook_url = NULL,
                slack_default_channel = NULL,
                updated_at = NOW()
          WHERE organizacion_id = $1`,
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
      const orgId = await resolveOrgId(req);
      const org = toStrOrNull(orgId);
      if (!org) return res.status(400).json({ message: "organizacion_id requerido en el token o cabeceras" });

      const metaToken = toStrOrNull(req.body?.whatsapp_meta_token)?.trim();
      const phoneId   = toStrOrNull(req.body?.whatsapp_phone_id)?.trim();

      if (!metaToken || !phoneId) {
        return res.status(400).json({ message: "Se requieren whatsapp_meta_token y whatsapp_phone_id" });
      }
      // Si querés validar el formato del phone_id, descomentá:
      // if (!/^\d{5,}$/.test(phoneId)) return res.status(400).json({ message: "whatsapp_phone_id inválido" });

      await ensureTable();
      await q(
        `INSERT INTO integraciones (organizacion_id, whatsapp_meta_token, whatsapp_phone_id)
         VALUES ($1,$2,$3)
         ON CONFLICT (organizacion_id)
         DO UPDATE SET
           whatsapp_meta_token = EXCLUDED.whatsapp_meta_token,
           whatsapp_phone_id   = EXCLUDED.whatsapp_phone_id,
           updated_at = NOW()`,
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
      const orgId = await resolveOrgId(req);
      const org = toStrOrNull(orgId);
      if (!org) return res.status(400).json({ message: "organizacion_id requerido" });

      await ensureTable();
      const r = await q(
        `UPDATE integraciones
            SET whatsapp_meta_token = NULL,
                whatsapp_phone_id  = NULL,
                updated_at = NOW()
          WHERE organizacion_id = $1`,
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
