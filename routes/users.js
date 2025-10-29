// backend/routes/users.js
import { Router } from "express";
import { authenticateToken } from "../middleware/auth.js";
import { coreListUsers } from "../utils/core.client.js";
import { q } from "../utils/db.js";

const router = Router();

/**
 * GET /users
 * Devuelve lista unificada de usuarios (Core + “usados” en BD).
 * Soporta:
 *   - ?q=<texto> para filtrar por email/nombre (case-insensitive)
 *   - encabezado Authorization: Bearer <token> para consultar Core
 *   - orgId se toma de req.usuario.organizacion_id (JWT) si existe
 *
 * Respuesta: { ok: true, items: [{ email, name, slack_user_id }] }
 */
router.get("/", authenticateToken, async (req, res) => {
  // org desde JWT o cabeceras previas de middlewares
  const orgIdRaw =
    req.usuario?.organizacion_id ?? req.organizacion_id ?? null;
  const orgId =
    orgIdRaw === null || orgIdRaw === undefined
      ? null
      : Number.isNaN(Number(orgIdRaw))
        ? null
        : Number(orgIdRaw);

  const bearer = req.headers.authorization; // se pasa tal cual a Core
  const search = (req.query.q || "").toString().trim();
  const like = search ? `%${search}%` : null;
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);

  try {
    /* ===========================
     * 1) Usuarios desde Core
     * =========================== */
    let fromCore = [];
    try {
      const core = await coreListUsers(orgId, bearer);
      fromCore = (core || [])
        .map((u) => {
          const email =
            (u.email || u.usuario_email || "").toString().trim().toLowerCase();
          if (!email) return null;

          // Nombre “usable”
          const name =
            u.name ||
            u.nombre ||
            u.full_name ||
            u.display_name ||
            u.email ||
            email;

          // Slack: varios campos posibles
          const slack_user_id =
            u.slack_id ||
            u.slack_user_id ||
            (u.slack && (u.slack.user_id || u.slack.id)) ||
            null;

          return { email, name, slack_user_id };
        })
        .filter(Boolean);

      // Filtro local opcional por ?q=
      if (like) {
        const s = search.toLowerCase();
        fromCore = fromCore.filter(
          (u) =>
            u.email.includes(s) ||
            (u.name || "").toString().toLowerCase().includes(s)
        );
      }
    } catch (e) {
      // Si Core falla, seguimos solo con BD (no cortamos la respuesta)
      console.warn("[/users] Core falló:", e?.message || e);
    }

    /* ===========================
     * 2) Correos “usados” en la BD
     * =========================== */
    const sql = `
      SELECT DISTINCT LOWER(COALESCE(assignee_email, assignee)) AS email
      FROM public.proyectos
      WHERE ($1::int IS NULL OR organizacion_id = $1)
        AND (
          $2::text IS NULL
          OR COALESCE(assignee,'') ILIKE $2
          OR COALESCE(assignee_email,'') ILIKE $2
        )
      ORDER BY 1
      LIMIT $3
    `;
    const dbParams = [orgId, like, limit];
    const r = await q(sql, dbParams);

    const fromDb = (r.rows || [])
      .map((x) => {
        const email = (x.email || "").toString().trim();
        if (!email) return null;
        return {
          email,
          // si no tenemos nombre real, usamos el email
          name: email,
          slack_user_id: null,
        };
      })
      .filter(Boolean);

    /* ===========================
     * 3) Merge con prioridad real para Core
     *    (primero BD, luego Core sobreescribe)
     * =========================== */
    const map = new Map();
    // Primero DB (fallback)
    for (const u of fromDb) {
      if (u?.email) map.set(u.email, u);
    }
    // Luego Core (prioridad)
    for (const u of fromCore) {
      if (u?.email) map.set(u.email, u);
    }

    const items = Array.from(map.values());
    return res.json({ ok: true, items });
  } catch (e) {
    console.error("[GET /users] Error:", e?.stack || e?.message || e);
    // Mantenemos { ok: true, items: [] } para no romper el front
    return res.json({ ok: true, items: [] });
  }
});

export default router;
