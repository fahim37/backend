import { Router } from "express";
import { parseQuery } from "../../middleware/validate.js";
import { activityListQuery, listActivity } from "./activity.service.js";

export const activityRouter = Router();

activityRouter.get("/", async (req, res) => {
  res.json(await listActivity(parseQuery(activityListQuery, req)));
});
