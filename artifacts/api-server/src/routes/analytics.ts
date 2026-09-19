import { Router, type IRouter } from "express";
import { GetArchivePersonalisationContextResponse } from "@workspace/api-zod";
import { getAuthenticatedUserId } from "../middlewares/requireAuth";
import { getAnalytics } from "../services/archive-analytics";
import { getPersonalisationContext } from "../services/behavioral-intelligence";

const router: IRouter = Router();

// Read-only control-plane surface. Ingestion is deliberately not exposed as a mutation endpoint.
router.get("/analytics", (req, res) => {
  res.json(getAnalytics(getAuthenticatedUserId(req)));
});

router.get("/assistant/personalisation-context", (req, res) => {
  res.json(GetArchivePersonalisationContextResponse.parse(getPersonalisationContext(getAuthenticatedUserId(req))));
});

export default router;
