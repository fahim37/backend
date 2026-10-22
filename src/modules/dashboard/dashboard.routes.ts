import { Router } from "express";
import { getDashboardStats } from "./dashboard.service.js";

export const dashboardRouter = Router();

dashboardRouter.get("/", async (_req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.json(await getDashboardStats());
});
