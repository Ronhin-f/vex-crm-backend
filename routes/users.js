// backend/routes/users.js
import { Router } from "express";
import { authenticateToken } from "../middleware/auth.js";
import { coreListUsers } from "../utils/core.client.js";
import { q } from "../utils/db.js";

const router = Router();

router.get("/", authenticateToken, async (req, res) => {
  const orgId = req.usuario?.organizacion_id ?? req.organizacion_id ?? null;
  const bearer = req.headers.authorization;

  try {
    // Desde Core
    const core = await coreListUsers(orgId, bearer);
    const fromCore = (core || [])
      .map(u => ({
        email: (u.email || u.usuario_email || "").toLowerCase(),
        name: u.name || u.nombre || u.full_name || u.email,
        slack_user_id: u.slack_id || u.slack_user_id || u.slack?.user_id || null,
      }))
      .filter(u => u.email);

    // Distinct usados en la BD (assignee/assignee_email)
    const r = await q(
      `select distinct lower(coalesce(assignee, assignee_email)) as email
         from proyectos
        ${orgId ? "where organizacion_id = $1" : ""}
        order by 1 limit 200`,
      orgId ? [orgId] : []
    );
    const fromDb = (r.rows || []).map(x => ({ email: x.email, name: x.email, slack_user_id: null }));

    // Merge (Core tiene prioridad)
    const map = new Map();
    [...fromCore, ...fromDb].forEach(u => {
      if (u?.email) map.set(u.email, u);
    });

    res.json({ ok: true, items: Array.from(map.values()) });
  } catch (e) {
    console.error("[GET /users]", e?.message || e);
    res.json({ ok: true, items: [] });
  }
});

export default router;
