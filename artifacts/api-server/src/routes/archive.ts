import { Router, type IRouter } from "express";
import {
  GetArchiveInventoryResponse,
  GetArchiveIdentityAuditResponse,
  GetArchiveNamingProposalsResponse,
  GetArchiveReconciliationResponse,
  GetArchiveRecordParams,
  GetArchiveRecordResponse,
  GetArchiveProviderResponse,
  GetArchiveScanResponse,
  DiscoverArchiveMissingMediaQueryParams,
  DiscoverArchiveMissingMediaResponse,
  LookupArchiveMediaQueryParams,
  LookupArchiveMediaResponse,
  RequestArchiveAcquisitionBody,
  RequestArchiveAcquisitionResponse,
  SetArchiveProviderBody,
  SetArchiveProviderResponse,
  StartArchiveScanResponse,
  UpdateArchiveRecordReviewBody,
  UpdateArchiveRecordReviewParams,
  UpdateArchiveRecordReviewResponse,
  UpdateArchiveRecordReviewsBody,
  UpdateArchiveRecordReviewsResponse,
} from "@workspace/api-zod";
import { getAuthenticatedUserId } from "../middlewares/requireAuth";
import {
  readArchiveScanLiveState,
  subscribeArchiveScanEvents,
  type ArchiveScanEvent,
} from "../services/scan-events";
import {
  readArchiveProviderSelection,
  setArchiveProvider,
  readArchiveInventory,
  readArchiveRecord,
  readArchiveScan,
  startArchiveScan,
  updateArchiveRecordReview,
  updateArchiveRecordReviews,
} from "../services/archive";
import {
  discoverMissingMedia,
  lookupMedia,
  requestMediaAcquisition,
} from "../services/media-acquisition";
import { readReconciliationReport } from "../services/reconciliation";
import { readNamingProposals } from "../services/naming-intelligence";
import { readIdentityAudit } from "../services/identity-audit";
import { createOrderingProposalSnapshot, readOrderingProposal, currentOrderingProposalValidation } from "../services/ordering-proposals";
import { createArchiveOperation, listArchiveOperations } from "../services/archive-operations";
import { ensureReviewItem, readReviewItem } from "../services/review-queue";
import { buildPowerRenamePlan, powerRenameSummary } from "../services/power-renamer";

const router: IRouter = Router();

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The archive control plane could not complete the request.";
}

router.get("/archive/scan/events", (req, res) => {
  const ownerId = getAuthenticatedUserId(req);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.on("error", () => {
    // A dropped client must never bubble a socket error into the process.
  });
  // Initial snapshot so a newly connected (or reconnecting) client immediately
  // knows the current scan state. The persisted aggregate from
  // GET /api/archive/scan remains the source of truth; the live block is the
  // ephemeral observability state.
  res.write(`retry: 3000\n\n`);
  res.write(`event: snapshot\ndata: ${JSON.stringify({
    scan: readArchiveScan(ownerId),
    live: readArchiveScanLiveState(ownerId),
  })}\n\n`);
  const unsubscribe = subscribeArchiveScanEvents(ownerId, (event: ArchiveScanEvent) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    res.write(": keep-alive\n\n");
  }, 15_000);
  // The heartbeat must never be the reason the process stays alive: an
  // otherwise-idle server (or a test run) should still be able to exit.
  heartbeat.unref?.();
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

router.get("/archive/scan", (req, res) => {
  res.json(GetArchiveScanResponse.parse(readArchiveScan(getAuthenticatedUserId(req))));
});

router.post("/archive/scan", (req, res) => {
  const result = startArchiveScan(getAuthenticatedUserId(req));
  res.status(202).json(StartArchiveScanResponse.parse(result));
});

router.get("/archive/provider", (req, res) => {
  res.json(GetArchiveProviderResponse.parse(
    readArchiveProviderSelection(getAuthenticatedUserId(req)),
  ));
});

router.put("/archive/provider", (req, res) => {
  const { provider } = SetArchiveProviderBody.parse(req.body ?? {});
  res.json(SetArchiveProviderResponse.parse(
    setArchiveProvider(getAuthenticatedUserId(req), provider),
  ));
});

router.get("/archive/inventory", (req, res) => {
  res.json(GetArchiveInventoryResponse.parse(readArchiveInventory(getAuthenticatedUserId(req))));
});

router.get("/archive/media-lookup", async (req, res) => {
  try {
    const parsed = LookupArchiveMediaQueryParams.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    if (!parsed.data.query && !parsed.data.externalId) {
      return res.status(400).json({ error: "A media query or external ID is required." });
    }
    const result = await lookupMedia(parsed.data, getAuthenticatedUserId(req));
    return res.json(LookupArchiveMediaResponse.parse(result));
  } catch (error) {
    return res.status(400).json({ error: errorMessage(error) });
  }
});

router.get("/archive/missing-media", async (req, res) => {
  try {
    const parsed = DiscoverArchiveMissingMediaQueryParams.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const result = await discoverMissingMedia(parsed.data, getAuthenticatedUserId(req));
    return res.json(DiscoverArchiveMissingMediaResponse.parse(result));
  } catch (error) {
    return res.status(400).json({ error: errorMessage(error) });
  }
});

router.post("/archive/acquisitions", async (req, res) => {
  try {
    const body = RequestArchiveAcquisitionBody.parse(req.body ?? {});
    const result = await requestMediaAcquisition(body, getAuthenticatedUserId(req));
    return res.status(201).json(RequestArchiveAcquisitionResponse.parse(result));
  } catch (error) {
    return res.status(400).json({ error: errorMessage(error) });
  }
});

router.get("/archive/reconciliation", async (req, res, next) => {
  try {
    const page = Number(req.query.page);
    const pageSize = Number(req.query.pageSize);
    const report = await readReconciliationReport(
      getAuthenticatedUserId(req),
      Number.isFinite(page) ? page : undefined,
      Number.isFinite(pageSize) ? pageSize : undefined,
    );
    res.json(GetArchiveReconciliationResponse.parse(report));
  } catch (error) {
    next(error);
  }
});

router.post("/archive/ordering-proposals", (req, res) => {
  try {
    const body = req.body ?? {};
    const ownerId = getAuthenticatedUserId(req);
    const result = createOrderingProposalSnapshot(ownerId, body);
    return res.status(201).json({
      ...result.snapshot,
      state: "active",
      reviewState: result.review.state,
      reviewItemId: result.review.id,
      validationState: currentOrderingProposalValidation(ownerId, result.snapshot.proposalId).state,
      staleStatus: currentOrderingProposalValidation(ownerId, result.snapshot.proposalId).state.toLowerCase(),
      linkedOperationId: null,
    });
  } catch (error) {
    return res.status(400).json({ error: errorMessage(error) });
  }
});

router.get("/archive/ordering-proposals/:id", (req, res) => {
  const ownerId = getAuthenticatedUserId(req);
  const proposal = readOrderingProposal(ownerId, req.params.id);
  if (!proposal) return res.status(404).json({ error: "Ordering proposal not found." });
  const operation = listArchiveOperations(ownerId).find((item) => item.proposalId === proposal.proposalId) ?? null;
  const review = readReviewItem(proposal.reviewItemId, ownerId);
  const validation = currentOrderingProposalValidation(ownerId, proposal.proposalId);
  return res.json({
    ...proposal,
    state: "active",
    reviewState: review?.state ?? "unknown",
    validationState: validation.state,
    validation: validation.reasons,
    staleStatus: validation.state.toLowerCase(),
    linkedOperationId: operation?.id ?? null,
  });
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
    const report = await readNamingProposals(getAuthenticatedUserId(req), {
      page: numberQuery("page"),
      pageSize: numberQuery("pageSize"),
      confidence: typeof req.query.confidence === "string" ? req.query.confidence : undefined,
      operation: typeof req.query.operation === "string" ? req.query.operation : undefined,
      pattern: typeof req.query.pattern === "string" ? req.query.pattern : undefined,
      mediaType: typeof req.query.mediaType === "string" ? req.query.mediaType : undefined,
      volume: typeof req.query.volume === "string" ? req.query.volume : undefined,
      state: typeof req.query.state === "string" ? req.query.state : undefined,
      uncertain: booleanQuery,
    });
    res.json(GetArchiveNamingProposalsResponse.parse(report));
  } catch (error) {
    next(error);
  }
});

router.post("/archive/power-renamer/plan", async (req, res) => {
  try {
    const ownerId = getAuthenticatedUserId(req);
    const requestedIds = Array.isArray(req.body?.fileRecordIds)
      ? new Set(req.body.fileRecordIds.map((value: unknown) => Number(value)).filter((value: number) => Number.isInteger(value)))
      : null;
    if (!requestedIds || requestedIds.size === 0) return res.status(400).json({ error: "Select at least one naming proposal to plan." });
    const report = await readNamingProposals(ownerId, { page: 1, pageSize: 500 });
    const selected = report.results.filter((proposal) => requestedIds.has(Number(proposal.fileRecordId))).map((proposal) => ({
      fileRecordId: Number(proposal.fileRecordId),
      sourcePath: String(proposal.sourcePath),
      proposedPath: proposal.proposedPath == null ? null : String(proposal.proposedPath),
      confidence: String(proposal.confidence),
      operation: String(proposal.operation),
      collision: Boolean(proposal.collision),
      mediaType: String(proposal.mediaType),
      researchGrade: String(proposal.researchGrade ?? "blocked"),
      researchSources: Array.isArray(proposal.researchSources) ? proposal.researchSources.map(String) : [],
      researchBlockers: Array.isArray(proposal.researchBlockers) ? proposal.researchBlockers.map(String) : [],
      evidence: Array.isArray(proposal.evidence) ? proposal.evidence.map(String) : [],
    }));
    if (selected.length !== requestedIds.size) return res.status(400).json({ error: "One or more selected naming proposals are no longer available." });
    const occupied = report.results.map((proposal) => String(proposal.sourcePath));
    const plan = buildPowerRenamePlan(selected, occupied);
    if (!plan.mappings.length) return res.status(400).json({ error: "No selected proposal is safe to plan.", plan });
    const review = ensureReviewItem(ownerId, {
      kind: "naming_proposal",
      subjectKey: plan.planId,
      title: "Review Power Renamer batch",
      payload: { ...plan, summary: powerRenameSummary(plan) },
    });
    return res.status(201).json({ ...plan, summary: powerRenameSummary(plan), reviewItemId: review.id, reviewState: review.state });
  } catch (error) {
    return res.status(400).json({ error: errorMessage(error) });
  }
});

router.post("/archive/power-renamer/operations", (req, res) => {
  try {
    const ownerId = getAuthenticatedUserId(req);
    const review = readReviewItem(Number(req.body?.reviewItemId), ownerId);
    if (!review || review.kind !== "naming_proposal" || review.state !== "approved") return res.status(400).json({ error: "An approved Power Renamer review item is required." });
    const payload = review.payload;
    const mappings = Array.isArray(payload.mappings) ? payload.mappings as Array<Record<string, unknown>> : [];
    if (!mappings.length) return res.status(400).json({ error: "The approved Power Renamer plan has no mappings." });
    const operation = createArchiveOperation({
      action: "rename",
      sourceKind: "power-renamer",
      sourceId: String(payload.planId ?? review.subjectKey),
      reviewItemId: review.id,
      batch: mappings.map((mapping, index) => ({
        id: String(mapping.id ?? `power-renamer-${index}`),
        originalPath: String(mapping.sourcePath),
        temporaryPath: `${String(mapping.sourcePath)}.archive-assistant-tmp-power-${index}`,
        finalPath: String(mapping.destinationPath),
        state: "planned" as const,
      })),
    }, ownerId);
    return res.status(201).json(operation);
  } catch (error) {
    return res.status(400).json({ error: errorMessage(error) });
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
    const report = await readIdentityAudit(getAuthenticatedUserId(req), {
      page: numberQuery("page"),
      pageSize: numberQuery("pageSize"),
      auditType: typeof req.query.auditType === "string" ? req.query.auditType : undefined,
      confidence: typeof req.query.confidence === "string" ? req.query.confidence : undefined,
      mediaType: typeof req.query.mediaType === "string" ? req.query.mediaType : undefined,
      needsReview: booleanQuery,
    });
    res.json(GetArchiveIdentityAuditResponse.parse(report));
  } catch (error) {
    next(error);
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