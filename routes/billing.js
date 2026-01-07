import { Router } from "express";
import { authenticateToken } from "../middleware/auth.js";
import { getOrgText } from "../utils/org.js";
import { q } from "../utils/db.js";

const router = Router();

function requireOrg(req, res) {
  const org = getOrgText(req, { require: false });
  if (!org) {
    res.status(400).json({ error: "organizacion_id requerido" });
    return null;
  }
  return String(org);
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function mapInvoiceRow(row) {
  const total = toNum(row.amount_total);
  return {
    id: row.id,
    number: row.number || "",
    date: row.issue_date ? String(row.issue_date) : "",
    dueDate: row.due_date ? String(row.due_date) : "",
    status: row.status,
    total,
    paid: toNum(row.amount_paid),
    type: "",
    party: row.client_name || "",
    client_id: row.client_id,
  };
}

router.get("/invoices", authenticateToken, async (req, res) => {
  try {
    const org = requireOrg(req, res);
    if (!org) return;
    const has = await q(`SELECT to_regclass('public.invoices') IS NOT NULL AS ok`);
    if (!has.rows?.[0]?.ok) {
      return res.json({ rows: [], total: 0, page: 1, pageSize: 20 });
    }
    // TODO: implementar filtros reales. Por ahora: primeras 50, sin 500.
    const r = await q(
      `SELECT i.id, i.number, i.issue_date, i.due_date, i.status,
              i.amount_total, i.amount_paid, i.client_id,
              c.nombre AS client_name
         FROM public.invoices i
         LEFT JOIN public.clientes c ON c.id = i.client_id
        WHERE i.organizacion_id = $1
        ORDER BY i.issue_date DESC NULLS LAST
        LIMIT 50`,
      [org]
    );
    res.json({
      rows: (r.rows || []).map(mapInvoiceRow),
      total: r.rowCount || 0,
      page: 1,
      pageSize: 50,
    });
  } catch (e) {
    console.error("[GET /api/billing/invoices]", e?.message || e);
    res.json({ rows: [], total: 0, page: 1, pageSize: 20 });
  }
});

router.post("/invoices", authenticateToken, async (req, res) => {
  try {
    const org = requireOrg(req, res);
    if (!org) return;

    const b = req.body || {};
    const clientId = Number(b.client_id);
    if (!Number.isInteger(clientId) || clientId <= 0) {
      return res.status(400).json({ error: "client_id requerido" });
    }

    const issueDate = b.date || b.issue_date || new Date().toISOString().slice(0, 10);
    const dueDate = b.dueDate || b.due_date || issueDate;
    const status = b.status || "draft";

    const r = await q(
      `INSERT INTO public.invoices
        (id, organizacion_id, client_id, number, issue_date, due_date, currency,
         amount_subtotal, amount_tax, amount_total, amount_paid, status, notes)
       VALUES
        (gen_random_uuid(), $1, $2, $3, $4, $5, COALESCE($6,'USD'),
         $7, $8, $9, COALESCE($10,0), $11, $12)
       RETURNING *`,
      [
        org,
        clientId,
        b.number || null,
        issueDate,
        dueDate,
        b.currency || "USD",
        toNum(b.amount_subtotal),
        toNum(b.amount_tax),
        toNum(b.amount_total),
        toNum(b.amount_paid),
        status,
        b.notes || null,
      ]
    );

    const row = r.rows?.[0];
    return res.status(201).json(row ? mapInvoiceRow(row) : {});
  } catch (e) {
    console.error("[POST /api/billing/invoices]", e?.message || e);
    return res.status(500).json({ error: "error_creating_invoice" });
  }
});

router.patch("/invoices/:id/paid", authenticateToken, async (req, res) => {
  try {
    const org = requireOrg(req, res);
    if (!org) return;

    const { id } = req.params;
    const r = await q(
      `UPDATE public.invoices
          SET amount_paid = amount_total,
              status = 'paid',
              updated_at = NOW()
        WHERE id = $1 AND organizacion_id = $2
        RETURNING *`,
      [id, org]
    );
    if (!r.rowCount) return res.status(404).json({ error: "invoice_not_found" });
    return res.json(mapInvoiceRow(r.rows[0]));
  } catch (e) {
    console.error("[PATCH /api/billing/invoices/:id/paid]", e?.message || e);
    return res.status(500).json({ error: "error_updating_invoice" });
  }
});

router.patch("/invoices/:id", authenticateToken, async (req, res) => {
  try {
    const org = requireOrg(req, res);
    if (!org) return;

    const { id } = req.params;
    const b = req.body || {};
    const sets = [];
    const vals = [];

    if ("client_id" in b) {
      const clientId = Number(b.client_id);
      if (!Number.isInteger(clientId) || clientId <= 0) {
        return res.status(400).json({ error: "client_id invalido" });
      }
      sets.push(`client_id = $${vals.length + 1}`);
      vals.push(clientId);
    }

    if ("number" in b) {
      sets.push(`number = $${vals.length + 1}`);
      vals.push(b.number || null);
    }

    const issueDate = b.issue_date || b.date;
    if ("issue_date" in b || "date" in b) {
      sets.push(`issue_date = $${vals.length + 1}`);
      vals.push(issueDate || null);
    }

    const dueDate = b.due_date || b.dueDate;
    if ("due_date" in b || "dueDate" in b) {
      sets.push(`due_date = $${vals.length + 1}`);
      vals.push(dueDate || null);
    }

    if ("amount_subtotal" in b) {
      sets.push(`amount_subtotal = $${vals.length + 1}`);
      vals.push(toNum(b.amount_subtotal));
    }
    if ("amount_tax" in b) {
      sets.push(`amount_tax = $${vals.length + 1}`);
      vals.push(toNum(b.amount_tax));
    }
    if ("amount_total" in b) {
      sets.push(`amount_total = $${vals.length + 1}`);
      vals.push(toNum(b.amount_total));
    }
    if ("amount_paid" in b) {
      sets.push(`amount_paid = $${vals.length + 1}`);
      vals.push(toNum(b.amount_paid));
    }

    if ("status" in b) {
      const allowed = new Set(["draft", "sent", "partial", "paid", "overdue", "void"]);
      const st = String(b.status || "").toLowerCase();
      if (!allowed.has(st)) {
        return res.status(400).json({ error: "status invalido" });
      }
      sets.push(`status = $${vals.length + 1}`);
      vals.push(st);
    }

    if ("notes" in b) {
      sets.push(`notes = $${vals.length + 1}`);
      vals.push(b.notes || null);
    }

    if (!sets.length) {
      return res.status(400).json({ error: "nada para actualizar" });
    }

    sets.push("updated_at = NOW()");
    vals.push(id, org);

    const r = await q(
      `UPDATE public.invoices
          SET ${sets.join(", ")}
        WHERE id = $${vals.length - 1} AND organizacion_id = $${vals.length}
        RETURNING *`,
      vals
    );
    if (!r.rowCount) return res.status(404).json({ error: "invoice_not_found" });
    return res.json(mapInvoiceRow(r.rows[0]));
  } catch (e) {
    console.error("[PATCH /api/billing/invoices/:id]", e?.message || e);
    return res.status(500).json({ error: "error_updating_invoice" });
  }
});

router.delete("/invoices/:id", authenticateToken, async (req, res) => {
  try {
    const org = requireOrg(req, res);
    if (!org) return;

    const { id } = req.params;
    const r = await q(
      `DELETE FROM public.invoices
        WHERE id = $1 AND organizacion_id = $2
        RETURNING id`,
      [id, org]
    );
    if (!r.rowCount) return res.status(404).json({ error: "invoice_not_found" });
    return res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /api/billing/invoices/:id]", e?.message || e);
    return res.status(500).json({ error: "error_deleting_invoice" });
  }
});

export default router;
