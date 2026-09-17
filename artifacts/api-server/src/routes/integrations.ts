import { Router, type IRouter } from "express";
import {
  GetWebhookSecretStatusesResponse,
  GetWebhookDeliveryHistoryQueryParams,
  GetWebhookDeliveryHistoryResponse,
  ReplaceWebhookSecretBody,
  ReplaceWebhookSecretResponse,
} from "@workspace/api-zod";
import { getAuthenticatedUserId } from "../middlewares/requireAuth";
import { integrationRegistry } from "../integrations";
import { readIntegrationConfigurationStatus, saveIntegrationConfiguration } from "../integrations/persisted-config";
import {
  readWebhookSecretStatuses,
  rotateWebhookSecret,
  listWebhookDeliveryHistory,
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

router.post("/integrations/:id/test", async (req, res, next) => {
  try {
    const id = req.params.id as any;
    if (!["plex", "jellyfin", "sonarr", "radarr", "prowlarr", "qbittorrent", "mpilot", "telegram"].includes(id)) return res.status(404).json({ error: "Integration is not supported." });
    const status = (await integrationRegistry.getStatuses(getAuthenticatedUserId(req))).find((item) => item.id === id);
    if (!status) return res.status(404).json({ error: "Integration status not found." });
    return res.json({ testedAt: new Date().toISOString(), ...status });
  } catch (error) { return next(error); }
});

router.get("/integrations/config", (_req, res) => {
  res.json({ integrations: readIntegrationConfigurationStatus() });
});

router.put("/integrations/config/:id", (req, res) => {
  const id = req.params.id as any;
  if (!["sonarr", "radarr", "prowlarr", "qbittorrent", "mpilot", "telegram"].includes(id)) return res.status(404).json({ error: "Integration is not configurable." });
  try {
    const allowed = ["endpoint", "apiKey", "username", "password", "rootFolderPath", "qualityProfileId", "languageProfileId", "webhookSecret"];
    const input = Object.fromEntries(Object.entries(req.body ?? {}).filter(([key, value]) => allowed.includes(key) && value !== undefined));
    saveIntegrationConfiguration(id, input); integrationRegistry.reload();
    return res.json({ ok: true, id, configured: readIntegrationConfigurationStatus().find((item) => item.id === id) });
  } catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "Configuration could not be saved." }); }
});

router.get("/integrations/webhooks", (_req, res) => {
  res.json(GetWebhookSecretStatusesResponse.parse({
    providers: readWebhookSecretStatuses(),
  }));
});

router.get("/integrations/webhooks/history", (req, res) => {
  const parsed = GetWebhookDeliveryHistoryQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const result = listWebhookDeliveryHistory(getAuthenticatedUserId(req), parsed.data);
  res.json(GetWebhookDeliveryHistoryResponse.parse(result));
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