// workers/outbox.dispatch.js — ESM, seguro y idempotente
import { q } from "../utils/db.js";
import { emit as emitFlow } from "../services/flows.client.js";

let timer = null;
let running = false;

export async function startOutboxDispatcher(opts = {}) {
  const intervalMs = Number(process.env.OUTBOX_INTERVAL_MS) || opts.intervalMs || 5000;
  const maxBatch   = Number(process.env.OUTBOX_MAX_BATCH)   || opts.maxBatch   || 25;
  const maxAttempts= Number(process.env.OUTBOX_MAX_ATTEMPTS)|| opts.maxAttempts|| 5;

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

  await ensureSchema();

  async function tick() {
    if (!running) return;
    try {
      // Tomamos lote de pendientes
      const pending = await q(
        `SELECT id, topic, payload, attempts
           FROM public.outbox
          WHERE status = 'pending'
            AND scheduled_at <= now()
          ORDER BY id
          LIMIT $1`,
        [maxBatch]
      );

      for (const row of pending.rows || []) {
        const { id, topic, payload, attempts } = row;

        // Marcamos processing (optimista)
        await q(
          `UPDATE public.outbox
              SET status='processing', updated_at=now()
            WHERE id=$1 AND status='pending'`,
          [id]
        );

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
          await q(
            `UPDATE public.outbox
                SET status = $2,
                    attempts = $3,
                    last_error = LEFT($4::text, 500),
                    scheduled_at = CASE WHEN $2='pending'
                                       THEN now() + make_interval(secs => 15 * $3)
                                       ELSE scheduled_at END,
                    updated_at = now()
              WHERE id = $1`,
            [id, failed ? "failed" : "pending", nextAttempts, err?.stack || err?.message || String(err)]
          );
          if (failed) console.error("[outbox] giving up after max attempts", { id, topic });
        }
      }
    } catch (e) {
      console.error("[outbox] tick error", e?.stack || e);
    } finally {
      if (running) timer = setTimeout(tick, intervalMs);
    }
  }

  timer = setTimeout(tick, 500); // arranque suave
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

  // Ruta simple: topics de flows: "flow.user.created" -> emitFlow("user.created", payload)
  if (topic.startsWith("flow.")) {
    const t = topic.slice(5); // quita "flow."
    await emitFlow(t, payload);
    return;
  }

  // Default: no-op + log para no romper nada
  console.log("[outbox] delivered (noop)", { topic, hasPayload: payload != null });
}
