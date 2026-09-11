import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import {
  ListIntegrationsResponse, UpdateIntegrationConfigBody, UpdateIntegrationConfigResponse,
  TestIntegrationConnectionResponse, GetIntegrationInventoryResponse,
} from "@workspace/api-zod";
import { getAuthenticatedUserId } from "../middlewares/requireAuth";
import { integrations } from "../integrations";
import { IntegrationError } from "../integrations/contracts";

const router: IRouter = Router();
router.get("/integrations", (req, res) => {
  res.json(ListIntegrationsResponse.parse(integrations.list(getAuthenticatedUserId(req))));
});
router.patch("/integrations/:integrationId/config", (req, res) => {
  const body = UpdateIntegrationConfigBody.strict().safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "Expected only an enabled boolean." });
  return res.json(UpdateIntegrationConfigResponse.parse(integrations.configure(getAuthenticatedUserId(req), String(req.params.integrationId), body.data)));
});
router.post("/integrations/:integrationId/test-connection", async (req, res) => {
  res.json(TestIntegrationConnectionResponse.parse(await integrations.testConnection(getAuthenticatedUserId(req), String(req.params.integrationId))));
});
router.get("/integrations/:integrationId/inventory", async (req, res) => {
  res.json(GetIntegrationInventoryResponse.parse(await integrations.execute(getAuthenticatedUserId(req), String(req.params.integrationId), "media_host_inventory")));
});
router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (!(error instanceof IntegrationError)) return next(error);
  const status = error.code === "not_found" ? 404 : error.code === "unavailable" ? 503 : 409;
  return res.status(status).json({ error: error.code });
});
export default router;
