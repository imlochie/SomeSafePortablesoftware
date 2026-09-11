import { Router, type IRouter } from "express";
import {
  CreateAcquisitionPlanBody,
  CreateAcquisitionPlanResponse,
  GetAcquisitionFindingParams,
  GetAcquisitionFindingResponse,
  GetAcquisitionFindingsResponse,
  ListAcquisitionPlansResponse,
  GetAcquisitionPlanParams,
  GetAcquisitionPlanResponse,
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
import {
  approveAcquisitionPlan,
  buildAcquisitionPlan,
  executeAcquisitionPlan,
  listAcquisitionPlans,
  readAcquisitionPlan,
  rejectAcquisitionPlan,
} from "../services/acquisition-plan";

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

router.post("/acquisition/plans", async (req, res, next) => {
  try {
    const body = CreateAcquisitionPlanBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    const plan = await buildAcquisitionPlan(getAuthenticatedUserId(req), body.data);
    res.status(201).json(CreateAcquisitionPlanResponse.parse(plan));
  } catch (error) {
    if (error instanceof Error && /valid media URL|supported/i.test(error.message)) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

router.get("/acquisition/plans", (req, res) => {
  res.json(ListAcquisitionPlansResponse.parse({ results: listAcquisitionPlans(getAuthenticatedUserId(req)) }));
});

router.get("/acquisition/plans/:id", (req, res) => {
  const params = GetAcquisitionPlanParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const plan = readAcquisitionPlan(getAuthenticatedUserId(req), params.data.id);
  if (!plan) {
    res.status(404).json({ error: "Acquisition plan not found." });
    return;
  }
  res.json(GetAcquisitionPlanResponse.parse(plan));
});

router.post("/acquisition/plans/:id/approve", (req, res) => {
  const params = GetAcquisitionPlanParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const note = typeof req.body?.note === "string" ? req.body.note : null;
  try {
    const plan = approveAcquisitionPlan(getAuthenticatedUserId(req), params.data.id, note);
    res.json(GetAcquisitionPlanResponse.parse(plan));
  } catch (error) {
    const message = error instanceof Error ? error.message : "The plan could not be approved.";
    const conflict = /not found/i.test(message) ? 404 : /blocked|unsupported|rejected/i.test(message) ? 409 : 400;
    res.status(conflict).json({ error: message });
  }
});

router.post("/acquisition/plans/:id/reject", (req, res) => {
  const params = GetAcquisitionPlanParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const note = typeof req.body?.note === "string" ? req.body.note : null;
  try {
    const plan = rejectAcquisitionPlan(getAuthenticatedUserId(req), params.data.id, note);
    res.json(GetAcquisitionPlanResponse.parse(plan));
  } catch (error) {
    const message = error instanceof Error ? error.message : "The plan could not be rejected.";
    res.status(/not found/i.test(message) ? 404 : 400).json({ error: message });
  }
});

router.post("/acquisition/plans/:id/execute", (req, res) => {
  const params = GetAcquisitionPlanParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  try {
    const plan = executeAcquisitionPlan(getAuthenticatedUserId(req), params.data.id);
    res.json(GetAcquisitionPlanResponse.parse(plan));
  } catch (error) {
    const message = error instanceof Error ? error.message : "The plan could not be executed.";
    const conflict = /not found/i.test(message) ? 404 : /not approved|never be executed|Nothing left/i.test(message) ? 409 : 400;
    res.status(conflict).json({ error: message });
  }
});

export default router;
