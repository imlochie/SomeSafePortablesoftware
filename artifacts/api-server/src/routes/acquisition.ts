import { Router, type IRouter } from "express";
import {
  GetAcquisitionFindingParams,
  GetAcquisitionFindingResponse,
  GetAcquisitionFindingsResponse,
  RefreshAcquisitionIntelligenceResponse,
  UpdateAcquisitionFindingReviewBody,
  UpdateAcquisitionFindingReviewParams,
  UpdateAcquisitionFindingReviewResponse,
  UpsertAcquisitionCandidateBody,
  UpsertAcquisitionCandidateResponse,
} from "@workspace/api-zod";
import { getAuthenticatedUserId } from "../middlewares/requireAuth";
import {
  getAcquisitionFinding,
  listAcquisitionFindings,
  refreshAcquisitionIntelligence,
  updateAcquisitionFindingReview,
  upsertAcquisitionCandidate,
} from "../services/acquisition-intelligence";

const router: IRouter = Router();

function numberQuery(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

router.get("/acquisition/findings", (req, res) => {
  const result = listAcquisitionFindings(getAuthenticatedUserId(req), {
    mediaType: typeof req.query.mediaType === "string" ? req.query.mediaType : undefined,
    status: typeof req.query.status === "string" ? req.query.status : undefined,
    priority: typeof req.query.priority === "string" ? req.query.priority : undefined,
    reviewStatus: typeof req.query.reviewStatus === "string" ? req.query.reviewStatus : undefined,
    page: numberQuery(req.query.page),
    pageSize: numberQuery(req.query.pageSize),
  });
  res.json(GetAcquisitionFindingsResponse.parse(result));
});

router.get("/acquisition/findings/:id", (req, res) => {
  const params = GetAcquisitionFindingParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const result = getAcquisitionFinding(getAuthenticatedUserId(req), params.data.id);
  if (!result) {
    res.status(404).json({ error: "Acquisition finding not found." });
    return;
  }
  res.json(GetAcquisitionFindingResponse.parse(result));
});

router.patch("/acquisition/findings/:id/review", (req, res) => {
  const params = UpdateAcquisitionFindingReviewParams.safeParse(req.params);
  const body = UpdateAcquisitionFindingReviewBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "A valid finding id and review decision are required." });
    return;
  }
  const result = updateAcquisitionFindingReview(
    getAuthenticatedUserId(req),
    params.data.id,
    body.data.status,
    body.data.note ?? null,
  );
  if (!result) {
    res.status(404).json({ error: "Acquisition finding not found." });
    return;
  }
  res.json(UpdateAcquisitionFindingReviewResponse.parse(result));
});

router.post("/acquisition/refresh", (req, res) => {
  const result = refreshAcquisitionIntelligence(getAuthenticatedUserId(req));
  res.json(RefreshAcquisitionIntelligenceResponse.parse(result));
});

router.post("/acquisition/candidates", (req, res) => {
  const body = UpsertAcquisitionCandidateBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const result = upsertAcquisitionCandidate(getAuthenticatedUserId(req), body.data);
  if (!result) {
    res.status(400).json({ error: "The normalized source option could not be stored." });
    return;
  }
  res.status(201).json(UpsertAcquisitionCandidateResponse.parse(result));
});

export default router;
