import { Router } from "express";
const router = Router();

router.get("/", (_, res) => res.send("✅ VEX CRM corriendo"));

export default router;
