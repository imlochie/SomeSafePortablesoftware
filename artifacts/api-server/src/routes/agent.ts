import { Router, type IRouter } from "express";
import * as Api from "@workspace/api-zod";
import { getAuthenticatedUserId } from "../middlewares/requireAuth";
import { runtimeConfig } from "../lib/runtime-config";
import { readEvents, readSettings } from "../lib/archive-db";
import { createArchiveOperation } from "../services/archive-operations";
import { readAssistantOverview } from "../services/assistant-overview";
import { researchCandidate } from "../services/media-research";
import { synthesizeViewingResearch } from "../services/research-synthesis";
import { inspectMediaSource, resolvePublicRedirects } from "../services/media";
import { createJob, startJob } from "../services/download-engine";
import { ensureReviewItem, readReviewItem } from "../services/review-queue";
import { checkSourceMonitor, createSourceMonitor, deleteSourceMonitor, listMonitorNotifications, listSourceMonitors, markMonitorNotificationRead, updateSourceMonitor } from "../services/source-monitor";
import { askArenaCanonical, arenaCanonicalStatus, arenaToolManifest } from "../services/arena-canonical-client";
import { buildViewingPrioritySignals } from "../services/media-experience";

const router: IRouter = Router();

function message(error: unknown) {
  return error instanceof Error ? error.message : "The agent request failed.";
}

router.get("/agent/canonical/status", (_req, res) => { res.json(arenaCanonicalStatus()); });
router.get("/agent/canonical/tools", (_req, res) => { res.json(arenaToolManifest()); });
router.post("/agent/canonical/ask", async (req, res, next) => {
  try {
    const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    if (!question) return res.status(400).json({ error: "question is required" });
    if (question.length > 2000) return res.status(400).json({ error: "question must be 2000 characters or fewer" });
    return res.json(await askArenaCanonical(getAuthenticatedUserId(req), question));
  } catch (error) { return next(error); }
});

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


function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/(?:[A-Za-z]:\\|\\\\|\/)(?:[^\s/\\]+[\/\\])+[^\s/\\]+/g, "[local path redacted]")
      .replace(/\b(?:plex|jellyfin)_[a-z0-9_]+\b/gi, "[provider identifier redacted]");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
  }
  return value;
}

function insightPriority(priority: string, state: string, itemCount: number) {
  const priorityScores: Record<string, number> = { critical: 100, high: 75, medium: 50, low: 25, info: 0 };
  const priorityScore = priorityScores[priority] ?? 0;
  const stateScore = state === "actionable" ? 20 : state === "uncertain" ? 10 : state === "blocked" ? 5 : 0;
  return priorityScore + stateScore + Math.min(itemCount, 20);
}

function buildInsightBrief(overview: Awaited<ReturnType<typeof readAssistantOverview>>, question: string, maxActions: number, includeOperationPlans: boolean) {
  const candidates = overview.groups
    .map((group) => ({
      id: group.id,
      type: group.type,
      title: group.title,
      state: group.state,
      priority: group.priority,
      confidence: group.confidence,
      itemCount: group.itemCount,
      evidence: group.evidence,
      whyItMatters: group.type === "identity"
        ? "Identity ambiguity can contaminate provider matching, naming, and later automation."
        : group.type === "duplicate"
          ? "Duplicate evidence can affect storage decisions, but interchangeability must be verified before removal."
          : group.type === "integrity"
            ? "Integrity findings can indicate a playback risk, but inspection limits must not be treated as proof of corruption."
            : group.type === "rename"
              ? "High-confidence naming work can improve provider matching without changing media bytes."
              : group.type === "download"
                ? "Acquisition should be weighed against storage, availability, and the user's viewing signals."
                : "This finding may affect archive correctness and should be evaluated with its evidence.",
      recommendedAction: group.recommendedAction,
      risk: group.state === "uncertain" ? "medium" : group.state === "blocked" ? "high" : group.priority === "critical" ? "high" : "low",
      reversible: group.type !== "duplicate",
      score: insightPriority(group.priority, group.state, group.itemCount),
    }))
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
    .slice(0, maxActions)
    .map(({ score: _score, ...candidate }) => candidate);

  return {
    kind: "archive_insight_brief",
    contract: "agent-insight-v1",
    generatedAt: new Date().toISOString(),
    question,
    source: { system: "archive-assistant", ownerScoped: true },
    safety: { approvalRequired: true, preflightRequired: true, directMutation: false, providerExecution: false },
    answerRequirements: [
      "Answer the user's question directly; do not restate raw counts as the conclusion.",
      "Cite the supplied evidence IDs or group IDs for every material claim.",
      "Separate known facts, likely interpretations, and unknowns.",
      "Explain why the recommendation matters to this user's archive or viewing patterns.",
      includeOperationPlans ? "If proposing a change, describe benefit, risk, reversibility, and use the operation planning boundary." : "Do not propose an operation plan unless the user explicitly asks for one.",
    ],
    snapshot: {
      summary: overview.summary,
      activeWork: overview.activeWork,
      informational: overview.informational,
      lastScan: overview.summary.lastScan,
    },
    prioritizedEvidence: candidates,
    personalSignals: {
      sourceStatus: overview.mediaExperience.sourceStatus,
      summary: overview.mediaExperience.summary,
      currentViewingMomentum: overview.mediaExperience.currentViewingMomentum,
      personalizedBriefing: overview.personalizedBriefing.slice(0, maxActions * 3),
    },
    unknowns: overview.uncertain.slice(0, maxActions * 3).map((item) => ({
      id: item.id, title: item.title, confidence: item.confidence, explanation: item.explanation, evidence: item.evidence,
    })),
  };
}

router.get("/agent/monitoring/sources", async (req, res, next) => {
  try { return res.json({ sources: await listSourceMonitors(getAuthenticatedUserId(req), readSettings()), notifications: await listMonitorNotifications(getAuthenticatedUserId(req), readSettings()) }); }
  catch (error) { return next(error); }
});

router.post("/agent/monitoring/sources", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!url) return res.status(400).json({ error: "url is required" });
    const targets = Array.isArray(body.targets) ? body.targets : [];
    const discovery = body.discovery === true;
    if (!targets.length && !discovery) return res.status(400).json({ error: "at least one watch target or discovery mode is required" });
    const source = await createSourceMonitor(getAuthenticatedUserId(req), { name: body.name, url, kind: body.kind, intervalMinutes: body.intervalMinutes, targets, discovery }, readSettings());
    return res.status(201).json(source);
  } catch (error) { return next(error); }
});

router.patch("/agent/monitoring/sources/:id", async (req, res, next) => {
  try { return res.json(await updateSourceMonitor(getAuthenticatedUserId(req), req.params.id, req.body ?? {}, readSettings())); }
  catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "Source monitor could not be updated." }); }
});

router.post("/agent/monitoring/notifications/:id/read", async (req, res, next) => {
  try { return res.json(await markMonitorNotificationRead(getAuthenticatedUserId(req), req.params.id, readSettings())); }
  catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "Notification could not be updated." }); }
});

router.post("/agent/monitoring/sources/:id/check", async (req, res, next) => {
  try { return res.json(await checkSourceMonitor(getAuthenticatedUserId(req), req.params.id, readSettings())); }
  catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "Source check failed." }); }
});

router.delete("/agent/monitoring/sources/:id", async (req, res, next) => {
  try { await deleteSourceMonitor(getAuthenticatedUserId(req), req.params.id, readSettings()); return res.status(204).send(); }
  catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "Source monitor could not be deleted." }); }
});

router.post("/agent/downloads/resolve", async (req, res, next) => {
  try {
    const sourceUrl = typeof req.body?.sourceUrl === "string" ? req.body.sourceUrl.trim() : "";
    if (!sourceUrl) return res.status(400).json({ error: "sourceUrl is required" });
    return res.json({ kind: "public_redirect_resolution", contract: "agent-download-v1", ...(await resolvePublicRedirects(sourceUrl)) });
  } catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : "Public redirect resolution failed." }); }
});

router.post("/agent/downloads/inspect", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const sourceUrl = typeof body.sourceUrl === "string" ? body.sourceUrl.trim() : "";
    if (!sourceUrl) return res.status(400).json({ error: "sourceUrl is required" });
    const inspection = await inspectMediaSource(sourceUrl, readSettings(), body.forceRefresh === true);
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : inspection.metadata.title;
    const ownerId = getAuthenticatedUserId(req);
    const review = ensureReviewItem(ownerId, {
      kind: "operation_approval",
      subjectKey: `agent-download:${inspection.metadata.sourceId ?? sourceUrl}`,
      title: `Download highest quality source: ${title}`,
      payload: {
        sourceUrl, title, selectedFormatId: inspection.recommendedFormatId,
        selectedVideoFormatId: inspection.recommendedVideoFormatId,
        selectedAudioFormatId: inspection.recommendedAudioFormatId,
        recommendationExplanation: inspection.recommendationExplanation,
      },
    });
    return res.json(redact({
      kind: "download_source_selection", contract: "agent-download-v1",
      source: inspection.metadata,
      selected: {
        formatId: inspection.recommendedFormatId, videoFormatId: inspection.recommendedVideoFormatId,
        audioFormatId: inspection.recommendedAudioFormatId, explanation: inspection.recommendationExplanation,
      },
      alternatives: inspection.formats.slice(0, 50),
      review: { id: review.id, state: review.state, approvalRequired: true },
      safety: { queuedOnlyUntilApproval: true, directMutation: false, postDownloadVerification: true },
    }));
  } catch (error) {
    return next(error);
  }
});

router.post("/agent/downloads/queue", (req, res, next) => {
  try {
    const body = req.body ?? {};
    const ownerId = getAuthenticatedUserId(req);
    const reviewItemId = Number(body.reviewItemId);
    if (!Number.isInteger(reviewItemId) || reviewItemId < 1) return res.status(400).json({ error: "An approved reviewItemId is required" });
    const review = readReviewItem(reviewItemId, ownerId);
    if (!review || review.kind !== "operation_approval") return res.status(400).json({ error: "Download approval review item not found" });
    if (review.state !== "approved") return res.status(400).json({ error: "Download requires explicit approval before queueing" });
    const payload = review.payload;
    const sourceUrl = typeof body.sourceUrl === "string" ? body.sourceUrl : payload.sourceUrl;
    const title = typeof body.title === "string" ? body.title : payload.title;
    if (sourceUrl !== payload.sourceUrl || title !== payload.title) return res.status(400).json({ error: "Download request does not match the approved source plan" });
    const job = createJob({
      sourceUrl, title, sourceSite: typeof body.sourceSite === "string" ? body.sourceSite : undefined,
      selectedFormatId: typeof body.selectedFormatId === "string" ? body.selectedFormatId : String(payload.selectedFormatId ?? "best"),
      selectedVideoFormatId: typeof body.selectedVideoFormatId === "string" ? body.selectedVideoFormatId : (payload.selectedVideoFormatId as string | undefined),
      selectedAudioFormatId: typeof body.selectedAudioFormatId === "string" ? body.selectedAudioFormatId : (payload.selectedAudioFormatId as string | undefined),
      outputContainer: body.outputContainer, temporaryDirectory: body.temporaryDirectory,
      destinationDirectory: body.destinationDirectory, finalFilename: body.finalFilename,
    }, ownerId);
    if (!job) throw new Error("Download job could not be read after queueing.");
    const started = body.start === true ? startJob(job.id, ownerId) : job;
    return res.status(201).json(redact({ kind: "download_queued", contract: "agent-download-v1", job: started, started: body.start === true, verification: "post_download_ffprobe_and_archive_move" }));
  } catch (error) {
    return next(error);
  }
});

router.post("/agent/research", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (query.length > 1000) return res.status(400).json({ error: "query must be 1000 characters or fewer" });
    const ownerId = getAuthenticatedUserId(req);
    const overview = await readAssistantOverview(ownerId);
    const includeComparisons = body.includeComparisons !== false;
    const includeUpcoming = body.includeUpcoming !== false;
    const queryResearch = query ? await researchCandidate(ownerId, query) : { status: "not_requested" as const, items: [] };
    let comparisons: Awaited<ReturnType<typeof synthesizeViewingResearch>> | null = null;
    let comparisonError: string | null = null;
    if (includeComparisons) {
      try {
        comparisons = await synthesizeViewingResearch(ownerId);
      } catch (error) {
        comparisonError = error instanceof Error ? error.message : "External comparison was unavailable.";
      }
    }
    const sources = [
      { id: "archive", role: "archive truth and local inventory", available: true },
      { id: "plex-jellyfin", role: "synced provider metadata and viewing history", available: overview.mediaExperience.sourceStatus === "provider_metadata" },
      { id: "tvmaze", role: "show search, release metadata, cast and crew relationships", available: queryResearch.status === "available" || comparisons?.source?.includes("tvmaze") === true },
      { id: "imdb", role: "independent audience and popularity evidence", available: Boolean(process.env.IMDB_API_URL_TEMPLATE?.trim() && process.env.IMDB_API_TOKEN?.trim()), limitation: "Requires explicit IMDb API configuration." },
    ];
    const upcoming = includeUpcoming ? {
      status: overview.discovery.upcoming.status,
      reason: overview.discovery.upcoming.reason,
      items: overview.discovery.upcoming.items.slice(0, 50),
      note: "Upcoming items come from synced provider release metadata; external release calendars are not assumed."
    } : { status: "not_requested", items: [] };
    return res.json(redact({
      kind: "archive_research_brief", contract: "agent-research-v1", generatedAt: new Date().toISOString(),
      question: query || null, ownerScoped: true,
      sourcePolicy: { sources, no_source_is_treated_as_authoritative_for_personal_taste: true },
      upcoming,
      recent: includeUpcoming ? overview.discovery.recentlyReleased.items.slice(0, 50) : [],
      queryResearch,
      comparisons: comparisons ? { status: comparisons.status, source: comparisons.source, items: comparisons.items.slice(0, 50), bounds: comparisons.bounds, identityUncertain: comparisons.identityUncertain } : { status: "unavailable", reason: comparisonError ?? "not_requested", items: [] },
      comparisonLimitations: [
        "Ratings and popularity are external signals, not evidence of what this user will enjoy.",
        "A missing external source or identity match remains unknown, not negative evidence.",
        ...(comparisonError ? [comparisonError] : []),
      ],
      personalContext: { summary: overview.mediaExperience.summary, currentViewingMomentum: overview.mediaExperience.currentViewingMomentum, prioritySignals: buildViewingPrioritySignals(overview.mediaExperience), personalizedBriefing: overview.personalizedBriefing.slice(0, 50) },
    }));
  } catch (error) {
    return next(error);
  }
});

router.post("/agent/insights", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!question) return res.status(400).json({ error: "question is required" });
    if (question.length > 2000) return res.status(400).json({ error: "question must be 2000 characters or fewer" });
    const maxActions = typeof body.maxActions === "number" && Number.isInteger(body.maxActions)
      ? Math.max(1, Math.min(5, body.maxActions))
      : 3;
    const includeOperationPlans = body.includeOperationPlans !== false;
    const overview = await readAssistantOverview(getAuthenticatedUserId(req));
    return res.json(redact(buildInsightBrief(overview, question, maxActions, includeOperationPlans)));
  } catch (error) {
    return next(error);
  }
});

router.get("/agent/context", async (req, res, next) => {
  try {
    const overview = await readAssistantOverview(getAuthenticatedUserId(req));
    const context = {
      generatedAt: new Date().toISOString(),
      source: { system: "archive-assistant", contract: "agent-context-v1", ownerScoped: true },
      safety: {
        mode: "evidence_only",
        approvalRequired: true,
        preflightRequired: true,
        directMutation: false,
        providerExecution: false,
        unknownsMustRemainExplicit: true,
      },
      archive: {
        summary: overview.summary,
        activeWork: overview.activeWork,
        informational: overview.informational,
        attention: overview.attention.slice(0, 50),
        groups: overview.groups.slice(0, 100),
        blocked: overview.blocked.slice(0, 50),
        uncertain: overview.uncertain.slice(0, 50),
      },
      personal: {
        sourceStatus: overview.mediaExperience.sourceStatus,
        summary: overview.mediaExperience.summary,
        currentViewingMomentum: overview.mediaExperience.currentViewingMomentum,
        personalizedBriefing: overview.personalizedBriefing.slice(0, 50),
        prioritySignals: buildViewingPrioritySignals(overview.mediaExperience),
        viewingEvidence: overview.mediaExperience.items.slice(0, 250).map((item) => ({
          key: item.key, title: item.title, provider: item.provider, itemType: item.itemType,
          year: item.year, genres: item.genres, status: item.status, progressPercent: item.progressPercent,
          playCount: item.playCount, lastWatchedAt: item.lastWatchedAt, watchedMinutes: item.watchedMinutes,
          seriesTitle: item.seriesTitle, seasonNumber: item.seasonNumber, episodeNumber: item.episodeNumber,
          seriesProgress: item.seriesProgress, isNextEpisode: item.isNextEpisode, evidence: item.evidence,
        })),
      },
    };
    res.json(redact(context));
  } catch (error) {
    next(error);
  }
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
