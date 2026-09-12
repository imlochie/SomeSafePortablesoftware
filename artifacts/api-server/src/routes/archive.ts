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

const router: IRouter = Router();

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The archive control plane could not complete the request.";
}

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