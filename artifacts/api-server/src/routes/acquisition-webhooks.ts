import { Router, type IRouter, type Request } from "express";
import {
  IntegrationUnavailableError,
  IntegrationWebhookAuthenticationError,
  integrationRegistry,
  type AcquisitionWebhookInput,
} from "../integrations";
import {
  handleAcquisitionWebhook,
  isAcquisitionProviderId,
  type AcquisitionProviderId,
} from "../services/acquisition-jobs";
import {
  recordWebhookDelivery,
  recordWebhookDeliveryHistory,
  webhookProviders,
  type WebhookDeliveryClassification,
  type WebhookDeliveryResultClass,
  type WebhookProvider,
} from "../services/settings";

const router: IRouter = Router();

function requestHeaders(req: Request) {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return headers;
}

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "The acquisition webhook could not be processed.";
}

function recordDelivery(provider: string, result: WebhookDeliveryResultClass) {
  if (webhookProviders.includes(provider as WebhookProvider)) {
    recordWebhookDelivery(provider as WebhookProvider, result);
  }
}

function recordHistory(
  provider: string,
  input: Omit<Parameters<typeof recordWebhookDeliveryHistory>[0], "provider"> & {
    classification: WebhookDeliveryClassification;
  },
) {
  if (webhookProviders.includes(provider as WebhookProvider)) {
    recordWebhookDeliveryHistory({ ...input, provider: provider as WebhookProvider });
  }
}

router.post(
  "/:provider",
  (req, res) => {
    const provider = req.params.provider;
    if (!isAcquisitionProviderId(provider)) {
      return res.status(404).json({ error: "Acquisition webhook provider is not supported." });
    }
    if (!Buffer.isBuffer(req.body)) {
      recordDelivery(provider, "malformed");
      recordHistory(provider, {
        classification: "malformed",
        reasonCode: "raw_body_required",
        detail: "Webhook body was not received as raw JSON.",
      });
      return res.status(400).json({ error: "Acquisition webhook body must be raw JSON." });
    }
    try {
      const input: AcquisitionWebhookInput = {
        rawBody: req.body.toString("utf8"),
        headers: requestHeaders(req),
      };
      const event = integrationRegistry.parseAcquisitionWebhook(
        provider as AcquisitionProviderId,
        input,
      );
      if (!event) {
        recordDelivery(provider, "accepted");
        recordHistory(provider, {
          classification: "ignored",
          reasonCode: "non_media_event",
          detail: "Authenticated provider notification did not contain an acquisition job reference.",
          deduplication: null,
        });
        return res.status(202).json({ accepted: true, status: "ignored" });
      }
      const result = handleAcquisitionWebhook(provider as AcquisitionProviderId, event);
      const classification = result.status as Extract<WebhookDeliveryClassification, "processed" | "ignored" | "duplicate">;
      recordDelivery(provider, "accepted");
      recordHistory(provider, {
        classification,
        reasonCode: classification === "processed" ? "matched_acquisition_job" : classification === "duplicate" ? "provider_event_replayed" : "no_matching_acquisition_job",
        providerEventId: event.eventId ?? null,
        providerJobId: event.providerJobId,
        resolvedOwnerId: result.job?.ownerId ?? null,
        acquisitionJobId: result.job?.id ?? null,
        detail: event.detail,
        deduplication: event.eventId ? "event_id" : "unavailable",
      });
      return res.status(202).json({
        accepted: true,
        status: result.status,
      });
    } catch (error) {
      if (error instanceof IntegrationWebhookAuthenticationError) {
        recordDelivery(provider, "rejected");
        recordHistory(provider, {
          classification: "rejected",
          reasonCode: "invalid_signature",
          detail: "Provider webhook signature was rejected.",
        });
        return res.status(401).json({ error: errorMessage(error) });
      }
      if (error instanceof IntegrationUnavailableError) {
        recordDelivery(provider, "unavailable");
        recordHistory(provider, {
          classification: "unavailable",
          reasonCode: "webhook_authentication_unavailable",
          detail: "Webhook authentication could not be performed because provider configuration is unavailable.",
        });
        return res.status(503).json({ error: errorMessage(error) });
      }
      recordDelivery(provider, "malformed");
      recordHistory(provider, {
        classification: "malformed",
        reasonCode: "provider_payload_invalid",
        detail: errorMessage(error),
      });
      return res.status(400).json({ error: errorMessage(error) });
    }
  },
);

export default router;