import { Router } from "express";
import { authenticateToken } from "../middlewares/auth.js";

const router = Router();
const CORE_URL = process.env.VEX_CORE_URL;

router.get("/", authenticateToken, async (req, res) => {
  if (!CORE_URL) return res.status(501).json({ message: "CORE_URL no configurada" });
  try {
    const r = await fetch(`${CORE_URL}/modulos`, {
      headers: { Authorization: req.headers["authorization"] }
    });
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (e) {
    console.error("[GET /modulos]", e);
    return res.status(502).json({ message: "No se pudo consultar Vex Core" });
  }
});

export default router;
