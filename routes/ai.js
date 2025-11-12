// routes/ai.js — Insights + baseline IA (multi-tenant TEXT)
import { Router } from "express";
import { q } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";
import { getOrgText } from "../utils/org.js";

const router = Router();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
let OpenAIClient = null;

// Carga perezosa: si no hay key o lib, no rompe
try {
  if (OPENAI_API_KEY) {
    const mod = await import("openai");
    OpenAIClient = new mod.default({ apiKey: OPENAI_API_KEY });
  }
} catch { /* ignore */ }

// GET /ai/insights → KPIs + (si hay key) texto de recomendaciones
router.get("/insights", authenticateToken, async (req, res) => {
  let org;
  try {
    org = getOrgText(req); // siempre TEXT, admite token/header/query/body
  } catch {
    return res.status(400).json({ error: "organizacion_id requerido" });
  }

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
      q(`SELECT COUNT(*)::int AS c FROM tareas   WHERE organizacion_id = $1`, [org]),
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

    out.kpis.clientes    = c1.rows?.[0]?.c ?? 0;
    out.kpis.tareas      = c2.rows?.[0]?.c ?? 0;
    out.kpis.proximos_7d = c3.rows?.[0]?.c ?? 0;
    out.pipeline         = c4.rows || [];

    // Baseline de reglas simples (si no hay OpenAI)
    const baseline = [];
    const findStage = (name) => out.pipeline.find(p => (p.stage || "").toLowerCase() === name.toLowerCase())?.total ?? 0;
    const leadIn  = findStage("Incoming Leads");
    const estSent = findStage("Bid/Estimate Sent");
    const won     = findStage("Won");

    if (leadIn > 0 && estSent === 0) {
      baseline.push("Tenés leads entrantes pero ningún presupuesto enviado. Priorizá calificar y enviar 3 estimaciones hoy.");
    }
    if (out.kpis.proximos_7d > 5) {
      baseline.push("Hay muchas tareas por vencer en 7 días. Reasigná due_dates o mové a 'waiting' lo que dependa de terceros.");
    }
    if (won === 0 && estSent > 0) {
      baseline.push("Hay presupuestos enviados sin cierres. Agendá follow-up por WhatsApp para 3 mejores oportunidades.");
    }
    if (!baseline.length) baseline.push("Pipeline razonable. Mantené frecuencia de follow-ups y cuidá los próximos 7 días.");

    // OpenAI opcional
    if (OpenAIClient) {
      try {
        const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
        const prompt = [
          { role: "system", content: "Sos un analista de ventas B2B. Respuestas en 3 bullets, concretas y accionables." },
          { role: "user", content: JSON.stringify({ kpis: out.kpis, pipeline: out.pipeline, ejemplos_reglas: baseline }) },
        ];
        const resp = await OpenAIClient.chat.completions.create({
          model,
          temperature: 0.2,
          messages: prompt,
        });
        out.recomendaciones = resp?.choices?.[0]?.message?.content?.trim() || baseline.join("\n");
      } catch (e) {
        console.error("[/ai/insights openai]", e?.message || e);
        out.recomendaciones = baseline.join("\n");
      }
    } else {
      out.recomendaciones = baseline.join("\n");
    }

    res.json(out);
  } catch (e) {
    console.error("[GET /ai/insights]", e?.message || e);
    // devolvemos baseline parcial para no romper dashboard
    res.status(200).json(out);
  }
});

export default router;
