// routes/health.js
import { Router } from "express";
const router = Router();

router.get("/", (_req, res) => {
  res.status(200).json({ ok: true, service: "vex-crm-backend" });
});

export default router;
