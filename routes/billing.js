import { Router } from "express";
import { authenticateToken } from "../middleware/auth.js";
import { getOrgId } from "../utils/org.js";
import { q } from "../utils/db.js";

const router = Router();

router.get("/api/billing/invoices", authenticateToken, async (req, res) => {
  try {
    const org = getOrgId(req);
    const has = await q(`SELECT to_regclass('public.invoices') IS NOT NULL AS ok`);
    if (!has.rows?.[0]?.ok) return res.json({ items: [], total: 0, page: 1, pageSize: 20 });
    // TODO: implementar filtros reales. Por ahora: primeras 50, sin 500.
    const r = await q(
      `SELECT id, number, issue_date, due_date, status, amount_total, amount_paid
         FROM public.invoices
        WHERE organizacion_id = $1
        ORDER BY issue_date DESC NULLS LAST
        LIMIT 50`, [org]
    );
    res.json({ items: r.rows || [], total: r.rowCount || 0, page: 1, pageSize: 50 });
  } catch (e) {
    console.error("[GET /api/billing/invoices]", e?.message || e);
    res.json({ items: [], total: 0, page: 1, pageSize: 20 });
  }
});

export default router;
