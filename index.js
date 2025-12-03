// index.js — VEX CRM Backend (ESM)
import "dotenv/config";
import express from "express";
import morgan from "morgan";
import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import cron from "node-cron";
import { applySecurity } from "./middleware/security.js";
import { initDB, q, pool } from "./utils/db.js";
import { authenticateToken as auth } from "./middleware/auth.js";
import { scheduleReminders } from "./workers/reminders.worker.js";
import { startOutboxDispatcher } from "./workers/outbox.dispatch.js";

process.env.SLACK_WEBHOOK_FALLBACK_CHANNEL ??= "#reminders-and-follow-ups";
process.env.REMINDER_CRON ??= "*/10 * * * *";
process.env.INVOICE_REMINDER_CRON ??= "0 * * * *";
process.env.OUTBOX_DISPATCH_INTERVAL_MS ??= "60000";

const app = express();
app.set("trust proxy", true);

app.use(express.json({ limit: process.env.JSON_LIMIT || "1mb" }));
app.use(express.urlencoded({ extended: false }));

if (process.env.NODE_ENV !== "test") {
  app.use(
    morgan(process.env.LOG_FORMAT || "tiny", {
      stream: {
        write: (s) =>
          console.log(
            s
              .trim()
              .replace(/vex_token=[^&]+/g, "vex_token=REDACTED")
              .replace(/Authorization:\s*Bearer\s+[A-Za-z0-9._-]+/gi, "Authorization: Bearer REDACTED")
          ),
      },
    })
  );
}

applySecurity(app);

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use("/uploads", express.static(UPLOAD_DIR));

app.get("/favicon.ico", (_req, res) => res.status(204).end());

let dbReady = false;
app.get("/healthz", (_req, res) => res.status(200).json({ ok: true, minimal: true }));
app.get("/readyz", (_req, res) =>
  dbReady ? res.json({ ok: true }) : res.status(503).json({ ok: false, dbReady })
);

try {
  await initDB();
  await ensureInvoicesSchema();
  dbReady = true;
} catch (e) {
  console.error("initDB() fallo:", e?.stack || e?.message || e);
}

async function mount(pathname, modulePath) {
  try {
    const mod = await import(modulePath);
    const router = mod.default || mod.router || mod;
    if (router && typeof router === "function") {
      app.use(pathname, router);
      console.log(`Ruta montada: ${pathname} <- ${modulePath}`);
    } else {
      console.warn(`${modulePath} no exporta un router valido. Stub 501 en ${pathname}`);
      app.use(pathname, (_req, res) => res.status(501).json({ error: "Ruta no disponible" }));
    }
  } catch (e) {
    console.error(`Error importando ${modulePath}:`, e?.stack || e?.message || e);
    app.use(pathname, (_req, res) => res.status(500).json({ error: "Ruta fallo al cargar" }));
  }
}

await mount("/", "./routes/contactos.js");
await mount("/clientes", "./routes/clientes.js");
await mount("/proyectos", "./routes/proyectos.js");
await mount("/proyectos", "./routes/proyectos.assign.js");
await mount("/proveedores", "./routes/proveedores.js");

await mount("/users", "./routes/users.js");
await mount("/usuarios", "./routes/users.js");

await mount("/compras", "./routes/compras.js");

await mount("/categorias", "./routes/categorias.js");
await mount("/kanban", "./routes/kanban.js");
await mount("/tareas", "./routes/tareas.js");
await mount("/dashboard", "./routes/dashboard.js");

await mount("/analytics", "./routes/analytics.js");

await mount("/upload", "./routes/upload.js");
await mount("/modulos", "./routes/modulos.js");
await mount("/integraciones", "./routes/integraciones.js");
await mount("/jobs", "./routes/job.js");
await mount("/ai", "./routes/ai.js");
await mount("/health", "./routes/health.js");
await mount("/labs", "./routes/labs.js");
await mount("/recordatorios", "./routes/recordatorios.js");

await mount("/area", "./routes/area.js");
await mount("/historias", "./routes/historias.js");

await mount("/web", "./routes/web.js");

function withOrg(req, res, next) {
  const org =
    req.usuario?.organizacion_id ||
    req.headers["x-org-id"] ||
    req.query.organizacion_id ||
    null;

  if (!org) return res.status(400).json({ error: "organizacion_id requerido" });
  req.orgId = String(org);
  next();
}

const N = (x) => Number(x ?? 0);

async function notifyFlows(type, payload) {
  const base = process.env.FLOWS_BASE_URL;
  const token = process.env.FLOWS_BEARER;
  if (!base || !token) {
    console.warn("Flows no configurado (FLOWS_BASE_URL/FLOWS_BEARER). Se omite envio.");
    return { skipped: true };
  }
  await axios.post(
    `${base.replace(/\/+$/, "")}/api/triggers/emit`,
    { type, payload },
    { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }
  );
}

app.get("/invoices", auth, withOrg, async (req, res) => {
  const { rows } = await q(
    `
    SELECT i.*, c.nombre AS client_name, c.email AS client_email
    FROM invoices i
    JOIN clientes c ON c.id = i.client_id
    WHERE i.organizacion_id = $1
    ORDER BY i.issue_date DESC, i.created_at DESC
    `,
    [req.orgId]
  );
  res.json(rows);
});

app.post("/invoices", auth, withOrg, async (req, res) => {
  const b = req.body || {};
  const { rows } = await q(
    `
    INSERT INTO invoices
      (id, organizacion_id, client_id, number, issue_date, due_date, currency,
       amount_subtotal, amount_tax, amount_total, amount_paid, status, notes)
    VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, COALESCE($6,'USD'),
            $7, $8, $9, COALESCE($10,0), COALESCE($11,'draft'), $12)
    RETURNING *
    `,
    [
      req.orgId,
      b.client_id,
      b.number || null,
      b.issue_date || new Date().toISOString().slice(0, 10),
      b.due_date,
      b.currency || "USD",
      N(b.amount_subtotal),
      N(b.amount_tax),
      N(b.amount_total),
      N(b.amount_paid),
      b.status || "draft",
      b.notes || null,
    ]
  );
  res.status(201).json(rows[0]);
});

app.post("/invoices/:id/remind", auth, withOrg, async (req, res) => {
  const { id } = req.params;
  const { rows } = await q(
    `
    SELECT i.*, c.nombre AS client_name, c.email AS client_email
    FROM invoices i
    JOIN clientes c ON c.id = i.client_id
    WHERE i.id = $1 AND i.organizacion_id = $2
    `,
    [id, req.orgId]
  );
  const inv = rows[0];
  if (!inv) return res.status(404).json({ error: "Invoice not found" });

  const amount_due = Math.max(N(inv.amount_total) - N(inv.amount_paid), 0);
  await notifyFlows("invoice_reminder", {
    org: req.orgId,
    invoiceId: inv.id,
    client: { name: inv.client_name, email: inv.client_email },
    amount_due,
    due_date: inv.due_date,
  });

  await q(`UPDATE invoices SET last_reminder_at = now() WHERE id=$1`, [inv.id]);
  res.status(202).json({ queued: true });
});

app.get("/", (_req, res) => res.json({ ok: true, service: "vex-crm-backend" }));
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err?.stack || err?.message || err);
  res.status(500).json({ error: "Internal error" });
});

process.on("unhandledRejection", (e) => console.error("UNHANDLED REJECTION:", e));
process.on("uncaughtException", (e) => console.error("UNCAUGHT EXCEPTION:", e));

scheduleReminders();
console.log(
  `Reminders ON cron=${process.env.REMINDER_CRON} tz=America/Argentina/Mendoza | fallbackChannel=${process.env.SLACK_WEBHOOK_FALLBACK_CHANNEL || "(none)"}`
);

startInvoiceReminders();
console.log(
  `InvoiceReminders ON cron=${process.env.INVOICE_REMINDER_CRON} tz=${process.env.TZ || "UTC"}`
);

startOutboxDispatcher();
console.log(`Outbox ON interval=${process.env.OUTBOX_DISPATCH_INTERVAL_MS}ms`);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`VEX CRM en :${PORT} | dbReady=${dbReady}`));

async function ensureInvoicesSchema() {
  await q(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

  await q(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'invoice_status') THEN
      CREATE TYPE invoice_status AS ENUM ('draft','sent','partial','paid','overdue','void');
    END IF;
  END $$;`);

  await q(`
    CREATE TABLE IF NOT EXISTS invoices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organizacion_id TEXT NOT NULL,
      client_id INTEGER NOT NULL,
      number TEXT,
      issue_date DATE NOT NULL DEFAULT (now()::date),
      due_date DATE NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      amount_subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
      amount_tax NUMERIC(12,2) NOT NULL DEFAULT 0,
      amount_total NUMERIC(12,2) NOT NULL DEFAULT 0,
      amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0,
      status invoice_status NOT NULL DEFAULT 'draft',
      last_reminder_at TIMESTAMPTZ,
      next_reminder_at TIMESTAMPTZ,
      reminder_policy JSONB DEFAULT '{"days_before":[7,3,1],"days_after":[1,7,15]}'::jsonb,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_invoices_org_status ON invoices (organizacion_id, status);
    CREATE INDEX IF NOT EXISTS idx_invoices_org_due    ON invoices (organizacion_id, due_date);
  `);

  await q(`
    CREATE OR REPLACE VIEW v_ar_aging AS
    SELECT
      i.organizacion_id,
      SUM(GREATEST(i.amount_total - i.amount_paid, 0)) AS ar_total,
      SUM(CASE WHEN (now()::date - i.due_date) <= 0  THEN GREATEST(i.amount_total - i.amount_paid,0) ELSE 0 END) AS bucket_current,
      SUM(CASE WHEN (now()::date - i.due_date) BETWEEN 1  AND 30 THEN GREATEST(i.amount_total - i.amount_paid,0) ELSE 0 END) AS bucket_1_30,
      SUM(CASE WHEN (now()::date - i.due_date) BETWEEN 31 AND 60 THEN GREATEST(i.amount_total - i.amount_paid,0) ELSE 0 END) AS bucket_31_60,
      SUM(CASE WHEN (now()::date - i.due_date) BETWEEN 61 AND 90 THEN GREATEST(i.amount_total - i.amount_paid,0) ELSE 0 END) AS bucket_61_90,
      SUM(CASE WHEN (now()::date - i.due_date) > 90 THEN GREATEST(i.amount_total - i.amount_paid,0) ELSE 0 END) AS bucket_90p,
      COUNT(*) FILTER (WHERE (now()::date - i.due_date) > 0) AS overdue_count,
      SUM(GREATEST(i.amount_total - i.amount_paid, 0)) FILTER (WHERE (now()::date - i.due_date) > 0) AS overdue_amount,
      SUM(GREATEST(i.amount_total - i.amount_paid, 0)) FILTER (WHERE i.due_date BETWEEN now()::date AND (now()::date + 7)) AS due_next_7
    FROM invoices i
    WHERE i.status IN ('sent','partial','overdue')
    GROUP BY i.organizacion_id;
  `);
}

function startInvoiceReminders() {
  const CRON = process.env.INVOICE_REMINDER_CRON || "0 * * * *";
  const TZ = process.env.TZ || "UTC";
  const LOCK = 842510;

  cron.schedule(
    CRON,
    async () => {
      const c = await pool.connect();
      try {
        const got = (await c.query("SELECT pg_try_advisory_lock($1)", [LOCK])).rows[0].pg_try_advisory_lock;
        if (!got) return;

        const { rows } = await c.query(`
          WITH cand AS (
            SELECT i.*,
                   (now()::date - i.due_date)::int AS days_overdue,
                   COALESCE((i.reminder_policy->'days_before')::jsonb, '[]'::jsonb) AS db,
                   COALESCE((i.reminder_policy->'days_after')::jsonb,  '[]'::jsonb) AS da
            FROM invoices i
            WHERE i.status IN ('sent','partial','overdue')
          )
          SELECT * FROM cand
          WHERE
            (
              (due_date >= now()::date AND (due_date - now()::date) IN (
                SELECT (value)::int FROM jsonb_array_elements_text(db)
              ))
              OR
              (due_date <  now()::date AND (now()::date - due_date) IN (
                SELECT (value)::int FROM jsonb_array_elements_text(da)
              ))
            )
            AND (last_reminder_at IS NULL OR last_reminder_at < now() - interval '20 hours')
        `);

        const Nnum = (x) => Number(x ?? 0);
        for (const i of rows) {
          const due = Math.max(Nnum(i.amount_total) - Nnum(i.amount_paid), 0);
          await notifyFlows("invoice_reminder", {
            org: i.organizacion_id,
            invoiceId: i.id,
            amount_due: due,
            due_date: i.due_date,
            client_id: i.client_id,
          });
          await c.query(
            "UPDATE invoices SET last_reminder_at = now(), status = CASE WHEN now()::date > due_date THEN 'overdue' ELSE status END WHERE id=$1",
            [i.id]
          );
        }
      } catch (e) {
        console.error("InvoiceReminders error:", e?.message || e);
      } finally {
        await c.query("SELECT pg_advisory_unlock($1)", [LOCK]).catch(() => {});
        c.release();
      }
    },
    { timezone: TZ }
  );
}
