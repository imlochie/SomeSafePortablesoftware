import { Router, type IRouter } from "express";
import {
  ApplyArchiveNamingProposalsBody,
  ApplyArchiveNamingProposalsResponse,
  GetArchiveInventoryResponse,
  GetArchiveOperationsQueryParams,
  GetArchiveOperationsResponse,
  GetArchiveQualityFindingsQueryParams,
  GetArchiveQualityFindingsResponse,
  GetArchiveQualityRecordParams,
  GetArchiveQualityRecordResponse,
  GetArchiveRecordParams,
  GetArchiveRecordResponse,
  GetArchiveScanResponse,
  RollbackArchiveOperationParams,
  RollbackArchiveOperationResponse,
  StartArchiveScanResponse,
  UpdateArchiveNamingProposalDecisionsBody,
  UpdateArchiveNamingProposalDecisionsResponse,
  UpdateArchiveQualityFindingReviewBody,
  UpdateArchiveQualityFindingReviewResponse,
  UpdateArchiveRecordReviewBody,
  UpdateArchiveRecordReviewParams,
  UpdateArchiveRecordReviewResponse,
  UpdateArchiveRecordReviewsBody,
  UpdateArchiveRecordReviewsResponse,
} from "@workspace/api-zod";
import { getAuthenticatedUserId } from "../middlewares/requireAuth";
import {
  readArchiveInventory,
  readArchiveRecord,
  readArchiveScan,
  startArchiveScan,
  updateArchiveRecordReview,
  updateArchiveRecordReviews,
} from "../services/archive";
import { readReconciliationReport } from "../services/reconciliation";
import { readNamingProposals, setNamingProposalDecisions } from "../services/naming-intelligence";
import { applyNamingProposals, ArchiveMutationError, readOperations, rollbackOperation } from "../services/archive-operations";
import {
  readQualityFindings,
  readRecordQualityReport,
  saveQualityFindingReview,
} from "../services/archive-quality";
import { readIdentityAudit } from "../services/identity-audit";

const router: IRouter = Router();

router.get("/archive/scan", (req, res) => {
  res.json(GetArchiveScanResponse.parse(readArchiveScan(getAuthenticatedUserId(req))));
});

router.post("/archive/scan", (req, res) => {
  const result = startArchiveScan(getAuthenticatedUserId(req));
  res.status(202).json(StartArchiveScanResponse.parse(result));
});

router.get("/archive/inventory", (req, res) => {
  res.json(GetArchiveInventoryResponse.parse(readArchiveInventory(getAuthenticatedUserId(req))));
});

router.get("/archive/reconciliation", async (req, res, next) => {
  try {
    const page = Number(req.query.page);
    const pageSize = Number(req.query.pageSize);
    res.json(await readReconciliationReport(
      getAuthenticatedUserId(req),
      Number.isFinite(page) ? page : undefined,
      Number.isFinite(pageSize) ? pageSize : undefined,
    ));
  } catch (error) {
    next(error);
  }
});

router.get("/archive/naming-proposals", async (req, res, next) => {
  try {
    const numberQuery = (key: string) => {
      const value = Number(req.query[key]);
      return Number.isFinite(value) ? value : undefined;
    };
    const booleanQuery = req.query.uncertain === undefined
      ? undefined
      : req.query.uncertain === "true";
    res.json(await readNamingProposals(getAuthenticatedUserId(req), {
      page: numberQuery("page"),
      pageSize: numberQuery("pageSize"),
      confidence: typeof req.query.confidence === "string" ? req.query.confidence : undefined,
      operation: typeof req.query.operation === "string" ? req.query.operation : undefined,
      pattern: typeof req.query.pattern === "string" ? req.query.pattern : undefined,
      mediaType: typeof req.query.mediaType === "string" ? req.query.mediaType : undefined,
      volume: typeof req.query.volume === "string" ? req.query.volume : undefined,
      state: typeof req.query.state === "string" ? req.query.state : undefined,
      uncertain: booleanQuery,
      decision: typeof req.query.decision === "string" ? req.query.decision : undefined,
    }));
  } catch (error) {
    next(error);
  }
});

router.post("/archive/naming-proposals/decisions", async (req, res, next) => {
  const body = UpdateArchiveNamingProposalDecisionsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Each decision needs a fileRecordId and a status of accepted, rejected, or deferred." });
    return;
  }
  try {
    const result = await setNamingProposalDecisions(getAuthenticatedUserId(req), body.data.decisions);
    res.json(UpdateArchiveNamingProposalDecisionsResponse.parse(result));
  } catch (error) {
    next(error);
  }
});

router.post("/archive/naming-proposals/apply", async (req, res, next) => {
  const body = ApplyArchiveNamingProposalsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Apply requires a batch of 1-25 unique fileRecord ids and an optional dryRun flag." });
    return;
  }
  try {
    const result = await applyNamingProposals(getAuthenticatedUserId(req), body.data.fileRecordIds, { dryRun: body.data.dryRun });
    res.json(ApplyArchiveNamingProposalsResponse.parse(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Naming proposals could not be applied.";
    if (message.includes("limited to") || message.includes("required")) {
      res.status(400).json({ error: message });
      return;
    }
    next(error);
  }
});

router.get("/archive/operations", (req, res) => {
  const params = GetArchiveOperationsQueryParams.safeParse({
    limit: req.query.limit === undefined ? undefined : Number(req.query.limit),
  });
  if (!params.success) {
    res.status(400).json({ error: "The operations limit must be between 1 and 100." });
    return;
  }
  res.json(GetArchiveOperationsResponse.parse(readOperations(getAuthenticatedUserId(req), params.data.limit ?? 20)));
});

router.post("/archive/operations/:id/rollback", async (req, res, next) => {
  const params = RollbackArchiveOperationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "A valid archive operation id is required." });
    return;
  }
  try {
    const operation = await rollbackOperation(getAuthenticatedUserId(req), params.data.id);
    if (!operation) {
      res.status(404).json({ error: "Archive operation not found." });
      return;
    }
    res.json(RollbackArchiveOperationResponse.parse(operation));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Archive operation could not be rolled back.";
    if (error instanceof ArchiveMutationError || message.includes("not found")) {
      res.status(message.includes("not found") ? 404 : 400).json({ error: message });
      return;
    }
    next(error);
  }
});

router.get("/archive/identity-audit", async (req, res, next) => {
  try {
    const numberQuery = (key: string) => {
      const value = Number(req.query[key]);
      return Number.isFinite(value) ? value : undefined;
    };
    const booleanQuery = req.query.needsReview === undefined
      ? undefined
      : req.query.needsReview === "true";
    res.json(await readIdentityAudit(getAuthenticatedUserId(req), {
      page: numberQuery("page"),
      pageSize: numberQuery("pageSize"),
      auditType: typeof req.query.auditType === "string" ? req.query.auditType : undefined,
      confidence: typeof req.query.confidence === "string" ? req.query.confidence : undefined,
      mediaType: typeof req.query.mediaType === "string" ? req.query.mediaType : undefined,
      needsReview: booleanQuery,
    }));
  } catch (error) {
    next(error);
  }
});

router.get("/archive/quality/findings", (req, res, next) => {
  const query = GetArchiveQualityFindingsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  try {
    const result = readQualityFindings(getAuthenticatedUserId(req), {
      page: query.data.page,
      pageSize: query.data.pageSize,
      kind: query.data.kind,
      confidence: query.data.confidence,
      reviewStatus: query.data.reviewStatus,
      fileRecordId: query.data.fileRecordId,
      volume: query.data.volume,
      includeReviewed: query.data.includeReviewed,
    });
    res.json(GetArchiveQualityFindingsResponse.parse(result));
  } catch (error) {
    next(error);
  }
});

router.get("/archive/quality/records/:id", (req, res) => {
  const params = GetArchiveQualityRecordParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const report = readRecordQualityReport(getAuthenticatedUserId(req), params.data.id);
  if (!report) {
    res.status(404).json({ error: "Archive record not found." });
    return;
  }
  res.json(GetArchiveQualityRecordResponse.parse(report));
});

router.post("/archive/quality/findings/review", (req, res) => {
  const body = UpdateArchiveQualityFindingReviewBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "A quality finding kind, evidence key, and valid review status are required." });
    return;
  }
  try {
    const result = saveQualityFindingReview(getAuthenticatedUserId(req), {
      fileRecordId: body.data.fileRecordId,
      kind: body.data.kind,
      evidenceKey: body.data.evidenceKey,
      status: body.data.status,
      note: body.data.note ?? null,
    });
    if (!result) {
      res.status(404).json({ error: "No quality finding matches that evidence for this archive record." });
      return;
    }
    res.json(UpdateArchiveQualityFindingReviewResponse.parse(result));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Review decision could not be saved." });
  }
});

router.get("/archive/records/:id", (req, res) => {
  const params = GetArchiveRecordParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const record = readArchiveRecord(getAuthenticatedUserId(req), params.data.id);
  if (!record) {
    res.status(404).json({ error: "Archive record not found." });
    return;
  }
  res.json(GetArchiveRecordResponse.parse(record));
});

router.put("/archive/records/:id", (req, res) => {
  const params = UpdateArchiveRecordReviewParams.safeParse(req.params);
  const body = UpdateArchiveRecordReviewBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "A valid review status and archive record id are required." });
    return;
  }
  try {
    const result = updateArchiveRecordReview(
      getAuthenticatedUserId(req),
      params.data.id,
      body.data.status,
      body.data.note ?? null,
    );
    if (!result) {
      res.status(404).json({ error: "Archive record not found." });
      return;
    }
    res.json(UpdateArchiveRecordReviewResponse.parse(result));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Review decision could not be saved." });
  }
});

router.post("/archive/reviews", (req, res) => {
  const body = UpdateArchiveRecordReviewsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "One or more unique archive record ids and a valid review status are required." });
    return;
  }
  const result = updateArchiveRecordReviews(
    getAuthenticatedUserId(req),
    body.data.ids,
    body.data.status,
    body.data.note ?? null,
  );
  res.json(UpdateArchiveRecordReviewsResponse.parse(result));
});

export default router;