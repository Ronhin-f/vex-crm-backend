// routes/web.routes.js
import { Router } from "express";
import { pool, CANON_CATS } from "../utils/db.js";
import { ensureFollowupForAssignment } from "../services/followups.service.js";

const r = Router();

/* ---------------------------- helpers ---------------------------- */
const T = (v) => (v == null ? null : String(v).trim() || null);
const E = (v) => (T(v)?.toLowerCase() ?? null);
const toInt = (v) => { const n = Number(v); return Number.isInteger(n) ? n : null; };
const toISO = (v) => {
  if (!v && v !== 0) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
};
async function regclassExists(name, cx) {
  try {
    const r = await cx.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${name}`]);
    return !!r.rows?.[0]?.ok;
  } catch { return false; }
}

/* ------------------- captcha (opcional, best-effort) ------------------- */
const RECAPTCHA_SECRET = T(process.env.RECAPTCHA_SECRET);
const HCAPTCHA_SECRET  = T(process.env.HCAPTCHA_SECRET);

async function verifyCaptcha(token, provider, ip) {
  const t = T(token);
  // Si no hay secrets configuradas, no bloqueamos
  if (!RECAPTCHA_SECRET && !HCAPTCHA_SECRET) return { ok: true, note: "no_secret" };
  if (!t) return { ok: false, note: "no_token" };

  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 5000);

    if ((provider || "recaptcha").toLowerCase() === "hcaptcha" && HCAPTCHA_SECRET) {
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
      return { ok: !!data.success, note: "recaptcha", score: data.score ?? null };
    }

    clearTimeout(timeout);
    return { ok: true, note: "no_secret" };
  } catch {
    // No rompemos creación de lead por falla externa del captcha
    return { ok: true, note: "captcha_error_soft" };
  }
}

/**
 * POST /web/leads  — público, tolerante a alias
 * Body (campos tolerantes):
 * {
 *   org_id | organizacion_id: number/string (requerido),
 *   empresa|company|cliente_nombre|nombre_cliente?: string,
 *   cliente_id?: number,
 *   source|origen?: string,
 *   contacto_nombre?: string, email?: string, telefono?: string, cargo?: string, rol?: string,
 *   crear_proyecto?: boolean, proyecto_nombre?: string,
 *   notas|nota|descripcion?: string, due_date?: string(ISO), estimate_amount?: number, estimate_currency?: string,
 *   asignado_email|assignee_email?: string,
 *   link?: string,
 *   captcha_token?: string, captcha_provider?: 'recaptcha'|'hcaptcha'
 * }
 * Respuesta: { ok:true, cliente_id, contacto_id, proyecto_id, link? }
 */
r.post("/leads", async (req, res) => {
  const b = req.body || {};

  // --- Org obligatoria, normalizada a INT ---
  const orgRaw = b.organizacion_id ?? b.org_id;
  const organizacion_id = toInt(orgRaw);
  if (organizacion_id == null) {
    return res.status(400).json({ ok: false, error: "organizacion_id requerido" });
  }

  // Captcha opcional
  const cap = await verifyCaptcha(b.captcha_token, b.captcha_provider, req.ip);
  if (!cap.ok) return res.status(400).json({ ok: false, error: "captcha_failed" });

  // Normalización “suave”
  const empresa =
    T(b.empresa) ||
    T(b.company) ||
    T(b.cliente_nombre) ||
    T(b.nombre_cliente) ||
    null;

  const cliente_id_in = toInt(b.cliente_id);
  const source = T(b.source ?? b.origen) || "web";
  const asignado_email = E(b.asignado_email ?? b.assignee_email);

  const contacto_nombre = T(b.contacto_nombre);
  const email = E(b.email);
  const telefono = T(b.telefono);
  const cargo = T(b.cargo);
  const rol = T(b.rol);

  const crear_proyecto = !!b.crear_proyecto;
  const proyecto_nombre = T(b.proyecto_nombre) || (empresa ? `Lead — ${empresa}` : null);
  const notas = T(b.notas) || T(b.nota) || T(b.descripcion) || null;
  const due_date = toISO(b.due_date);
  const estimate_amount = b.estimate_amount != null ? Number(b.estimate_amount) : null;
  const estimate_currency = T(b.estimate_currency);

  // Base para deep-link: no se “adivina” si no existe
  const envBase =
    T(process.env.VEX_CRM_URL) ||
    T(process.env.VEX_CORE_URL) ||
    T(process.env.PUBLIC_BASE_URL) ||
    null;
  const bodyBase = T(b.link);
  const linkBase = (bodyBase || envBase)?.replace(/\/+$/, "") || null;

  const cx = await pool.connect();
  try {
    await cx.query("BEGIN");

    // Detectar esquema disponible
    const hasClientes  = await regclassExists("clientes", cx);
    const hasContactos = await regclassExists("contactos", cx);
    const hasProyectos = await regclassExists("proyectos", cx);

    /* 1) Resolver/crear CLIENTE (empresa) sin duplicar */
    let cliente_id = cliente_id_in;

    if (!cliente_id && hasClientes) {
      // a) por email de contacto (si hay contactos)
      if (!cliente_id && email && hasContactos) {
        const r1 = await cx.query(
          `SELECT c.id
             FROM clientes c
             JOIN contactos k ON k.cliente_id = c.id
            WHERE c.organizacion_id = $1
              AND lower(k.email) = lower($2)
            LIMIT 1`,
          [organizacion_id, email]
        );
        cliente_id = r1.rows[0]?.id ?? null;
      }

      // b) por nombre exacto de cliente
      if (!cliente_id && empresa) {
        const r2 = await cx.query(
          `SELECT id FROM clientes
            WHERE organizacion_id = $1 AND lower(nombre) = lower($2)
            LIMIT 1`,
          [organizacion_id, empresa]
        );
        cliente_id = r2.rows[0]?.id ?? null;
      }

      // c) crear si no existe
      if (!cliente_id) {
        const stage0 = Array.isArray(CANON_CATS) && CANON_CATS.length ? CANON_CATS[0] : "Incoming Leads";
        const ins = await cx.query(
          `INSERT INTO clientes
              (nombre, source, stage, categoria, usuario_email, organizacion_id, created_at, updated_at)
           VALUES ($1, $2, $3, $3, $4, $5, NOW(), NOW())
           RETURNING id`,
          [empresa || "(sin nombre)", source, stage0, asignado_email, organizacion_id]
        );
        cliente_id = ins.rows[0].id;
      }
    }

    /* 2) Crear/actualizar CONTACTO si vino info y existe tabla */
    let contacto_id = null;
    if (hasContactos && (contacto_nombre || email || telefono)) {
      // ¿ya existe ese email para este cliente?
      let exists = null;
      if (email && cliente_id) {
        const r = await cx.query(
          `SELECT id FROM contactos WHERE cliente_id=$1 AND lower(email)=lower($2) LIMIT 1`,
          [cliente_id, email]
        );
        exists = r.rows[0]?.id ?? null;
      }

      if (exists) {
        contacto_id = exists;
        await cx.query(
          `UPDATE contactos
              SET nombre     = COALESCE($2, nombre),
                  telefono   = COALESCE($3, telefono),
                  cargo      = COALESCE($4, cargo),
                  rol        = COALESCE($5, rol),
                  notas      = COALESCE($6, notas),
                  updated_at = NOW()
            WHERE id=$1`,
          [contacto_id, contacto_nombre, telefono, cargo, rol, notas]
        );
      } else {
        const es_principal =
          cliente_id
            ? !(await cx.query(`SELECT 1 FROM contactos WHERE cliente_id=$1 AND es_principal=TRUE LIMIT 1`, [cliente_id])).rowCount
            : false;

        const insC = await cx.query(
          `INSERT INTO contactos
              (cliente_id, nombre, email, telefono, cargo, rol, es_principal, notas, usuario_email, organizacion_id, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
           RETURNING id`,
          [
            cliente_id,
            contacto_nombre || empresa || "Contacto",
            email,
            telefono,
            cargo,
            rol,
            !!es_principal,
            notas,
            asignado_email,
            organizacion_id,
          ]
        );
        contacto_id = insC.rows[0].id;

        if (es_principal && cliente_id) {
          await cx.query(
            `UPDATE contactos SET es_principal=FALSE WHERE cliente_id=$1 AND id<>$2`,
            [cliente_id, contacto_id]
          );
        }
      }
    }

    /* 3) (Opcional) Crear PROYECTO si existe tabla proyectos */
    let proyecto_id = null;
    if (crear_proyecto && hasProyectos) {
      const stage0 = Array.isArray(CANON_CATS) && CANON_CATS.length ? CANON_CATS[0] : "Incoming Leads";
      const insP = await cx.query(
        `INSERT INTO proyectos
           (nombre, descripcion, cliente_id, stage, categoria,
            source, assignee, due_date, estimate_amount, estimate_currency,
            usuario_email, organizacion_id, created_at, updated_at)
         VALUES
           ($1,$2,$3,$4,$4,
            $5,$6,$7,$8,$9,
            $10,$11,NOW(),NOW())
         RETURNING id`,
        [
          proyecto_nombre || empresa || "Nuevo proyecto",
          notas,
          cliente_id || null,
          stage0,
          source,
          asignado_email,
          due_date,
          estimate_amount != null && Number.isFinite(estimate_amount) ? estimate_amount : null,
          estimate_currency,
          asignado_email,
          organizacion_id,
        ]
      );
      proyecto_id = insP.rows[0].id;
    }

    await cx.query("COMMIT");

    /* 4) Follow-up + Slack (best-effort) */
    let deepLink = null;
    if (linkBase && proyecto_id) deepLink = `${linkBase}/proyectos/${proyecto_id}`;
    else if (linkBase && cliente_id) deepLink = `${linkBase}/clientes/${cliente_id}`;

    await ensureFollowupForAssignment({
      organizacion_id,
      leadId: proyecto_id || cliente_id,
      leadNombre: proyecto_id
        ? (proyecto_nombre || empresa || contacto_nombre || "(nuevo lead)")
        : (empresa || contacto_nombre || "(nuevo lead)"),
      cliente_id: cliente_id || null,
      asignado_email: asignado_email || null,
      link: deepLink || undefined,
    }).catch(() => { /* no romper respuesta */ });

    return res.json({
      ok: true,
      cliente_id: cliente_id || null,
      contacto_id: contacto_id || null,
      proyecto_id: proyecto_id || null,
      ...(deepLink ? { link: deepLink } : {}),
      ...(cap.note ? { captcha: cap.note, score: cap.score ?? undefined } : {}),
    });
  } catch (err) {
    try { await pool.query("ROLLBACK"); } catch {}
    console.error("POST /web/leads error", err?.stack || err?.message || err);
    return res.status(500).json({ ok: false, error: "internal_error" });
  } finally {
    // si cx falló antes del connect, no tiene release
    try { r; } catch {}
  }
});

export default r;
