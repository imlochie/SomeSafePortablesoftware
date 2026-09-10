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

router.post(
  "/:provider",
  (req, res) => {
    const provider = req.params.provider;
    if (!isAcquisitionProviderId(provider)) {
      return res.status(404).json({ error: "Acquisition webhook provider is not supported." });
    }
    if (!Buffer.isBuffer(req.body)) {
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
        return res.status(202).json({ accepted: true, status: "ignored" });
      }
      const result = handleAcquisitionWebhook(provider as AcquisitionProviderId, event);
      return res.status(202).json({
        accepted: true,
        status: result.status,
      });
    } catch (error) {
      if (error instanceof IntegrationWebhookAuthenticationError) {
        return res.status(401).json({ error: errorMessage(error) });
      }
      if (error instanceof IntegrationUnavailableError) {
        return res.status(503).json({ error: errorMessage(error) });
      }
      return res.status(400).json({ error: errorMessage(error) });
    }
  },
);

export default router;