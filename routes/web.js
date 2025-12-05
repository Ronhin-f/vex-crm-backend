// routes/web.js
import { Router } from "express";
import { q, CANON_CATS, pipelineForOrg } from "../utils/db.js";
import { ensureFollowupForAssignment } from "../services/followups.service.js";

const router = Router();

/* ---------------------------- helpers ---------------------------- */
const T = (v) => (v == null ? null : String(v).trim() || null);
const E = (v) => (T(v)?.toLowerCase() ?? null);
const toInt = (v) => { const n = Number(v); return Number.isInteger(n) ? n : null; };

async function regclassExists(name) {
  try {
    const r = await q(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${name}`]);
    return !!r.rows?.[0]?.ok;
  } catch {
    return false;
  }
}

/** Construye link solo si hay base conocida o fue provisto. No hardcodea host. */
function buildLeadLink(leadId, explicitLink) {
  const given = T(explicitLink);
  if (given) return given;

  const bases = [
    T(process.env.VEX_CRM_URL),
    T(process.env.VEX_CORE_URL),
    T(process.env.PUBLIC_BASE_URL),
  ].filter(Boolean);

  if (!bases.length) return null; // sin base → no adivino
  const base = bases[0].replace(/\/+$/, "");
  return `${base}/proyectos/${leadId}`;
}

/* ------------------- captcha (opcional, best-effort) ------------------- */
const RECAPTCHA_SECRET = T(process.env.RECAPTCHA_SECRET);
const HCAPTCHA_SECRET  = T(process.env.HCAPTCHA_SECRET);

async function verifyCaptcha(token, provider, ip) {
  const t = T(token);
  if (!t) return { ok: !RECAPTCHA_SECRET && !HCAPTCHA_SECRET, note: "no_token" }; // si no hay secrets, permitir
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 5000);

    if (provider === "hcaptcha" && HCAPTCHA_SECRET) {
      const body = new URLSearchParams({ secret: HCAPTCHA_SECRET, response: t, remoteip: ip || "" });
      const r = await fetch("https://hcaptcha.com/siteverify", { method: "POST", body, signal: ctrl.signal });
      clearTimeout(timeout);
      const data = await r.json().catch(() => ({}));
      return { ok: !!data.success, note: "hcaptcha", score: null };
    }

    if (RECAPTCHA_SECRET) {
      const body = new URLSearchParams({ secret: RECAPTCHA_SECRET, response: t, remoteip: ip || "" });
      const r = await fetch("https://www.google.com/recaptcha/api/siteverify", { method: "POST", body, signal: ctrl.signal });
      clearTimeout(timeout);
      const data = await r.json().catch(() => ({}));
      // Para v3, podés chequear score >= 0.5 si querés endurecer
      return { ok: !!data.success, note: "recaptcha", score: data.score ?? null };
    }

    clearTimeout(timeout);
    return { ok: true, note: "no_secret" };
  } catch (e) {
    return { ok: true, note: "captcha_error_soft" }; // no bloqueamos por error externo
  }
}

/**
 * POST /web/leads (público)
 * Body: {
 *  email, nombre, telefono, nota|mensaje, source|origen='web',
 *  organizacion_id, asignado_email|assignee_email, cliente_id?, link?,
 *  captcha_token?, captcha_provider? ('recaptcha'|'hcaptcha')
 * }
 */
router.post("/leads", async (req, res) => {
  try {
    const {
      email,
      nombre,
      telefono,
      nota,
      mensaje,
      source,
      origen,
      organizacion_id,
      asignado_email,
      assignee_email,
      cliente_id,
      link,
      captcha_token,
      captcha_provider
    } = req.body || {};

    const orgId = toInt(organizacion_id);
    if (orgId == null) {
      return res.status(400).json({ ok: false, error: "organizacion_id requerido" });
    }
    if (!T(nombre)) {
      return res.status(400).json({ ok: false, error: "nombre requerido" });
    }

    // Captcha opcional (si hay secrets configuradas)
    const cap = await verifyCaptcha(captcha_token, (captcha_provider || "recaptcha").toLowerCase(), req.ip);
    if (!cap.ok) {
      return res.status(400).json({ ok: false, error: "captcha_failed" });
    }

    const assignee = E(asignado_email ?? assignee_email); // puede ser null
    const desc = T(nota) ?? T(mensaje);
    const src = T(source ?? origen) || "web";
    const mail = E(email);
    const tel = T(telefono);

    /* 1) Resolver/crear cliente si no vino */
    let cid = toInt(cliente_id);
    const hasClientes = await regclassExists("clientes");

    if (!cid && hasClientes) {
      if (mail) {
        // Reusar por email dentro de la org
        const existing = await q(
          `SELECT id FROM clientes WHERE organizacion_id=$1 AND lower(email)=lower($2) LIMIT 1`,
          [orgId, mail]
        );
        if (existing.rowCount) {
          cid = existing.rows[0].id;
        }
      }
      if (!cid) {
        const insCli = await q(
          `INSERT INTO clientes (nombre, email, telefono, source, usuario_email, organizacion_id, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6, NOW(), NOW())
           RETURNING id`,
          [T(nombre), mail, tel, src, assignee, orgId]
        );
        cid = insCli.rows?.[0]?.id ?? null;
      }
    }

    /* 2) Crear lead en proyectos (stage/categoria alineadas) */
    const pipeline = await pipelineForOrg(orgId);
    const stage = (Array.isArray(pipeline) && pipeline[0]) ? pipeline[0] : "Incoming Leads";

    const insLead = await q(
      `INSERT INTO proyectos
         (nombre, descripcion, cliente_id, stage, categoria, source, assignee, usuario_email, organizacion_id, created_at, updated_at)
       VALUES
         ($1,    $2,          $3,         $4,    $4,        $5,     $6,       $6,            $7,              NOW(),   NOW())
       RETURNING id`,
      [T(nombre), desc, cid, stage, src, assignee, orgId]
    );
    const leadId = insLead.rows[0].id;

    /* 3) Link sin adivinar host */
    const viewLink = buildLeadLink(leadId, link);

    /* 4) Follow-up + recordatorio + Slack (best-effort) */
    await ensureFollowupForAssignment({
      organizacion_id: orgId,
      leadId,
      leadNombre: nombre,
      cliente_id: cid || null,
      asignado_email: assignee || null,
      link: viewLink, // puede ser null; no rompemos nada
    }).catch(() => { /* no romper respuesta */ });

    return res.status(201).json({
      ok: true,
      leadId,
      cliente_id: cid || null,
      link: viewLink,
      ...(cap.note ? { captcha: cap.note, score: cap.score ?? undefined } : {})
    });
  } catch (e) {
    console.error("POST /web/leads error:", e?.stack || e?.message || e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

export default router;
