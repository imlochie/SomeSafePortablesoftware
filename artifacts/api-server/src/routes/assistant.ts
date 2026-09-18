import { Router, type IRouter } from "express";
import { GetAssistantOverviewResponse, GetAssistantWorkloadLineageParams, GetAssistantWorkloadLineageResponse, GetAssistantWorkloadResponse } from "@workspace/api-zod";
import { getAuthenticatedUserId } from "../middlewares/requireAuth";
import { readAssistantOverview } from "../services/assistant-overview";
import { researchCandidate } from "../services/media-research";
import { researchFromViewingHistory } from "../services/research-history";
import { evaluateViewingResearch } from "../services/research-evaluation";
import { synthesizeViewingResearch } from "../services/research-synthesis";
import { readPersonalCuration } from "../services/personal-curation";
import { readPersonalReasoning } from "../services/personal-reasoning";
import { readMediaProfile } from "../services/media-profile";
import { readWorkload } from "../services/workload";
import { readWorkloadLineage } from "../services/lineage";
import { readArchiveHealth } from "../services/archive-health";

const router: IRouter = Router();

router.get("/assistant/research", async (req, res, next) => {
  try {
    const query = typeof req.query.query === "string" ? req.query.query : "";
    res.json(await researchCandidate(getAuthenticatedUserId(req), query));
  } catch (error) {
    next(error);
  }
});

router.get("/assistant/media-profile", (req, res) => {
  res.json(readMediaProfile(getAuthenticatedUserId(req)));
});

router.get("/assistant/archive-context", (req, res) => {
  res.json(readMediaProfile(getAuthenticatedUserId(req)).archiveGraph);
});

router.get("/assistant/research/reasoning", async (req, res, next) => {
  try {
    res.json(await readPersonalReasoning(getAuthenticatedUserId(req)));
  } catch (error) {
    next(error);
  }
});

router.get("/assistant/research/curation", async (req, res, next) => {
  try {
    res.json(await readPersonalCuration(getAuthenticatedUserId(req)));
  } catch (error) {
    next(error);
  }
});

router.get("/assistant/research/synthesis", async (req, res, next) => {
  try {
    res.json(await synthesizeViewingResearch(getAuthenticatedUserId(req)));
  } catch (error) {
    next(error);
  }
});

router.get("/assistant/research/evaluations", async (req, res, next) => {
  try {
    res.json(await evaluateViewingResearch(getAuthenticatedUserId(req)));
  } catch (error) {
    next(error);
  }
});

router.get("/assistant/research/history", async (req, res, next) => {
  try {
    res.json(await researchFromViewingHistory(getAuthenticatedUserId(req)));
  } catch (error) {
    next(error);
  }
});

router.get("/assistant/workload", async (req, res, next) => {
  try {
    res.json(GetAssistantWorkloadResponse.parse(await readWorkload(getAuthenticatedUserId(req))));
  } catch (error) {
    next(error);
  }
});

router.get("/assistant/workload/:workloadId/lineage", (req, res) => {
  const { workloadId } = GetAssistantWorkloadLineageParams.parse(req.params);
  const lineage = readWorkloadLineage(workloadId, getAuthenticatedUserId(req));
  if (!lineage) return res.status(404).json({ message: "Workload lineage not found." });
  return res.json(GetAssistantWorkloadLineageResponse.parse(lineage));
});

router.get("/assistant/health", async (req, res, next) => {
  try { res.json(await readArchiveHealth(getAuthenticatedUserId(req))); } catch (error) { next(error); }
});

router.get("/assistant/overview", async (req, res, next) => {
  try {
    res.json(GetAssistantOverviewResponse.parse(await readAssistantOverview(getAuthenticatedUserId(req))));
  } catch (error) {
    next(error);
  }
});

export default router;
