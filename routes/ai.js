// routes/ai.js
import { Router } from "express";
import { q } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";

const router = Router();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
let OpenAIClient = null;

try {
  // Carga perezosa (si no está instalada la lib o no hay key, no rompe)
  if (OPENAI_API_KEY) {
    const mod = await import("openai");
    OpenAIClient = new mod.default({ apiKey: OPENAI_API_KEY });
  }
} catch { /* ignore */ }

// GET /ai/insights → KPIs + (si hay key) texto de recomendaciones
router.get("/insights", authenticateToken, async (req, res) => {
  const org = (req.usuario?.organizacion_id ?? req.organizacion_id) || null;

  const out = {
    kpis: { clientes: 0, tareas: 0, proximos_7d: 0 },
    pipeline: [],
    recomendaciones: null,
    model: OpenAIClient ? (process.env.OPENAI_MODEL || "gpt-4o-mini") : null,
    source: OpenAIClient ? "openai" : "builtin",
  };

  try {
    const [c1, c2, c3, c4] = await Promise.all([
      q(`SELECT COUNT(*)::int AS c FROM clientes WHERE organizacion_id = $1`, [org]),
      q(`SELECT COUNT(*)::int AS c FROM tareas WHERE organizacion_id = $1`, [org]),
      q(
        `SELECT COUNT(*)::int AS c
           FROM tareas
          WHERE organizacion_id = $1
            AND completada = FALSE
            AND vence_en IS NOT NULL
            AND vence_en <= NOW() + INTERVAL '7 days'`,
        [org]
      ),
      q(
        `SELECT COALESCE(stage,'Uncategorized') AS stage, COUNT(*)::int AS total
           FROM clientes
          WHERE organizacion_id = $1
          GROUP BY stage
          ORDER BY total DESC`,
        [org]
      ),
    ]);

    out.kpis.clientes   = c1.rows?.[0]?.c ?? 0;
    out.kpis.tareas     = c2.rows?.[0]?.c ?? 0;
    out.kpis.proximos_7d= c3.rows?.[0]?.c ?? 0;
    out.pipeline        = c4.rows || [];

    // Baseline de reglas simples (si no hay OpenAI)
    const baseline = [];
    const leadIn = out.pipeline.find(p => p.stage === "Incoming Leads")?.total ?? 0;
    const estSent = out.pipeline.find(p => p.stage === "Bid/Estimate Sent")?.total ?? 0;
    const won = out.pipeline.find(p => p.stage === "Won")?.total ?? 0;

    if (leadIn > 0 && estSent === 0) {
      baseline.push("Tenés leads entrantes pero ningún presupuesto enviado. Priorizá calificar y enviar 3 estimaciones hoy.");
    }
    if (out.kpis.proximos_7d > 5) {
      baseline.push("Hay muchas tareas por vencer en 7 días. Reasigná due_dates o mové a 'waiting' lo que dependa de terceros.");
    }
    if (won === 0 && estSent > 0) {
      baseline.push("Hay presupuestos enviados sin cierres. Agendá follow-up por WhatsApp para 3 mejores oportunidades.");
    }
    if (!baseline.length) baseline.push("El pipeline está balanceado. Mantené el ritmo de follow-ups.");

    // Si hay OpenAI, pedimos recomendaciones con contexto
    if (OpenAIClient) {
      const prompt = [
        {
          role: "system",
          content: "Sos un analista de ventas B2B. Dás recomendaciones accionables y breves (3 bullets).",
        },
        {
          role: "user",
          content: JSON.stringify({
            kpis: out.kpis,
            pipeline: out.pipeline,
            ejemplos_reglas: baseline,
          }),
        },
      ];

      try {
        // chat.completions (v4)
        const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
        const resp = await OpenAIClient.chat.completions.create({
          model,
          temperature: 0.2,
          messages: prompt,
        });
        out.recomendaciones = resp?.choices?.[0]?.message?.content?.trim() || baseline.join("\n");
      } catch (e) {
        console.error("[/ai/insights openai]", e?.stack || e?.message || e);
        out.recomendaciones = baseline.join("\n");
      }
    } else {
      out.recomendaciones = baseline.join("\n");
    }

    res.json(out);
  } catch (e) {
    console.error("[GET /ai/insights]", e?.stack || e?.message || e);
    res.status(200).json(out); // fallback suave
  }
});

export default router;
