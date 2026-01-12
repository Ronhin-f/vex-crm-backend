import { Router } from "express";
import { authenticateToken } from "../middleware/auth.js";
import { stockRequest } from "../services/stock.client.js";

const router = Router();

function handleStockError(res, err) {
  const status = err?.response?.status || 502;
  const data = err?.response?.data || { message: "stock_unavailable" };
  res.status(status).json({ error: "stock_error", detail: data });
}

router.get("/productos", authenticateToken, async (req, res) => {
  try {
    const r = await stockRequest(req, {
      method: "get",
      path: "/productos",
      params: req.query,
    });
    const total = r.headers?.["x-total-count"] || r.headers?.["X-Total-Count"];
    if (total != null) res.set("X-Total-Count", String(total));
    res.status(r.status).json(r.data);
  } catch (err) {
    handleStockError(res, err);
  }
});

router.get("/productos/:id", authenticateToken, async (req, res) => {
  try {
    const r = await stockRequest(req, {
      method: "get",
      path: `/productos/${encodeURIComponent(req.params.id)}`,
    });
    res.status(r.status).json(r.data);
  } catch (err) {
    handleStockError(res, err);
  }
});

router.get("/almacenes", authenticateToken, async (req, res) => {
  try {
    const r = await stockRequest(req, {
      method: "get",
      path: "/almacenes",
      params: req.query,
    });
    res.status(r.status).json(r.data);
  } catch (err) {
    handleStockError(res, err);
  }
});

router.get("/dashboard/resumen", authenticateToken, async (req, res) => {
  try {
    const r = await stockRequest(req, {
      method: "get",
      path: "/dashboard/resumen",
      params: req.query,
    });
    res.status(r.status).json(r.data);
  } catch (err) {
    handleStockError(res, err);
  }
});

export default router;
