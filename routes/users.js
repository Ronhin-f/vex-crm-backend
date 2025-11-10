// routes/users.js — Auth + Users CRUD (multi-tenant, ESM)
import { Router } from "express";
import { authenticateToken as auth } from "../middleware/auth.js";
import { q } from "../utils/db.js";
import axios from "axios";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const router = Router();

/* -------------------- helpers -------------------- */
const T = (v) => (v == null ? null : String(v).trim() || null);
const E = (v) => (T(v)?.toLowerCase() ?? null); // email normalizado
const ROLES = new Set(["owner", "admin", "member"]);

if (!process.env.JWT_SECRET) {
  console.warn("[users] JWT_SECRET no seteado; usando valor por defecto (solo dev).");
}

function signToken(u) {
  const secret = process.env.JWT_SECRET || "dev_jwt_secret_change_me";
  return jwt.sign(
    {
      sub: String(u.id),
      email: u.email,
      organizacion_id: u.organizacion_id,
      rol: u.rol || "member",
    },
    secret,
    { expiresIn: "30d" }
  );
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
      }
    : null;

function assertRole(req, res, roles = ["owner", "admin"]) {
  const rol = req.usuario?.rol || "member";
  if (!roles.includes(rol)) {
    res.status(403).json({ ok: false, message: "Permisos insuficientes" });
    return false;
  }
  return true;
}

// opcional: enviar a Flows si está configurado
async function emitFlow(type, payload) {
  const base = process.env.FLOWS_BASE_URL;
  const token = process.env.FLOWS_BEARER;
  if (!base || !token) return;
  try {
    await axios.post(
      `${base.replace(/\/+$/, "")}/api/triggers/emit`,
      { type, payload },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }
    );
  } catch (e) {
    console.warn("[users.emitFlow]", e?.message || e);
  }
}

async function regclassExists(name) {
  try {
    const r = await q(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${name}`]);
    return !!r.rows?.[0]?.ok;
  } catch {
    return false;
  }
}

/** org resolver: JWT → header → query/body → lookup por email (único) → null */
async function resolveOrgId(req) {
  const raw =
    T(req.usuario?.organizacion_id) ||
    T(req.headers?.["x-org-id"]) ||
    T(req.query?.organizacion_id) ||
    T(req.query?.organization_id) ||
    T(req.query?.org_id) ||
    T(req.body?.organizacion_id) ||
    T(req.body?.organization_id) ||
    T(req.body?.org_id) ||
    null;

  if (raw != null) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  // Lookup por email solo si es único (para mejorar UX de login)
  const email =
    E(req.body?.email) ||
    E(req.query?.email) ||
    E(req.usuario?.email) ||
    E(req.usuario_email);

  if (email) {
    const r = await q(
      `SELECT DISTINCT organizacion_id FROM public.usuarios WHERE lower(email)=lower($1)`,
      [email]
    );
    if (r.rowCount === 1) {
      const n = Number(r.rows[0]?.organizacion_id);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

/* -------------------- schema (idempotente) -------------------- */
/** Hace el schema resiliente aunque la migración no haya corrido todavía */
async function ensureSchema() {
  await q(`
    -- tabla base (sólo si NO existe)
    CREATE TABLE IF NOT EXISTS public.usuarios (
      id               SERIAL PRIMARY KEY,
      organizacion_id  INTEGER NOT NULL,
      email            TEXT NOT NULL,
      password_hash    TEXT NOT NULL,
      nombre           TEXT,
      rol              TEXT DEFAULT 'member',
      activo           BOOLEAN DEFAULT TRUE,
      created_at       TIMESTAMPTZ DEFAULT now(),
      updated_at       TIMESTAMPTZ DEFAULT now(),
      CHECK (rol IN ('owner','admin','member'))
    );

    -- columnas por compatibilidad (si existía con esquema viejo)
    ALTER TABLE public.usuarios
      ADD COLUMN IF NOT EXISTS nombre TEXT,
      ADD COLUMN IF NOT EXISTS rol TEXT DEFAULT 'member',
      ADD COLUMN IF NOT EXISTS activo BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

    -- índices/unique multi-tenant con email normalizado
    CREATE INDEX IF NOT EXISTS idx_usuarios_org ON public.usuarios (organizacion_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_usuarios_org_email_lower
      ON public.usuarios (organizacion_id, lower(email));
  `);
}
ensureSchema().catch((e) => console.error("[users.ensureSchema]", e?.message || e));

/* -------------------- POST /users/register -------------------- */
router.post("/register", async (req, res) => {
  try {
    const org = await resolveOrgId(req);
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
      `SELECT 1 FROM public.usuarios WHERE organizacion_id = $1 AND lower(email) = lower($2)`,
      [org, email]
    );
    if (exists.rowCount) {
      return res.status(409).json({ ok: false, message: "Email ya registrado en esta organización" });
    }

    const password_hash = await bcrypt.hash(pass, 10);
    const r = await q(
      `
      INSERT INTO public.usuarios (organizacion_id, email, password_hash, nombre, rol, updated_at)
      VALUES ($1,$2,$3,$4,$5, now())
      RETURNING *
      `,
      [org, email, password_hash, nombre, rol]
    );
    const user = r.rows[0];

    emitFlow("user.created", {
      org,
      user: { id: String(user.id), email: user.email, nombre: user.nombre, rol: user.rol },
      meta: { source: "vex-core" },
    }).catch(() => {});

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
    const org = await resolveOrgId(req);
    if (org == null) return res.status(400).json({ ok: false, message: "organizacion_id requerido" });

    const email = E(req.body?.email);
    const pass = T(req.body?.password);
    if (!email || !pass) return res.status(400).json({ ok: false, message: "Email y password requeridos" });

    const r = await q(
      `SELECT * FROM public.usuarios WHERE organizacion_id = $1 AND lower(email) = lower($2) AND activo = TRUE`,
      [org, email]
    );
    const user = r.rows[0];
    if (!user) return res.status(401).json({ ok: false, message: "Credenciales inválidas" });

    const ok = await bcrypt.compare(pass, user.password_hash);
    if (!ok) return res.status(401).json({ ok: false, message: "Credenciales inválidas" });

    const token = signToken(user);
    res.json({ ok: true, token, user: safeUser(user) });
  } catch (e) {
    console.error("[POST /users/login]", e?.stack || e?.message || e);
    res.status(500).json({ ok: false, message: "Error en login" });
  }
});

/* -------------------- GET /users/me -------------------- */
router.get("/me", auth, async (req, res) => {
  try {
    const org = await resolveOrgId(req);
    const id = Number(req.usuario?.id);
    if (org == null || !id) return res.json({ ok: true, user: null });

    const r = await q(`SELECT * FROM public.usuarios WHERE id = $1 AND organizacion_id = $2`, [id, org]);
    res.json({ ok: true, user: safeUser(r.rows[0] || null) });
  } catch (e) {
    console.error("[GET /users/me]", e?.stack || e?.message || e);
    res.json({ ok: true, user: null });
  }
});

/* ------------------------------------------------------------------
 * GET /users  —  Lista para dropdown "Asignado a"
 * Devuelve emails deduplicados desde usuarios y (si existen) proyectos.assignee y tareas.assignee
 * Acepta ?q= (search) y ?limit= (por defecto 50, máx 200)
 * ------------------------------------------------------------------ */
router.get("/", auth, async (req, res) => {
  try {
    const org = await resolveOrgId(req);
    if (org == null) return res.json([]);

    const search = req.query.q ? `%${String(req.query.q).trim()}%` : null;
    const limit = Math.min(Number(req.query.limit ?? 50), 200);

    const hasProyectos = await regclassExists("proyectos");
    const hasTareas = await regclassExists("tareas");

    const pieces = [
      `SELECT LOWER(email) AS email FROM public.usuarios WHERE organizacion_id = $1`,
    ];
    if (hasProyectos)
      pieces.push(
        `SELECT LOWER(assignee) AS email FROM public.proyectos WHERE organizacion_id = $1 AND COALESCE(assignee,'') <> ''`
      );
    if (hasTareas)
      pieces.push(
        `SELECT LOWER(assignee) AS email FROM public.tareas WHERE organizacion_id = $1 AND COALESCE(assignee,'') <> ''`
      );

    const unionSQL = `
      WITH emails AS (
        ${pieces.join("\nUNION\n")}
      )
      SELECT email,
             split_part(email,'@',1) AS nombre,
             NULL::int AS id,
             NULL::text AS rol,
             TRUE AS activo,
             $1::int AS organizacion_id,
             NULL::timestamptz AS created_at,
             NULL::timestamptz AS updated_at
        FROM emails
       WHERE ($2::text IS NULL OR email ILIKE $2)
       GROUP BY email
       ORDER BY 1
       LIMIT $3;
    `;

    const r = await q(unionSQL, [org, search, limit]);
    return res.json(r.rows || []);
  } catch (e) {
    console.error("[GET /users]", e?.stack || e?.message || e);
    return res.json([]);
  }
});

/* -------------------- GET /users/full (listado clásico por org) -------------------- */
router.get("/full", auth, async (req, res) => {
  try {
    const org = await resolveOrgId(req);
    if (org == null) return res.json([]);

    const r = await q(
      `SELECT id, email, nombre, rol, activo, organizacion_id, created_at, updated_at
         FROM public.usuarios
        WHERE organizacion_id = $1
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

/* -------------------- PATCH /users/:id -------------------- */
router.patch("/:id", auth, async (req, res) => {
  try {
    const org = await resolveOrgId(req);
    if (org == null) return res.status(400).json({ ok: false, message: "organizacion_id requerido" });
    if (!assertRole(req, res)) return;

    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, message: "ID inválido" });

    // Traigo usuario actual para checks (rol actual)
    const cur = await q(
      `SELECT id, rol, activo FROM public.usuarios WHERE id=$1 AND organizacion_id=$2`,
      [id, org]
    );
    if (!cur.rowCount) return res.status(404).json({ ok: false, message: "Usuario no encontrado" });
    const current = cur.rows[0];

    const sets = [];
    const values = [];
    let i = 1;

    const wantEmail = req.body?.email;
    if (wantEmail != null) {
      const email = E(wantEmail);
      if (!email) return res.status(400).json({ ok: false, message: "Email inválido" });
      // conflict check
      const c = await q(
        `SELECT 1 FROM public.usuarios WHERE organizacion_id = $1 AND lower(email) = lower($2) AND id <> $3`,
        [org, email, id]
      );
      if (c.rowCount) return res.status(409).json({ ok: false, message: "Email ya usado en esta organización" });
      sets.push(`email = $${i++}`);
      values.push(email);
    }

    if (req.body?.nombre != null) {
      sets.push(`nombre = $${i++}`);
      values.push(T(req.body.nombre));
    }

    if (req.body?.rol != null) {
      const newRol = (req.body.rol || "").toLowerCase();
      if (!ROLES.has(newRol)) return res.status(400).json({ ok: false, message: "Rol inválido" });

      // Protección: no dejar la org sin owners
      if (current.rol === "owner" && newRol !== "owner") {
        const owners = await q(
          `SELECT COUNT(*)::int AS n FROM public.usuarios WHERE organizacion_id=$1 AND rol='owner' AND activo=TRUE`,
          [org]
        );
        if ((owners.rows?.[0]?.n ?? 0) <= 1) {
          return res.status(409).json({ ok: false, message: "No se puede remover al último owner" });
        }
      }
      sets.push(`rol = $${i++}`);
      values.push(newRol);
    }

    if (req.body?.activo != null) {
      const toActive = !!req.body.activo;
      // si desactivamos un owner y es el último → bloquear
      if (current.rol === "owner" && current.activo && !toActive) {
        const owners = await q(
          `SELECT COUNT(*)::int AS n FROM public.usuarios WHERE organizacion_id=$1 AND rol='owner' AND activo=TRUE`,
          [org]
        );
        if ((owners.rows?.[0]?.n ?? 0) <= 1) {
          return res.status(409).json({ ok: false, message: "No se puede desactivar al último owner" });
        }
      }
      sets.push(`activo = $${i++}`);
      values.push(toActive);
    }

    if (req.body?.password != null) {
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
       WHERE id = $${i++} AND organizacion_id = $${i}
       RETURNING *
      `,
      values
    );
    if (!r.rowCount) return res.status(404).json({ ok: false, message: "Usuario no encontrado" });

    const updated = r.rows[0];
    emitFlow("user.updated", {
      org,
      user: {
        id: String(updated.id),
        email: updated.email,
        nombre: updated.nombre,
        rol: updated.rol,
        activo: updated.activo,
      },
      meta: { source: "vex-core" },
    }).catch(() => {});

    res.json({ ok: true, user: safeUser(updated) });
  } catch (e) {
    console.error("[PATCH /users/:id]", e?.stack || e?.message || e);
    res.status(500).json({ ok: false, message: "Error actualizando usuario" });
  }
});

/* -------------------- DELETE /users/:id (soft delete) -------------------- */
router.delete("/:id", auth, async (req, res) => {
  try {
    const org = await resolveOrgId(req);
    if (org == null) return res.status(400).json({ ok: false, message: "organizacion_id requerido" });
    if (!assertRole(req, res)) return;

    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, message: "ID inválido" });

    // Si es owner, evitar borrar el último
    const cur = await q(
      `SELECT rol, activo FROM public.usuarios WHERE id=$1 AND organizacion_id=$2`,
      [id, org]
    );
    if (!cur.rowCount) return res.status(404).json({ ok: false, message: "Usuario no encontrado" });
    if (cur.rows[0].rol === "owner" && cur.rows[0].activo) {
      const owners = await q(
        `SELECT COUNT(*)::int AS n FROM public.usuarios WHERE organizacion_id=$1 AND rol='owner' AND activo=TRUE`,
        [org]
      );
      if ((owners.rows?.[0]?.n ?? 0) <= 1) {
        return res.status(409).json({ ok: false, message: "No se puede eliminar al último owner" });
      }
    }

    const r = await q(
      `UPDATE public.usuarios SET activo = FALSE, updated_at = now() WHERE id = $1 AND organizacion_id = $2 RETURNING *`,
      [id, org]
    );
    if (!r.rowCount) return res.status(404).json({ ok: false, message: "Usuario no encontrado" });

    const deleted = r.rows[0];
    emitFlow("user.deleted", {
      org,
      user: { id: String(deleted.id), email: deleted.email, nombre: deleted.nombre, rol: deleted.rol },
      meta: { source: "vex-core" },
    }).catch(() => {});

    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /users/:id]", e?.stack || e?.message || e);
    res.status(500).json({ ok: false, message: "Error eliminando usuario" });
  }
});

export default router;
