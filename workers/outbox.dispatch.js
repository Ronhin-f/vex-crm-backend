import { q } from "../utils/db.js";
import { emit as emitFlow } from "../services/flows.client.js";

let timer = null;
let running = false;

export async function startOutboxDispatcher(opts = {}) {
  const intervalMs  = Number(process.env.OUTBOX_INTERVAL_MS)   || opts.intervalMs  || 5000;
  const maxBatch    = Number(process.env.OUTBOX_MAX_BATCH)     || opts.maxBatch    || 25;
  const maxAttempts = Number(process.env.OUTBOX_MAX_ATTEMPTS)  || opts.maxAttempts || 5;

  const disabled = String(process.env.OUTBOX_DISABLED || "").toLowerCase();
  if (disabled === "1" || disabled === "true") {
    console.warn("[outbox] disabled via OUTBOX_DISABLED");
    return stopOutboxDispatcher;
  }

  if (running) {
    console.log("[outbox] already running");
    return stopOutboxDispatcher;
  }
  running = true;

  // Mantengo esto por robustez. No crea features, solo asegura la tabla si falta.
  await ensureSchema();

  async function tick() {
    if (!running) return;

    try {
      // 1) Reclamamos el lote de manera atómica y segura entre múltiples workers.
      const claimSql = `
        WITH picked AS (
          SELECT id
          FROM public.outbox
          WHERE status = 'pending'
            AND scheduled_at <= now()
          ORDER BY id
          FOR UPDATE SKIP LOCKED
          LIMIT $1
        )
        UPDATE public.outbox o
           SET status = 'processing',
               updated_at = now()
        FROM picked
        WHERE o.id = picked.id
        RETURNING o.id, o.topic, o.payload, o.attempts
      `;
      const claim = await q(claimSql, [maxBatch]);
      const batch = claim.rows || [];

      // 2) Enviamos cada mensaje y marcamos resultado.
      for (const row of batch) {
        const { id, topic, payload, attempts } = row;
        try {
          await deliver(topic, payload);
          await q(
            `UPDATE public.outbox
               SET status='done', updated_at=now()
             WHERE id=$1`,
            [id]
          );
        } catch (err) {
          const nextAttempts = (attempts || 0) + 1;
          const failed = nextAttempts >= maxAttempts;
          const nextStatus = failed ? "failed" : "pending";
          const errTxt = (err?.stack || err?.message || String(err)).slice(0, 500);

          await q(
            `UPDATE public.outbox
                SET status = $2,
                    attempts = $3,
                    last_error = $4,
                    scheduled_at = CASE
                                     WHEN $2 = 'pending'
                                       THEN now() + (interval '15 seconds' * $3)
                                     ELSE scheduled_at
                                   END,
                    updated_at = now()
              WHERE id = $1`,
            [id, nextStatus, nextAttempts, errTxt]
          );

          if (failed) {
            console.error("[outbox] giving up after max attempts", { id, topic });
          }
        }
      }
    } catch (e) {
      console.error("[outbox] tick error", e?.stack || e);
    } finally {
      if (running) timer = setTimeout(tick, intervalMs);
    }
  }

  timer = setTimeout(tick, 500);
  console.log("[outbox] dispatcher started");
  return stopOutboxDispatcher;
}

export function stopOutboxDispatcher() {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
  console.log("[outbox] dispatcher stopped");
}

async function ensureSchema() {
  try {
    await q(`
      CREATE TABLE IF NOT EXISTS public.outbox (
        id            BIGSERIAL PRIMARY KEY,
        topic         TEXT    NOT NULL,
        payload       JSONB   NOT NULL DEFAULT '{}'::jsonb,
        status        TEXT    NOT NULL DEFAULT 'pending',
        attempts      INTEGER NOT NULL DEFAULT 0,
        last_error    TEXT,
        scheduled_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (status IN ('pending','processing','done','failed'))
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_status_sched ON public.outbox(status, scheduled_at);
    `);
  } catch (e) {
    console.error("[outbox] ensureSchema error", e?.stack || e);
  }
}

async function deliver(topic, payload) {
  if (!topic) throw new Error("Topic required");
  const data = typeof payload === "string" ? JSON.parse(payload) : payload;

  // Topics de flows: "flow.user.created" -> emitFlow("user.created", data)
  if (topic.startsWith("flow.")) {
    const t = topic.slice(5);
    await emitFlow(t, data);
    return;
  }

  // Default: noop con log
  console.log("[outbox] delivered (noop)", { topic, hasPayload: data != null });
}
