import { Router, type IRouter } from "express";
import {
  ApplyArchiveIntakePromotionBody,
  ApplyArchiveIntakePromotionParams,
  ApplyArchiveIntakePromotionResponse,
  GetArchiveIntakeResponse,
  PlanArchiveIntakePromotionParams,
  PlanArchiveIntakePromotionResponse,
} from "@workspace/api-zod";
import { getAuthenticatedUserId } from "../middlewares/requireAuth";
import {
  applyIntakePromotion,
  planIntakePromotion,
  readIntakeItems,
} from "../services/archive-intake";
import { ArchiveMutationError } from "../services/archive-operations";

const router: IRouter = Router();

/**
 * The intake queue. Deliberately read-only and cheap enough to poll: every value
 * on an item is projected from the inventory, quality, naming, reconciliation
 * and acquisition services, so this route cannot put the archive into a state
 * the rest of the API does not already describe.
 */
router.get("/archive/intake", (req, res, next) => {
  void (async () => {
    try {
      const result = await readIntakeItems(getAuthenticatedUserId(req));
      res.json(GetArchiveIntakeResponse.parse(result));
    } catch (error) {
      next(error);
    }
  })();
});

/**
 * Journals a `proposed` operation and returns its dry run. Blocked items fail
 * with 400 and the reason straight from the mutation validator, so a promotion
 * that would need a less safe code path stays visibly unavailable.
 */
router.post("/archive/intake/:jobId/plan", (req, res) => {
  const params = PlanArchiveIntakePromotionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  void (async () => {
    try {
      const result = await planIntakePromotion(getAuthenticatedUserId(req), params.data.jobId);
      res.json(PlanArchiveIntakePromotionResponse.parse(result));
    } catch (error) {
      if (error instanceof ArchiveMutationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      res.status(400).json({ error: error instanceof Error ? error.message : "Intake promotion could not be planned." });
    }
  })();
});

/** Applies a planned promotion through the archive journal. */
router.post("/archive/intake/:jobId/apply", (req, res) => {
  const params = ApplyArchiveIntakePromotionParams.safeParse(req.params);
  const body = ApplyArchiveIntakePromotionBody.safeParse(req.body ?? {});
  if (!params.success || !body.success) {
    res.status(400).json({
      error: params.success ? (body.error?.message ?? "A journaled operation id is required.") : params.error.message,
    });
    return;
  }
  void (async () => {
    try {
      const result = await applyIntakePromotion(
        getAuthenticatedUserId(req),
        params.data.jobId,
        body.data.operationId,
      );
      res.json(ApplyArchiveIntakePromotionResponse.parse(result));
    } catch (error) {
      if (error instanceof ArchiveMutationError) {
        res.status(400).json({ error: error.message });
        return;
      }
      res.status(400).json({ error: error instanceof Error ? error.message : "Intake promotion could not be applied." });
    }
  })();
});

export default router;
