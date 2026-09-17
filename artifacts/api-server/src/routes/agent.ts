import { Router, type IRouter } from "express";
import * as Api from "@workspace/api-zod";
import { getAuthenticatedUserId } from "../middlewares/requireAuth";
import { runtimeConfig } from "../lib/runtime-config";
import { readEvents } from "../lib/archive-db";
import { createArchiveOperation } from "../services/archive-operations";

const router: IRouter = Router();

function message(error: unknown) {
  return error instanceof Error ? error.message : "The agent request failed.";
}

router.get("/agent/capabilities", (req, res) => {
  // These describe the server-enforced boundary, not a bearer token with
  // immediate mutation authority. Operation execution remains approval- and
  // preflight-gated by the control plane.
  res.json(Api.GetAgentCapabilitiesResponse.parse({
    agent: { id: "arena", mode: runtimeConfig.authMode === "local" ? "local" : "hosted" },
    capabilities: { read: true, plan: true, operate: true },
    operationPolicy: {
      approvalRequired: true,
      preflightRequired: true,
      directMutation: false,
      providerExecution: false,
    },
  }));
});

router.get("/events", (req, res) => {
  const ownerId = getAuthenticatedUserId(req);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const sent = new Set<string>();
  const writeEvents = () => {
    if (res.writableEnded || res.destroyed) return;
    for (const event of readEvents(ownerId, 100).reverse()) {
      if (sent.has(event.id)) continue;
      sent.add(event.id);
      res.write(`id: ${event.id}\n`);
      res.write(`event: system.event\n`);
      res.write(`data: ${JSON.stringify({
        id: event.id,
        type: "system.event",
        timestamp: event.timestamp,
        payload: event,
      })}\n\n`);
    }
  };
  res.write("retry: 3000\n\n");
  writeEvents();
  const poll = setInterval(writeEvents, 1000);
  poll.unref?.();
  req.on("close", () => clearInterval(poll));
});

router.post("/operations/plan", (req, res) => {
  try {
    const body = Api.CreateArchiveOperationBody.parse(req.body ?? {});
    const operation = createArchiveOperation({
      ...body,
      batch: body.batch?.map((item) => ({ ...item, error: item.error ?? undefined })),
    }, getAuthenticatedUserId(req));
    res.status(201).json(Api.CreateArchiveOperationResponse.parse(operation));
  } catch (error) {
    res.status(400).json({ error: message(error) });
  }
});

export default router;
