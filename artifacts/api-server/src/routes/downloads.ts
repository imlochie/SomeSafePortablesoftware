import { Router, type IRouter } from "express";
import {
  CancelDownloadParams,
  CancelDownloadResponse,
  CreateDownloadBody,
  CreateDownloadResponse,
  DeleteDownloadParams,
  GetDownloadParams,
  GetDownloadResponse,
  GetDownloadsResponse,
  PauseDownloadParams,
  PauseDownloadResponse,
  ResumeDownloadParams,
  ResumeDownloadResponse,
  RetryDownloadParams,
  RetryDownloadResponse,
  StartDownloadParams,
  StartDownloadResponse,
} from "@workspace/api-zod";
import {
  cancelJob,
  createJob,
  deleteJob,
  pauseJob,
  readJobs,
  retryJob,
  resumeJob,
  startJob,
  subscribeDownloadEvents,
} from "../services/download-engine";

const router: IRouter = Router();

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The download engine could not complete the request.";
}

function numericParam(value: string | undefined) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new Error("Download id must be a positive integer.");
  return id;
}

router.get("/downloads", (_req, res) => {
  res.json(GetDownloadsResponse.parse(readJobs()));
});

router.post("/downloads", (req, res) => {
  try {
    const body = CreateDownloadBody.parse(req.body ?? {});
    const job = createJob(body);
    res.status(201).json(CreateDownloadResponse.parse(job));
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

router.get("/downloads/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(`event: snapshot\ndata: ${JSON.stringify(readJobs())}\n\n`);
  const unsubscribe = subscribeDownloadEvents((event) => {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.job)}\n\n`);
  });
  const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 20_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

router.get("/downloads/:id", (req, res) => {
  try {
    const job = readJobs().find((candidate) => candidate.id === numericParam(req.params.id));
    if (!job) return res.status(404).json({ error: "Download job not found." });
    return res.json(GetDownloadResponse.parse(job));
  } catch (error) {
    return res.status(400).json({ error: errorMessage(error) });
  }
});

router.delete("/downloads/:id", (req, res) => {
  try {
    deleteJob(DeleteDownloadParams.parse({ id: numericParam(req.params.id) }).id);
    return res.status(204).send();
  } catch (error) {
    return res.status(400).json({ error: errorMessage(error) });
  }
});

router.post("/downloads/:id/start", (req, res) => {
  try {
    const id = StartDownloadParams.parse({ id: numericParam(req.params.id) }).id;
    return res.json(StartDownloadResponse.parse(startJob(id)));
  } catch (error) {
    return res.status(400).json({ error: errorMessage(error) });
  }
});

router.post("/downloads/:id/pause", (req, res) => {
  try {
    const id = PauseDownloadParams.parse({ id: numericParam(req.params.id) }).id;
    return res.json(PauseDownloadResponse.parse(pauseJob(id)));
  } catch (error) {
    return res.status(400).json({ error: errorMessage(error) });
  }
});

router.post("/downloads/:id/resume", (req, res) => {
  try {
    const id = ResumeDownloadParams.parse({ id: numericParam(req.params.id) }).id;
    return res.json(ResumeDownloadResponse.parse(startJob(id)));
  } catch (error) {
    return res.status(400).json({ error: errorMessage(error) });
  }
});

router.post("/downloads/:id/cancel", (req, res) => {
  try {
    const id = CancelDownloadParams.parse({ id: numericParam(req.params.id) }).id;
    return res.json(CancelDownloadResponse.parse(cancelJob(id)));
  } catch (error) {
    return res.status(400).json({ error: errorMessage(error) });
  }
});

router.post("/downloads/:id/retry", (req, res) => {
  try {
    const id = RetryDownloadParams.parse({ id: numericParam(req.params.id) }).id;
    return res.json(RetryDownloadResponse.parse(retryJob(id)));
  } catch (error) {
    return res.status(400).json({ error: errorMessage(error) });
  }
});

export default router;