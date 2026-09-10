import { Router, type IRouter } from "express";
import { getAuthenticatedUserId } from "../middlewares/requireAuth";
import { integrationRegistry } from "../integrations";

const router: IRouter = Router();

router.get("/integrations/status", async (req, res, next) => {
  try {
    const ownerId = getAuthenticatedUserId(req);
    res.json({ integrations: await integrationRegistry.getStatuses(ownerId) });
  } catch (error) {
    next(error);
  }
});

export default router;