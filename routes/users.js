// routes/users.js — Auth + Users CRUD (multi-tenant, ESM)
import { Router } from "express";
import { authenticateToken as auth, requireRole } from "../middleware/auth.js";
import { q } from "../utils/db.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { emit as emitFlow, health as flowsHealth } from "../services/flows.client.js";
import { coreListUsers } from "../utils/core.client.js";

const router = Router();

/* -------------------- helpers -------------------- */
const T = (v) => (v == null ? null : String(v).trim() || null);
const E = (v) => (T(v)?.toLowerCase() ?? null);
const ROLES = new Set(["owner", "admin", "member"]);

// Opcional: alinear con tu middleware si seteás estos ENV
const JWT_ISSUER = process.env.JWT_ISSUER || null;
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || null;

if (!process.env.JWT_SECRET) {
  console.warn("[users] JWT_SECRET no seteado; usando valor por defecto (solo dev).");
}

function signToken(u) {
  const secret = process.env.JWT_SECRET || "dev_jwt_secret_change_me";
  const payload = {
    sub: String(u.id),
    email: u.email,
    organizacion_id: u.organizacion_id,
    rol: u.rol || "member",
  };
  const opts = { expiresIn: "30d" };
  if (JWT_ISSUER) opts.issuer = JWT_ISSUER;
  if (JWT_AUDIENCE) opts.audience = JWT_AUDIENCE;
  return jwt.sign(payload, secret, opts);
}

const safeUser = (u) =>
  u
    ? {
        id: u.id,
        email: u.email,
        nombre: u.nombre,
        rol: u.rol,
        activo: u.activo,
        organizacion_id: u.organizacion_id,
        created_at: u.created_at,
        updated_at: u.updated_at,
        last_login_at: u.last_login_at || null,
      }
    : null;

async function regclassExists(name) {
  try {
    const r = await q(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${name}`]);
    return !!r.rows?.[0]?.ok;
  } catch {
    return false;
  }
}

async function columnExists(table, column) {
  try {
    const r = await q(
      `SELECT 1
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
      [table, column]
    );
    return r.rowCount > 0;
  } catch {
    return false;
  }
}

/** org resolver (preferimos TEXT para evitar choques text=int) */
async function resolveOrgText(req) {
  const raw =
    T(req.usuario?.organizacion_id) ||
    T(req.organizacion_id) ||
    T(req.headers?.["x-org-id"]) ||
    T(req.query?.organizacion_id) ||
    T(req.query?.organization_id) ||
    T(req.query?.org_id) ||
    T(req.body?.organizacion_id) ||
    T(req.body?.organization_id) ||
    T(req.body?.org_id) ||
    null;

  if (raw != null) return String(raw);

  const email =
    E(req.body?.email) ||
    E(req.query?.email) ||
    E(req.usuario?.email) ||
    E(req.usuario_email);

  if (email) {
    const r = await q(
      `SELECT DISTINCT organizacion_id::text AS organizacion_id
         FROM public.usuarios
        WHERE lower(email)=lower($1)`,
      [email]
    );
    if (r.rowCount === 1) return String(r.rows[0]?.organizacion_id);
  }
  return null;
}

/* -------------------- schema (idempotente) -------------------- */
async function ensureSchema() {
  await q(`
    CREATE TABLE IF NOT EXISTS public.usuarios (
      id               SERIAL PRIMARY KEY,
      organizacion_id  INTEGER NOT NULL,
      email            TEXT NOT NULL,
      password_hash    TEXT NOT NULL,
      nombre           TEXT,
      rol              TEXT DEFAULT 'member',
      activo           BOOLEAN DEFAULT TRUE,
      last_login_at    TIMESTAMPTZ,
      created_at       TIMESTAMPTZ DEFAULT now(),
      updated_at       TIMESTAMPTZ DEFAULT now(),
      CHECK (rol IN ('owner','admin','member'))
    );

    ALTER TABLE public.usuarios
      ADD COLUMN IF NOT EXISTS nombre TEXT,
      ADD COLUMN IF NOT EXISTS rol TEXT DEFAULT 'member',
      ADD COLUMN IF NOT EXISTS activo BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

    CREATE INDEX IF NOT EXISTS idx_usuarios_org ON public.usuarios (organizacion_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_usuarios_org_email_lower
      ON public.usuarios (organizacion_id, lower(email));
  `);
}
ensureSchema().catch((e) => console.error("[users.ensureSchema]", e?.message || e));

/* -------------------- POST /users/register -------------------- */
router.post("/register", async (req, res) => {
  try {
    const org = await resolveOrgText(req);
    if (org == null) return res.status(400).json({ ok: false, message: "organizacion_id requerido" });

    const email = E(req.body?.email);
    const nombre = T(req.body?.nombre);
    const rol = ROLES.has((req.body?.rol || "").toLowerCase())
      ? (req.body.rol || "member").toLowerCase()
      : "member";
    const pass = T(req.body?.password);

    if (!email || !pass) return res.status(400).json({ ok: false, message: "Email y password requeridos" });
    if (pass.length < 6) return res.status(400).json({ ok: false, message: "Password mínimo 6 caracteres" });

    const exists = await q(
      `SELECT 1
         FROM public.usuarios
        WHERE organizacion_id::text = $1::text
          AND lower(email) = lower($2)`,
      [org, email]
    );
    if (exists.rowCount) {
      return res.status(409).json({ ok: false, message: "Email ya registrado en esta organización" });
    }

    const password_hash = await bcrypt.hash(pass, 10);
    const r = await q(
      `
      INSERT INTO public.usuarios (organizacion_id, email, password_hash, nombre, rol, updated_at)
      VALUES ($1::int,$2,$3,$4,$5, now())
      RETURNING *
      `,
      [Number(org), email, password_hash, nombre, rol]
    );
    const user = r.rows[0];

    // notificar flows (si existe)
    try {
      await emitFlow?.("user.created", {
        org,
        user: { id: String(user.id), email: user.email, nombre: user.nombre, rol: user.rol },
        meta: { source: "vex-core" },
      });
    } catch {}

    const token = signToken(user);
    res.status(201).json({ ok: true, token, user: safeUser(user) });
  } catch (e) {
    console.error("[POST /users/register]", e?.stack || e?.message || e);
    res.status(500).json({ ok: false, message: "Error registrando usuario" });
  }
});

/* -------------------- POST /users/login -------------------- */
router.post("/login", async (req, res) => {
  try {
    const org = await resolveOrgText(req);
    if (org == null) return res.status(400).json({ ok: false, message: "organizacion_id requerido" });

    const email = E(req.body?.email);
    const pass = T(req.body?.password);
    if (!email || !pass) return res.status(400).json({ ok: false, message: "Email y password requeridos" });

    const r = await q(
      `SELECT *
         FROM public.usuarios
        WHERE organizacion_id::text = $1::text
          AND lower(email) = lower($2)
          AND activo = TRUE`,
      [org, email]
    );
    const user = r.rows[0];
    if (!user) return res.status(401).json({ ok: false, message: "Credenciales inválidas" });

    const ok = await bcrypt.compare(pass, user.password_hash);
    if (!ok) return res.status(401).json({ ok: false, message: "Credenciales inválidas" });

    await q(
      `UPDATE public.usuarios
          SET last_login_at = now(), updated_at = now()
        WHERE id = $1`,
      [user.id]
    ).catch(() => {});

    const token = signToken(user);
    res.json({ ok: true, token, user: safeUser({ ...user, last_login_at: new Date().toISOString() }) });
  } catch (e) {
    console.error("[POST /users/login]", e?.stack || e?.message || e);
    res.status(500).json({ ok: false, message: "Error en login" });
  }
});

/* -------------------- GET /users/me -------------------- */
router.get("/me", auth, async (req, res) => {
  try {
    const org = await resolveOrgText(req);
    const id = Number(req.usuario?.id);
    if (org == null || !id) return res.json({ ok: true, user: null });

    const r = await q(
      `SELECT *
         FROM public.usuarios
        WHERE id = $1
          AND organizacion_id::text = $2::text`,
      [id, org]
    );
    res.json({ ok: true, user: safeUser(r.rows[0] || null) });
  } catch (e) {
    console.error("[GET /users/me]", e?.stack || e?.message || e);
    res.json({ ok: true, user: null });
  }
});

/* -------------------- GET /users — dropdown “Asignado a” -------------------- */
router.get("/", auth, async (req, res) => {
  try {
    const org = await resolveOrgText(req);
    if (org == null) return res.json([]);

    const search = req.query.q ? `%${String(req.query.q).trim()}%` : null;
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);

    const hasProyectos = await regclassExists("proyectos");
    const hasProyectosAssignee = hasProyectos && (await columnExists("proyectos", "assignee"));
    const hasTareas = await regclassExists("tareas");
    const hasTareasUsuarioEmail = hasTareas && (await columnExists("tareas", "usuario_email"));

    const pieces = [
      `SELECT LOWER(email) AS email
         FROM public.usuarios
        WHERE organizacion_id::text = $1::text
          AND activo = TRUE
          AND COALESCE(email,'') <> ''`,
    ];

    if (hasProyectosAssignee) {
      pieces.push(
        `SELECT LOWER(assignee) AS email
           FROM public.proyectos
          WHERE organizacion_id::text = $1::text
            AND COALESCE(assignee,'') <> ''`
      );
    }

    if (hasTareasUsuarioEmail) {
      pieces.push(
        `SELECT LOWER(usuario_email) AS email
           FROM public.tareas
          WHERE organizacion_id::text = $1::text
            AND COALESCE(usuario_email,'') <> ''`
      );
    }

    const unionSQL = `
      WITH emails AS (
        ${pieces.join("\nUNION\n")}
      )
      SELECT email,
             split_part(email,'@',1) AS nombre,
             NULL::int   AS id,
             NULL::text  AS rol,
             TRUE        AS activo,
             $1::text    AS organizacion_id,
             NULL::timestamptz AS created_at,
             NULL::timestamptz AS updated_at
        FROM emails
       WHERE ($2::text IS NULL OR email ILIKE $2::text)
       GROUP BY email
       ORDER BY 1
       LIMIT $3::int;
    `;

    const r = await q(unionSQL, [org, search, limit]);
    const base = r.rows || [];

    let coreUsers = [];
    try {
      const bearer = req.headers?.authorization || undefined;
      coreUsers = await coreListUsers(org, bearer, { allowSvcFallback: true, passOrgHeader: true });
    } catch (e) {
      console.warn("[GET /users] coreListUsers fallo:", e?.message || e);
      coreUsers = [];
    }

    const merged = new Map();
    base.forEach((u) => {
      if (!u?.email) return;
      merged.set(String(u.email).toLowerCase(), { ...u });
    });

    coreUsers.forEach((u) => {
      const email = String(u?.email || "").toLowerCase();
      if (!email) return;
      const nombre = u?.name || u?.nombre || u?.full_name || u?.display_name || email.split("@")[0];
      const prev = merged.get(email);
      if (prev) {
        if (!prev.nombre && nombre) prev.nombre = nombre;
        return;
      }
      merged.set(email, {
        email,
        nombre,
        id: u?.id ?? null,
        rol: u?.rol ?? null,
        activo: u?.activo ?? true,
        organizacion_id: String(org),
        created_at: u?.created_at ?? null,
        updated_at: u?.updated_at ?? null,
      });
    });

    return res.json(Array.from(merged.values()));
  } catch (e) {
    console.error("[GET /users]", e?.stack || e?.message || e);
    return res.json([]);
  }
});

/* -------------------- GET /users/full -------------------- */
router.get("/full", auth, async (req, res) => {
  try {
    const org = await resolveOrgText(req);
    if (org == null) return res.json([]);

    const r = await q(
      `SELECT id, email, nombre, rol, activo, organizacion_id, created_at, updated_at, last_login_at
         FROM public.usuarios
        WHERE organizacion_id::text = $1::text
        ORDER BY created_at DESC NULLS LAST, id DESC
        LIMIT 2000`,
      [org]
    );
    res.json(r.rows || []);
  } catch (e) {
    console.error("[GET /users/full]", e?.stack || e?.message || e);
    res.json([]);
  }
});

/* -------------------- GET /users/diag -------------------- */
router.get("/diag", auth, async (req, res) => {
  try {
    const org = await resolveOrgText(req);
    if (org == null) return res.json({ ok: false, message: "organizacion_id requerido" });

    const bearer = req.headers?.authorization || undefined;

    let coreUsers = [];
    let coreError = null;
    try {
      coreUsers = await coreListUsers(org, bearer, { allowSvcFallback: true, passOrgHeader: true });
    } catch (e) {
      coreError = e?.message || String(e);
      coreUsers = [];
    }

    let flows = { configured: false, base_url: null, ok: false, reason: null };
    try {
      flows = {
        configured: !!process.env.FLOWS_BASE_URL,
        base_url: process.env.FLOWS_BASE_URL || null,
        ...(await flowsHealth()),
      };
    } catch (e) {
      flows = {
        configured: !!process.env.FLOWS_BASE_URL,
        base_url: process.env.FLOWS_BASE_URL || null,
        ok: false,
        reason: e?.message || "error",
      };
    }

    let integraciones = {
      slack: { configured: false, default_channel: null, source: null },
      whatsapp: { configured: false, phone_id: null },
    };
    try {
      const rInt = await q(
        `SELECT slack_webhook_url, slack_default_channel, whatsapp_meta_token, whatsapp_phone_id
           FROM public.integraciones
          WHERE organizacion_id::text = $1::text
          LIMIT 1`,
        [org]
      );
      const row = rInt.rows?.[0] || null;
      if (row) {
        integraciones = {
          slack: {
            configured: !!row.slack_webhook_url,
            default_channel: row.slack_default_channel || null,
            source: "db",
          },
          whatsapp: {
            configured: !!row.whatsapp_meta_token,
            phone_id: row.whatsapp_phone_id || null,
          },
        };
      } else {
        const envWebhook = process.env.SLACK_WEBHOOK_URL || null;
        const envChannel = process.env.SLACK_DEFAULT_CHANNEL || process.env.SLACK_WEBHOOK_FALLBACK_CHANNEL || null;
        integraciones = {
          slack: {
            configured: !!envWebhook,
            default_channel: envChannel,
            source: envWebhook ? "env" : null,
          },
          whatsapp: {
            configured: false,
            phone_id: null,
          },
        };
      }
    } catch (e) {
      console.warn("[GET /users/diag] integraciones fallo:", e?.message || e);
    }

    const rLocal = await q(
      `SELECT email, nombre, rol, activo
         FROM public.usuarios
        WHERE organizacion_id::text = $1::text
        ORDER BY created_at DESC NULLS LAST
        LIMIT 50`,
      [org]
    );

    const rAssign = await q(
      `SELECT DISTINCT lower(usuario_email) AS email
         FROM tareas
        WHERE organizacion_id::text = $1::text
          AND COALESCE(usuario_email,'') <> ''
        LIMIT 50`,
      [org]
    ).catch(() => ({ rows: [] }));

    res.json({
      ok: true,
      org_id: String(org),
      core: {
        base_url:
          process.env.CORE_URL ||
          process.env.API_CORE_URL ||
          process.env.CORE_BASE_URL ||
          process.env.CORE_API_URL ||
          null,
        has_service_token: !!(process.env.CORE_SERVICE_TOKEN || process.env.CORE_MACHINE_TOKEN),
        count: coreUsers.length,
        sample: coreUsers.slice(0, 10),
        error: coreError,
      },
      flows,
      integraciones,
      local_users: {
        count: rLocal.rows?.length || 0,
        sample: rLocal.rows || [],
      },
      tareas_assignees: {
        count: rAssign.rows?.length || 0,
        sample: rAssign.rows || [],
      },
    });
  } catch (e) {
    console.error("[GET /users/diag]", e?.stack || e?.message || e);
    res.status(500).json({ ok: false, message: "Error en diag de usuarios" });
  }
});

/* -------------------- PATCH /users/:id -------------------- */
router.patch("/:id", auth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const org = await resolveOrgText(req);
    if (org == null) return res.status(400).json({ ok: false, message: "organizacion_id requerido" });

    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, message: "ID inválido" });

    const cur = await q(
      `SELECT id, rol, activo
         FROM public.usuarios
        WHERE id=$1 AND organizacion_id::text=$2::text`,
      [id, org]
    );
    if (!cur.rowCount) return res.status(404).json({ ok: false, message: "Usuario no encontrado" });
    const current = cur.rows[0];

    const sets = [];
    const values = [];
    let i = 1;

    if ("email" in (req.body || {})) {
      const email = E(req.body.email);
      if (!email) return res.status(400).json({ ok: false, message: "Email inválido" });
      const c = await q(
        `SELECT 1
           FROM public.usuarios
          WHERE organizacion_id::text = $1::text
            AND lower(email) = lower($2)
            AND id <> $3`,
        [org, email, id]
      );
      if (c.rowCount) return res.status(409).json({ ok: false, message: "Email ya usado en esta organización" });
      sets.push(`email = $${i++}`);
      values.push(email);
    }

    if ("nombre" in (req.body || {})) {
      sets.push(`nombre = $${i++}`);
      values.push(T(req.body.nombre));
    }

    if ("rol" in (req.body || {})) {
      const newRol = (req.body.rol || "").toLowerCase();
      if (!ROLES.has(newRol)) return res.status(400).json({ ok: false, message: "Rol inválido" });

      if (current.rol === "owner" && newRol !== "owner") {
        const owners = await q(
          `SELECT COUNT(*)::int AS n
             FROM public.usuarios
            WHERE organizacion_id::text=$1::text AND rol='owner' AND activo=TRUE`,
          [org]
        );
        if ((owners.rows?.[0]?.n ?? 0) <= 1) {
          return res.status(409).json({ ok: false, message: "No se puede remover al último owner" });
        }
      }
      sets.push(`rol = $${i++}`);
      values.push(newRol);
    }

    if ("activo" in (req.body || {})) {
      const toActive = !!req.body.activo;
      if (current.rol === "owner" && current.activo && !toActive) {
        const owners = await q(
          `SELECT COUNT(*)::int AS n
             FROM public.usuarios
            WHERE organizacion_id::text=$1::text AND rol='owner' AND activo=TRUE`,
          [org]
        );
        if ((owners.rows?.[0]?.n ?? 0) <= 1) {
          return res.status(409).json({ ok: false, message: "No se puede desactivar al último owner" });
        }
      }
      sets.push(`activo = $${i++}`);
      values.push(toActive);
    }

    if ("password" in (req.body || {})) {
      const pass = T(req.body.password);
      if (!pass || pass.length < 6) return res.status(400).json({ ok: false, message: "Password mínimo 6 caracteres" });
      const hash = await bcrypt.hash(pass, 10);
      sets.push(`password_hash = $${i++}`);
      values.push(hash);
    }

    if (!sets.length) return res.status(400).json({ ok: false, message: "Nada para actualizar" });

    sets.push("updated_at = now()");
    values.push(id, org);

    const r = await q(
      `
      UPDATE public.usuarios
         SET ${sets.join(", ")}
       WHERE id = $${i++} AND organizacion_id::text = $${i}::text
       RETURNING *
      `,
      values
    );
    if (!r.rowCount) return res.status(404).json({ ok: false, message: "Usuario no encontrado" });

    const updated = r.rows[0];
    try {
      await emitFlow?.("user.updated", {
        org,
        user: {
          id: String(updated.id),
          email: updated.email,
          nombre: updated.nombre,
          rol: updated.rol,
          activo: updated.activo,
        },
        meta: { source: "vex-core" },
      });
    } catch {}

    res.json({ ok: true, user: safeUser(updated) });
  } catch (e) {
    console.error("[PATCH /users/:id]", e?.stack || e?.message || e);
    res.status(500).json({ ok: false, message: "Error actualizando usuario" });
  }
});

/* -------------------- DELETE /users/:id (soft delete) -------------------- */
router.delete("/:id", auth, requireRole("owner", "admin"), async (req, res) => {
  try {
    const org = await resolveOrgText(req);
    if (org == null) return res.status(400).json({ ok: false, message: "organizacion_id requerido" });

    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, message: "ID inválido" });

    const cur = await q(
      `SELECT rol, activo
         FROM public.usuarios
        WHERE id=$1 AND organizacion_id::text=$2::text`,
      [id, org]
    );
    if (!cur.rowCount) return res.status(404).json({ ok: false, message: "Usuario no encontrado" });
    if (cur.rows[0].rol === "owner" && cur.rows[0].activo) {
      const owners = await q(
        `SELECT COUNT(*)::int AS n
           FROM public.usuarios
          WHERE organizacion_id::text=$1::text AND rol='owner' AND activo=TRUE`,
        [org]
      );
      if ((owners.rows?.[0]?.n ?? 0) <= 1) {
        return res.status(409).json({ ok: false, message: "No se puede eliminar al último owner" });
      }
    }

    const r = await q(
      `UPDATE public.usuarios
          SET activo = FALSE, updated_at = now()
        WHERE id = $1 AND organizacion_id::text = $2::text
      RETURNING *`,
      [id, org]
    );
    if (!r.rowCount) return res.status(404).json({ ok: false, message: "Usuario no encontrado" });

    const deleted = r.rows[0];
    try {
      await emitFlow?.("user.deleted", {
        org,
        user: { id: String(deleted.id), email: deleted.email, nombre: deleted.nombre, rol: deleted.rol },
        meta: { source: "vex-core" },
      });
    } catch {}

    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /users/:id]", e?.stack || e?.message || e);
    res.status(500).json({ ok: false, message: "Error eliminando usuario" });
  }
});

export default router;
