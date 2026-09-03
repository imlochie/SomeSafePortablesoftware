import { Router, type IRouter } from "express";
import {
  GetArchiveInventoryResponse,
  GetArchiveRecordParams,
  GetArchiveRecordResponse,
  GetArchiveScanResponse,
  StartArchiveScanResponse,
  UpdateArchiveRecordReviewBody,
  UpdateArchiveRecordReviewParams,
  UpdateArchiveRecordReviewResponse,
} from "@workspace/api-zod";
import { getAuthenticatedUserId } from "../middlewares/requireAuth";
import {
  readArchiveInventory,
  readArchiveRecord,
  readArchiveScan,
  startArchiveScan,
  updateArchiveRecordReview,
} from "../services/archive";

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

export default router;