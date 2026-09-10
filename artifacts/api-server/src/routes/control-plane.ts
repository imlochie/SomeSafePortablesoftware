import { Router, type IRouter, type Request, type Response } from "express";
import * as Api from "@workspace/api-zod";
import { getAuthenticatedUserId } from "../middlewares/requireAuth";
import {
  ensureReviewItem,
  listReviewItems,
  readReviewItem,
  approveReviewItem,
  rejectReviewItem,
  deferReviewItem,
  reopenReviewItem,
} from "../services/review-queue";
import {
  generateAcquisitionRecommendations,
  listAcquisitionRecommendations,
  readAcquisitionRecommendation,
} from "../services/acquisition-intelligence";
import {
  createArchiveOperation,
  listArchiveOperations,
  readArchiveOperation,
  preflightArchiveOperation,
  executeArchiveOperation,
  cancelArchiveOperation,
  retryArchiveOperation,
  rollbackArchiveOperation,
} from "../services/archive-operations";
import {
  createApprovedAcquisitionJob,
  linkAcquisitionDownload,
  planApprovedAcquisitionImport,
} from "../services/acquisition-orchestration";

const router: IRouter = Router();

function message(error: unknown) {
  return error instanceof Error ? error.message : "The control-plane request failed.";
}

function id(value: string | undefined) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("Id must be a positive integer.");
  return parsed;
}

router.get("/acquisition-recommendations", (req, res) => {
  try {
    const query = Api.ListAcquisitionRecommendationsQueryParams.parse(req.query);
    const result = listAcquisitionRecommendations(getAuthenticatedUserId(req), query);
    res.json(Api.ListAcquisitionRecommendationsResponse.parse(result));
  } catch (error) {
    res.status(400).json({ error: message(error) });
  }
});

router.post("/acquisition-recommendations", async (req, res) => {
  try {
    const result = await generateAcquisitionRecommendations(getAuthenticatedUserId(req));
    res.json(Api.GenerateAcquisitionRecommendationsResponse.parse(result));
  } catch (error) {
    res.status(400).json({ error: message(error) });
  }
});

router.get("/acquisition-recommendations/:id", (req, res) => {
  try {
    const recommendation = readAcquisitionRecommendation(id(req.params.id), getAuthenticatedUserId(req));
    if (!recommendation) return res.status(404).json({ error: "Recommendation not found." });
    return res.json(Api.GetAcquisitionRecommendationResponse.parse(recommendation));
  } catch (error) {
    return res.status(400).json({ error: message(error) });
  }
});

router.get("/review-items", (req, res) => {
  try {
    const query = Api.ListReviewItemsQueryParams.parse(req.query);
    const result = listReviewItems(getAuthenticatedUserId(req), query);
    res.json(Api.ListReviewItemsResponse.parse(result));
  } catch (error) {
    res.status(400).json({ error: message(error) });
  }
});

router.post("/review-items", (req, res) => {
  try {
    const body = Api.CreateReviewItemBody.parse(req.body);
    const item = ensureReviewItem(getAuthenticatedUserId(req), body);
    res.status(201).json(Api.CreateReviewItemResponse.parse(item));
  } catch (error) {
    res.status(400).json({ error: message(error) });
  }
});

router.get("/review-items/:id", (req, res) => {
  try {
    const item = readReviewItem(id(req.params.id), getAuthenticatedUserId(req));
    if (!item) return res.status(404).json({ error: "Review item not found." });
    return res.json(Api.GetReviewItemResponse.parse(item));
  } catch (error) {
    return res.status(400).json({ error: message(error) });
  }
});

function decisionRoute(
  decide: typeof approveReviewItem,
  response: { parse(value: unknown): unknown },
) {
  return (req: Request, res: Response) => {
    try {
      const body = Api.ApproveReviewQueueItemBody.parse(req.body ?? {});
      const item = decide(id(String(req.params.id)), getAuthenticatedUserId(req), body.note);
      res.json(response.parse(item));
    } catch (error) {
      res.status(400).json({ error: message(error) });
    }
  };
}

router.post("/review-items/:id/approve", decisionRoute(approveReviewItem, Api.ApproveReviewQueueItemResponse));
router.post("/review-items/:id/reject", decisionRoute(rejectReviewItem, Api.RejectReviewQueueItemResponse));
router.post("/review-items/:id/defer", decisionRoute(deferReviewItem, Api.DeferReviewQueueItemResponse));
router.post("/review-items/:id/reopen", decisionRoute(reopenReviewItem, Api.ReopenReviewQueueItemResponse));

router.post("/review-items/:id/acquisition-job", async (req, res) => {
  try {
    const result = await createApprovedAcquisitionJob(id(req.params.id), getAuthenticatedUserId(req));
    res.json(Api.CreateApprovedAcquisitionJobResponse.parse(result));
  } catch (error) {
    res.status(400).json({ error: message(error) });
  }
});

router.get("/archive-operations", (req, res) => {
  try {
    const query = Api.ListArchiveOperationsQueryParams.parse(req.query);
    const result = listArchiveOperations(getAuthenticatedUserId(req), query.status);
    res.json(Api.ListArchiveOperationsResponse.parse(result));
  } catch (error) {
    res.status(400).json({ error: message(error) });
  }
});

router.post("/archive-operations", (req, res) => {
  try {
    const body = Api.CreateArchiveOperationBody.parse(req.body);
    const operation = createArchiveOperation(body, getAuthenticatedUserId(req));
    res.status(201).json(Api.CreateArchiveOperationResponse.parse(operation));
  } catch (error) {
    res.status(400).json({ error: message(error) });
  }
});

router.get("/archive-operations/:id", (req, res) => {
  try {
    const operation = readArchiveOperation(id(req.params.id), getAuthenticatedUserId(req));
    if (!operation) return res.status(404).json({ error: "Archive operation not found." });
    return res.json(Api.GetArchiveOperationResponse.parse(operation));
  } catch (error) {
    return res.status(400).json({ error: message(error) });
  }
});

router.post("/archive-operations/:id/preflight", async (req, res) => {
  try {
    const operation = await preflightArchiveOperation(id(req.params.id), getAuthenticatedUserId(req));
    res.json(Api.PreflightArchiveOperationResponse.parse(operation));
  } catch (error) {
    res.status(400).json({ error: message(error) });
  }
});

router.post("/archive-operations/:id/execute", async (req, res) => {
  try {
    const body = Api.ExecuteArchiveOperationBody.parse(req.body);
    const operation = await executeArchiveOperation(id(req.params.id), getAuthenticatedUserId(req), body.confirmed);
    res.json(Api.ExecuteArchiveOperationResponse.parse(operation));
  } catch (error) {
    res.status(400).json({ error: message(error) });
  }
});

router.post("/archive-operations/:id/cancel", (req, res) => {
  try {
    const operation = cancelArchiveOperation(id(req.params.id), getAuthenticatedUserId(req));
    res.json(Api.CancelArchiveOperationResponse.parse(operation));
  } catch (error) {
    res.status(400).json({ error: message(error) });
  }
});

router.post("/archive-operations/:id/retry", async (req, res) => {
  try {
    const operation = await retryArchiveOperation(id(req.params.id), getAuthenticatedUserId(req));
    res.json(Api.RetryArchiveOperationResponse.parse(operation));
  } catch (error) {
    res.status(400).json({ error: message(error) });
  }
});

router.post("/archive-operations/:id/rollback", async (req, res) => {
  try {
    const body = Api.RollbackArchiveOperationBody.parse(req.body);
    const operation = await rollbackArchiveOperation(id(req.params.id), getAuthenticatedUserId(req), body.confirmed);
    res.json(Api.RollbackArchiveOperationResponse.parse(operation));
  } catch (error) {
    res.status(400).json({ error: message(error) });
  }
});

router.post("/acquisition-jobs/:id/download", (req, res) => {
  try {
    const body = Api.LinkAcquisitionDownloadBody.parse(req.body);
    const job = linkAcquisitionDownload(id(req.params.id), body.downloadJobId, getAuthenticatedUserId(req));
    res.json(Api.LinkAcquisitionDownloadResponse.parse(job));
  } catch (error) {
    res.status(400).json({ error: message(error) });
  }
});

router.post("/acquisition-jobs/:id/import", (req, res) => {
  try {
    const body = Api.PlanApprovedAcquisitionImportBody.parse(req.body);
    const operation = planApprovedAcquisitionImport(
      id(req.params.id),
      body.destinationPath,
      getAuthenticatedUserId(req),
      body.dryRun,
    );
    res.status(201).json(Api.PlanApprovedAcquisitionImportResponse.parse(operation));
  } catch (error) {
    res.status(400).json({ error: message(error) });
  }
});

export default router;