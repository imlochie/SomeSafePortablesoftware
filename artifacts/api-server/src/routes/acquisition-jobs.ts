import { Router, type IRouter } from "express";
import {
  CancelAcquisitionJobParams,
  CancelAcquisitionJobResponse,
  CreateAcquisitionJobBody,
  CreateAcquisitionJobResponse,
  GetAcquisitionJobParams,
  GetAcquisitionJobResponse,
  GetAcquisitionJobsQueryParams,
  GetAcquisitionJobsResponse,
  ProgressAcquisitionJobBody,
  ProgressAcquisitionJobParams,
  ProgressAcquisitionJobResponse,
  RefreshAcquisitionJobParams,
  RefreshAcquisitionJobResponse,
  RetryAcquisitionJobParams,
  RetryAcquisitionJobResponse,
} from "@workspace/api-zod";
import { getAuthenticatedUserId } from "../middlewares/requireAuth";
import {
  cancelAcquisitionJob,
  createAcquisitionJob,
  listAcquisitionJobs,
  progressAcquisitionJob,
  readAcquisitionJob,
  refreshAcquisitionJob,
  retryAcquisitionJob,
} from "../services/acquisition-jobs";

const router: IRouter = Router();

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "The acquisition service could not complete the request.";
}

function numericParam(value: string | undefined) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) {
    throw new Error("Acquisition job id must be a positive integer.");
  }
  return id;
}

router.get("/acquisition-jobs", (req, res) => {
  try {
    const query = GetAcquisitionJobsQueryParams.parse({
      state: typeof req.query.state === "string" ? req.query.state : undefined,
    });
    const jobs = listAcquisitionJobs(getAuthenticatedUserId(req), query.state);
    return res.json(GetAcquisitionJobsResponse.parse(jobs));
  } catch (error) {
    return res.status(400).json({ error: errorMessage(error) });
  }
});

router.post("/acquisition-jobs", async (req, res) => {
  try {
    const body = CreateAcquisitionJobBody.parse(req.body ?? {});
    const job = await createAcquisitionJob(body, getAuthenticatedUserId(req));
    return res.status(201).json(CreateAcquisitionJobResponse.parse(job));
  } catch (error) {
    return res.status(400).json({ error: errorMessage(error) });
  }
});

router.get("/acquisition-jobs/:id", (req, res) => {
  try {
    const id = GetAcquisitionJobParams.parse({ id: numericParam(req.params.id) }).id;
    const job = readAcquisitionJob(id, getAuthenticatedUserId(req));
    if (!job) return res.status(404).json({ error: "Acquisition job not found." });
    return res.json(GetAcquisitionJobResponse.parse(job));
  } catch (error) {
    return res.status(400).json({ error: errorMessage(error) });
  }
});

router.post("/acquisition-jobs/:id/retry", async (req, res) => {
  try {
    const id = RetryAcquisitionJobParams.parse({ id: numericParam(req.params.id) }).id;
    const job = await retryAcquisitionJob(id, getAuthenticatedUserId(req));
    return res.json(RetryAcquisitionJobResponse.parse(job));
  } catch (error) {
    return res.status(400).json({ error: errorMessage(error) });
  }
});

router.post("/acquisition-jobs/:id/cancel", (req, res) => {
  try {
    const id = CancelAcquisitionJobParams.parse({ id: numericParam(req.params.id) }).id;
    const job = cancelAcquisitionJob(id, getAuthenticatedUserId(req));
    return res.json(CancelAcquisitionJobResponse.parse(job));
  } catch (error) {
    return res.status(400).json({ error: errorMessage(error) });
  }
});

router.post("/acquisition-jobs/:id/progress", (req, res) => {
  try {
    const id = ProgressAcquisitionJobParams.parse({ id: numericParam(req.params.id) }).id;
    const body = ProgressAcquisitionJobBody.parse(req.body ?? {});
    const job = progressAcquisitionJob(id, getAuthenticatedUserId(req), body);
    return res.json(ProgressAcquisitionJobResponse.parse(job));
  } catch (error) {
    return res.status(400).json({ error: errorMessage(error) });
  }
});

router.post("/acquisition-jobs/:id/refresh", async (req, res) => {
  try {
    const id = RefreshAcquisitionJobParams.parse({ id: numericParam(req.params.id) }).id;
    const job = await refreshAcquisitionJob(id, getAuthenticatedUserId(req));
    return res.json(RefreshAcquisitionJobResponse.parse(job));
  } catch (error) {
    return res.status(400).json({ error: errorMessage(error) });
  }
});

export default router;