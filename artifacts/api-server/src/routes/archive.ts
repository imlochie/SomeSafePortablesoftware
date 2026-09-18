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
import { addEvent, archiveDb } from "../lib/archive-db";
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
import { readReconciliationFindingLineage } from "../services/reconciliation-lineage";
import { readNamingProposals } from "../services/naming-intelligence";
import { readIdentityAudit } from "../services/identity-audit";
import { createOrderingProposalSnapshot, readOrderingProposal, currentOrderingProposalValidation } from "../services/ordering-proposals";
import { createArchiveOperation, listArchiveOperations, readArchiveOperation } from "../services/archive-operations";
import { getPlexConfig, startPlexSync } from "../services/plex";
import { getJellyfinConfig, startJellyfinSync } from "../services/jellyfin";
import { ensureReviewItem, readReviewItem } from "../services/review-queue";
import { addPowerRenameCompanions, buildPowerRenamePlan, powerRenameSummary } from "../services/power-renamer";

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

router.get("/archive/reconciliation/findings/:reviewItemId/lineage", (req, res, next) => {
  try {
    const reviewItemId = Number(req.params.reviewItemId);
    if (!Number.isInteger(reviewItemId) || reviewItemId < 1) return res.status(400).json({ message: "Review item id must be positive." });
    const lineage = readReconciliationFindingLineage(getAuthenticatedUserId(req), reviewItemId);
    if (!lineage) return res.status(404).json({ message: "Reconciliation finding not found." });
    return res.json(lineage);
  } catch (error) {
    return next(error);
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
    const sourceRows = archiveDb.prepare("SELECT id, checksum, fingerprint, size_bytes FROM file_record WHERE owner_id = ?").all(ownerId) as Array<{ id: number; checksum: string | null; fingerprint: string | null; size_bytes: number | null }>;
    const sourceById = new Map(sourceRows.map((row) => [row.id, row]));
    const selected = report.results.filter((proposal) => requestedIds.has(Number(proposal.fileRecordId))).map((proposal) => ({
      fileRecordId: Number(proposal.fileRecordId),
      sourcePath: String(proposal.sourcePath),
      sourceIdentity: (() => { const row = sourceById.get(Number(proposal.fileRecordId)); return `file_record:${Number(proposal.fileRecordId)}:${row?.checksum ?? row?.fingerprint ?? "unknown"}`; })(),
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
    let plan = buildPowerRenamePlan(selected, occupied);
    if (!plan.mappings.length) return res.status(400).json({ error: "No selected proposal is safe to plan.", plan });
    const companionRows = archiveDb.prepare("SELECT id, path, checksum, fingerprint, size_bytes FROM file_record WHERE owner_id = ? AND scan_status = 'active'").all(ownerId) as Array<{ id: number; path: string; checksum: string | null; fingerprint: string | null; size_bytes: number | null }>;
    const companionRecords = companionRows.map((row) => ({ id: row.id, path: row.path, identity: `file_record:${row.id}:${row.checksum ?? row.fingerprint ?? "unknown"}` }));
    plan = addPowerRenameCompanions(plan, companionRecords, companionRows.map((row) => row.path));
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
    const expected = payload.expectedSourceIdentities && typeof payload.expectedSourceIdentities === "object" ? payload.expectedSourceIdentities as Record<string, unknown> : {};
    for (const mapping of mappings) {
      const originalPath = String(mapping.sourcePath);
      const expectedIdentity = expected[originalPath];
      if (typeof expectedIdentity !== "string") return res.status(400).json({ error: `Power Renamer plan has no source identity for ${originalPath}.` });
      if (expectedIdentity.endsWith(":unknown")) return res.status(409).json({ error: `INSUFFICIENT_POWER_RENAMER_IDENTITY: ${originalPath} has no stable checksum or fingerprint.` });
      const row = archiveDb.prepare("SELECT id, checksum, fingerprint, size_bytes, scan_status FROM file_record WHERE owner_id = ? AND path = ?").get(ownerId, originalPath) as { id: number; checksum: string | null; fingerprint: string | null; size_bytes: number | null; scan_status: string } | undefined;
      const currentIdentity = row ? `file_record:${row.id}:${row.checksum ?? row.fingerprint ?? row.size_bytes ?? "unknown"}` : null;
      if (!row || row.scan_status !== "active" || currentIdentity !== expectedIdentity) return res.status(409).json({ error: `STALE_POWER_RENAMER_PLAN: source changed or disappeared: ${originalPath}` });
    }
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

router.get("/archive-operations/:id/provider-status", (req, res) => {
  try {
    const ownerId = getAuthenticatedUserId(req);
    const operation = readArchiveOperation(Number(req.params.id), ownerId);
    if (!operation) return res.status(404).json({ error: "Archive operation not found." });
    return res.json({ operationId: operation.id, operationStatus: operation.status, providers: { plex: getPlexConfig(ownerId), jellyfin: getJellyfinConfig(ownerId) }, checkedAt: new Date().toISOString() });
  } catch (error) {
    return res.status(400).json({ error: errorMessage(error) });
  }
});

router.post("/archive-operations/:id/refresh-providers", (req, res) => {
  try {
    const ownerId = getAuthenticatedUserId(req);
    if (req.body?.confirmed !== true) return res.status(400).json({ error: "Explicit provider refresh confirmation is required." });
    const operation = readArchiveOperation(Number(req.params.id), ownerId);
    if (!operation) return res.status(404).json({ error: "Archive operation not found." });
    if (!["completed", "rolled_back"].includes(operation.status)) return res.status(400).json({ error: "Provider refresh requires a completed or verified rolled-back archive operation." });
    const requested = req.body?.providers;
    if (Array.isArray(requested) && (requested.length === 0 || requested.some((value: unknown) => value !== "plex" && value !== "jellyfin"))) {
      return res.status(400).json({ error: "providers must contain one or more supported values: plex or jellyfin." });
    }
    const providers = Array.isArray(requested) ? [...new Set(requested as string[])] : ["plex", "jellyfin"];
    const started: string[] = [];
    const skipped: Array<{ provider: string; reason: string }> = [];
    if (providers.includes("plex")) {
      if (!getPlexConfig(ownerId).configured) skipped.push({ provider: "plex", reason: "Plex is not configured." });
      else { try { startPlexSync(ownerId); started.push("plex"); } catch (error) { skipped.push({ provider: "plex", reason: errorMessage(error) }); } }
    }
    if (providers.includes("jellyfin")) {
      if (!getJellyfinConfig(ownerId).configured) skipped.push({ provider: "jellyfin", reason: "Jellyfin is not configured." });
      else { try { startJellyfinSync(ownerId); started.push("jellyfin"); } catch (error) { skipped.push({ provider: "jellyfin", reason: errorMessage(error) }); } }
    }
    const providerStates = {
      plex: getPlexConfig(ownerId),
      jellyfin: getJellyfinConfig(ownerId),
    };
    addEvent("info", `Provider refresh requested after archive operation ${operation.id}. Started: ${started.join(", ") || "none"}.`, "archive-operations", ownerId);
    return res.status(202).json({ operationId: operation.id, started, skipped, providerStates, requestedAt: new Date().toISOString(), notice: "Provider refresh was explicitly requested after verified filesystem changes. Poll provider status before treating reconciliation as complete." });
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