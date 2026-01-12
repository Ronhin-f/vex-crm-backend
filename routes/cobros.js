import { Router } from "express";
import { authenticateToken } from "../middleware/auth.js";
import { getOrgText } from "../utils/org.js";
import { q, pool } from "../utils/db.js";
import { stockRequest } from "../services/stock.client.js";

const router = Router();

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeItem(raw) {
  const producto_id = Number(raw?.producto_id ?? raw?.productoId ?? raw?.id_producto ?? raw?.productId);
  const cantidad = toNum(raw?.cantidad ?? raw?.qty ?? raw?.cant ?? raw?.stock, NaN);
  const hasPrecio =
    raw?.precio_unitario != null || raw?.precio != null || raw?.unit_price != null;
  const precio_unitario = hasPrecio
    ? toNum(raw?.precio_unitario ?? raw?.precio ?? raw?.unit_price, NaN)
    : null;
  const producto_nombre =
    (raw?.producto_nombre ?? raw?.nombre_producto ?? raw?.nombre ?? raw?.producto ?? "").toString().trim() || null;
  const codigo_qr = (raw?.codigo_qr ?? raw?.qr ?? "").toString().trim() || null;

  return {
    producto_id: Number.isFinite(producto_id) ? producto_id : null,
    producto_nombre,
    codigo_qr,
    cantidad,
    precio_unitario: Number.isFinite(precio_unitario) ? precio_unitario : (precio_unitario == null ? null : NaN),
    subtotal:
      Number.isFinite(cantidad) && Number.isFinite(precio_unitario)
        ? cantidad * precio_unitario
        : NaN,
    _raw: raw,
  };
}

async function ensureCobrosInfra() {
  const r = await q(`SELECT to_regclass('public.cobros') IS NOT NULL AS ok`);
  const r2 = await q(`SELECT to_regclass('public.cobro_items') IS NOT NULL AS ok`);
  return r.rows?.[0]?.ok && r2.rows?.[0]?.ok;
}

function stockErrorPayload(err) {
  const status = err?.response?.status || 502;
  const detail = err?.response?.data || { message: "stock_unavailable" };
  return { status, detail };
}

async function fetchStockProduct(req, { producto_id, codigo_qr, producto_nombre, almacen_id }) {
  if (producto_id) {
    try {
      const r = await stockRequest(req, {
        method: "get",
        path: `/productos/${encodeURIComponent(producto_id)}`,
      });
      return r.data;
    } catch (err) {
      if (err?.response?.status === 404) return null;
      throw err;
    }
  }

  if (codigo_qr) {
    const r = await stockRequest(req, {
      method: "get",
      path: "/productos",
      params: { codigo: codigo_qr, almacen_id, pageSize: 5 },
    });
    const rows = Array.isArray(r.data) ? r.data : [];
    if (rows.length === 1) return rows[0];
    if (rows.length === 0) return null;
    const exact = rows.filter(
      (p) => String(p.codigo_qr || "").trim() === String(codigo_qr).trim()
    );
    if (exact.length === 1) return exact[0];
    const err = new Error("codigo_ambiguous");
    err.status = 409;
    err.detail = { message: "codigo_ambiguous", matches: rows.length };
    throw err;
  }

  if (producto_nombre) {
    const r = await stockRequest(req, {
      method: "get",
      path: "/productos",
      params: { q: producto_nombre, almacen_id, pageSize: 10 },
    });
    const rows = Array.isArray(r.data) ? r.data : [];
    const exact = rows.filter(
      (p) => String(p.nombre || "").trim().toLowerCase() === String(producto_nombre).trim().toLowerCase()
    );
    if (exact.length === 1) return exact[0];
    if (exact.length === 0) return null;
    const err = new Error("nombre_ambiguous");
    err.status = 409;
    err.detail = { message: "nombre_ambiguous", matches: exact.length };
    throw err;
  }

  return null;
}

async function validateItemsAgainstStock(req, items, almacen_id) {
  const validated = [];
  for (const it of items) {
    const prod = await fetchStockProduct(req, {
      producto_id: it.producto_id,
      codigo_qr: it.codigo_qr,
      producto_nombre: it.producto_nombre,
      almacen_id,
    });
    if (!prod) {
      const err = new Error("producto_no_encontrado");
      err.status = 404;
      err.detail = { message: "producto_no_encontrado", item: it._raw };
      throw err;
    }

    const prodAlm = Number(prod.almacen_id);
    if (Number.isFinite(prodAlm) && Number.isFinite(almacen_id) && prodAlm !== almacen_id) {
      const err = new Error("almacen_mismatch");
      err.status = 409;
      err.detail = { message: "almacen_mismatch", producto_id: prod.id, almacen_id: prodAlm };
      throw err;
    }

    const stock = Number(prod.stock ?? prod.cantidad ?? NaN);
    if (Number.isFinite(stock) && stock < it.cantidad) {
      const err = new Error("stock_insuficiente");
      err.status = 409;
      err.detail = {
        message: "stock_insuficiente",
        producto_id: prod.id,
        disponible: stock,
        solicitado: it.cantidad,
      };
      throw err;
    }

    const precioStock = Number.isFinite(Number(prod.costo)) ? Number(prod.costo) : null;
    if (it.precio_unitario != null && Number.isFinite(precioStock)) {
      if (Math.abs(precioStock - it.precio_unitario) > 0.01) {
        const err = new Error("precio_mismatch");
        err.status = 409;
        err.detail = {
          message: "precio_mismatch",
          producto_id: prod.id,
          esperado: precioStock,
          recibido: it.precio_unitario,
        };
        throw err;
      }
    }

    validated.push({ producto: prod, item: it });
  }
  return validated;
}

router.get("/", authenticateToken, async (req, res) => {
  try {
    const org = getOrgText(req, { require: false });
    if (!org) return res.status(400).json({ error: "organizacion_id requerido" });

    const okInfra = await ensureCobrosInfra();
    if (!okInfra) return res.status(501).json({ error: "cobros_no_instalado" });

    const page = Math.max(parseInt(req.query?.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query?.pageSize, 10) || 50, 1), 200);
    const estado = (req.query?.estado || "").toString().trim() || null;
    const clienteId = Number.isFinite(Number(req.query?.cliente_id)) ? Number(req.query?.cliente_id) : null;
    const desde = (req.query?.desde || "").toString().trim() || null;
    const hasta = (req.query?.hasta || "").toString().trim() || null;

    const where = ["organizacion_id = $1"];
    const params = [org];

    if (estado) {
      params.push(estado);
      where.push(`estado = $${params.length}`);
    }
    if (clienteId) {
      params.push(clienteId);
      where.push(`cliente_id = $${params.length}`);
    }
    if (desde) {
      params.push(desde);
      where.push(`created_at >= $${params.length}`);
    }
    if (hasta) {
      params.push(hasta);
      where.push(`created_at <= $${params.length}`);
    }

    const total = (await q(
      `SELECT COUNT(*)::int AS total FROM cobros WHERE ${where.join(" AND ")}`,
      params
    )).rows?.[0]?.total || 0;

    const list = await q(
      `SELECT * FROM cobros
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize]
    );

    return res.json({ rows: list.rows || [], total, page, pageSize });
  } catch (e) {
    console.error("[GET /cobros] error:", e?.message || e);
    return res.status(500).json({ error: "cobros_list_error" });
  }
});

router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const org = getOrgText(req, { require: false });
    if (!org) return res.status(400).json({ error: "organizacion_id requerido" });

    const okInfra = await ensureCobrosInfra();
    if (!okInfra) return res.status(501).json({ error: "cobros_no_instalado" });

    const id = req.params.id;
    const r = await q(
      `SELECT * FROM cobros WHERE id = $1 AND organizacion_id = $2 LIMIT 1`,
      [id, org]
    );
    if (!r.rowCount) return res.status(404).json({ error: "cobro_no_encontrado" });

    const items = await q(
      `SELECT * FROM cobro_items WHERE cobro_id = $1 ORDER BY id ASC`,
      [id]
    );

    return res.json({ ...r.rows[0], items: items.rows || [] });
  } catch (e) {
    console.error("[GET /cobros/:id] error:", e?.message || e);
    return res.status(500).json({ error: "cobro_get_error" });
  }
});

router.post("/", authenticateToken, async (req, res) => {
  const org = getOrgText(req, { require: false });
  if (!org) return res.status(400).json({ error: "organizacion_id requerido" });

  const okInfra = await ensureCobrosInfra();
  if (!okInfra) return res.status(501).json({ error: "cobros_no_instalado" });

  const body = req.body || {};
  const almacen_id = Number(body.almacen_id ?? body.almacenId ?? body.almacen);
  if (!Number.isFinite(almacen_id)) {
    return res.status(400).json({ error: "almacen_id requerido" });
  }

  const itemsRaw = Array.isArray(body.items) ? body.items : [];
  if (!itemsRaw.length) return res.status(400).json({ error: "items requeridos" });

  const items = itemsRaw.map(normalizeItem);
  for (const it of items) {
    if (!Number.isFinite(it.cantidad) || it.cantidad <= 0) {
      return res.status(400).json({ error: "cantidad invalida", item: it._raw });
    }
    if (it.precio_unitario != null && !Number.isFinite(it.precio_unitario)) {
      return res.status(400).json({ error: "precio_unitario invalido", item: it._raw });
    }
    if (!it.producto_id && !it.producto_nombre && !it.codigo_qr) {
      return res.status(400).json({ error: "producto_id o nombre/codigo_qr requerido", item: it._raw });
    }
  }

  try {
    await validateItemsAgainstStock(req, items, almacen_id);
  } catch (err) {
    if (err?.response || err?.status) {
      const status = err?.status || err?.response?.status || 502;
      const detail = err?.detail || err?.response?.data || { message: "stock_error" };
      return res.status(status).json({ error: "stock_validation_error", detail });
    }
    const { status, detail } = stockErrorPayload(err);
    return res.status(status).json({ error: "stock_validation_error", detail });
  }

  const descuento_total = toNum(body.descuento_total ?? body.descuento ?? 0, 0);
  const moneda = (body.moneda ?? body.currency ?? "ARS").toString().trim() || "ARS";
  const medio_pago = (body.medio_pago ?? body.metodo_pago ?? body.payment_method ?? "").toString().trim() || null;
  const notas = (body.notas ?? body.observacion ?? "").toString().trim() || null;
  const cliente_id = Number.isFinite(Number(body.cliente_id)) ? Number(body.cliente_id) : null;

  const totalItems = items.reduce((acc, it) => acc + (Number.isFinite(it.subtotal) ? it.subtotal : 0), 0);
  const total = Number.isFinite(Number(body.total)) ? Number(body.total) : Math.max(totalItems - descuento_total, 0);

  const userEmail = req.usuario?.email || null;

  const client = await pool.connect();
  let cobro = null;
  try {
    await client.query("BEGIN");

    const ins = await client.query(
      `INSERT INTO cobros
        (id, organizacion_id, cliente_id, almacen_id, moneda, total, descuento_total,
         medio_pago, notas, estado, usuario_email)
       VALUES
        (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, 'pendiente', $9)
       RETURNING *`,
      [org, cliente_id, almacen_id, moneda, total, descuento_total, medio_pago, notas, userEmail]
    );
    cobro = ins.rows[0];

    for (const it of items) {
      await client.query(
        `INSERT INTO cobro_items
          (cobro_id, producto_id, producto_nombre, codigo_qr, cantidad, precio_unitario, subtotal)
         VALUES
          ($1, $2, $3, $4, $5, $6, $7)`,
        [
          cobro.id,
          it.producto_id,
          it.producto_nombre,
          it.codigo_qr,
          it.cantidad,
          Number.isFinite(it.precio_unitario) ? it.precio_unitario : 0,
          Number.isFinite(it.subtotal) ? it.subtotal : 0,
        ]
      );
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[POST /cobros] db error:", e?.message || e);
    return res.status(500).json({ error: "cobro_db_error" });
  } finally {
    client.release();
  }

  const stockPayload = {
    almacen_id,
    items: items.map((it) => ({
      producto_id: it.producto_id || undefined,
      codigo_qr: it.codigo_qr || undefined,
      producto_nombre: it.producto_nombre || undefined,
      cantidad: it.cantidad,
    })),
    referencia: `cobro:${cobro.id}`,
    observaciones: notas || undefined,
  };

  try {
    const r = await stockRequest(req, { method: "post", path: "/salidas", data: stockPayload });
    await q(
      `UPDATE cobros SET estado = 'confirmado', stock_error = NULL, updated_at = NOW() WHERE id = $1`,
      [cobro.id]
    );
    return res.status(201).json({ cobro_id: cobro.id, estado: "confirmado", stock: r.data });
  } catch (err) {
    const status = err?.response?.status || 502;
    const detail = err?.response?.data || { message: "stock_error" };
    await q(
      `UPDATE cobros SET estado = 'fallido', stock_error = $2, updated_at = NOW() WHERE id = $1`,
      [cobro.id, JSON.stringify(detail)]
    );
    return res.status(status).json({ cobro_id: cobro.id, estado: "fallido", stock_error: detail });
  }
});

export default router;
