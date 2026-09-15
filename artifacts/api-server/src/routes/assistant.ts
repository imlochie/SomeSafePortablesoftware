import { Router, type IRouter } from "express";
import { GetAssistantOverviewResponse } from "@workspace/api-zod";
import { getAuthenticatedUserId } from "../middlewares/requireAuth";
import { readAssistantOverview } from "../services/assistant-overview";

const router: IRouter = Router();

router.get("/assistant/overview", async (req, res, next) => {
  try {
    res.json(GetAssistantOverviewResponse.parse(await readAssistantOverview(getAuthenticatedUserId(req))));
  } catch (error) {
    next(error);
  }
});

export default router;
