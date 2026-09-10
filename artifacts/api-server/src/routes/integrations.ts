import { Router, type IRouter } from "express";
import {
  GetWebhookSecretStatusesResponse,
  ReplaceWebhookSecretBody,
  ReplaceWebhookSecretResponse,
} from "@workspace/api-zod";
import { getAuthenticatedUserId } from "../middlewares/requireAuth";
import { integrationRegistry } from "../integrations";
import {
  readWebhookSecretStatuses,
  rotateWebhookSecret,
  webhookProviders,
  type WebhookProvider,
} from "../services/settings";

const router: IRouter = Router();

router.get("/integrations/status", async (req, res, next) => {
  try {
    const ownerId = getAuthenticatedUserId(req);
    res.json({ integrations: await integrationRegistry.getStatuses(ownerId) });
  } catch (error) {
    next(error);
  }
});

router.get("/integrations/webhooks", (_req, res) => {
  res.json(GetWebhookSecretStatusesResponse.parse({
    providers: readWebhookSecretStatuses(),
  }));
});

router.put("/integrations/webhooks/:provider", (req, res) => {
  const operatorId = getAuthenticatedUserId(req);
  const provider = req.params.provider;
  if (!webhookProviders.includes(provider as WebhookProvider)) {
    res.status(404).json({ error: "Webhook provider is not supported." });
    return;
  }
  const parsed = ReplaceWebhookSecretBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const result = rotateWebhookSecret(provider as WebhookProvider, parsed.data, process.env, Date.now(), {
      ownerId: operatorId,
      operatorId,
    });
    res.json(ReplaceWebhookSecretResponse.parse(result));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Webhook secret could not be saved.",
    });
  }
});

export default router;