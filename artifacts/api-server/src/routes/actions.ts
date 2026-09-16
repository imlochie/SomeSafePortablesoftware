import { Router, type IRouter } from "express";
import * as Api from "@workspace/api-zod";
import { getAuthenticatedUserId } from "../middlewares/requireAuth";
import {
  approveActionProposal,
  cancelActionProposal,
  executeActionProposal,
  listActionCapabilities,
  listActionProposals,
  preflightActionProposal,
  readActionProposal,
  retryActionProposal,
  revertActionProposal,
  setActionStepSelection,
} from "../services/action-engine";
import {
  planNamingNormalization,
  readNamingActionCandidates,
} from "../services/naming-actions";
import {
  planReconciliation,
  readReconcileActionCandidates,
} from "../services/reconcile-actions";

const router: IRouter = Router();

function message(error: unknown) {
  return error instanceof Error ? error.message : "The action request failed.";
}

function id(value: string | undefined) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("Id must be a positive integer.");
  return parsed;
}

router.get("/action-capabilities", (_req, res) => {
  res.json(Api.ListActionCapabilitiesResponse.parse(listActionCapabilities()));
});

router.get("/action-proposals", (req, res) => {
  try {
    const query = Api.ListActionProposalsQueryParams.parse(req.query);
    const proposals = listActionProposals(getAuthenticatedUserId(req), {
      status: query.status,
      type: query.type,
      source: query.source,
    });
    res.json(Api.ListActionProposalsResponse.parse(proposals));
  } catch (error) {
    res.status(400).json({ error: message(error) });
  }
});

router.get("/action-proposals/:id", (req, res) => {
  try {
    const proposal = readActionProposal(id(req.params.id), getAuthenticatedUserId(req));
    if (!proposal) return res.status(404).json({ error: "Action proposal not found." });
    return res.json(Api.GetActionProposalResponse.parse(proposal));
  } catch (error) {
    return res.status(400).json({ error: message(error) });
  }
});

router.post("/action-proposals/:id/selection", (req, res) => {
  try {
    const body = Api.UpdateActionStepSelectionBody.parse(req.body);
    const proposal = setActionStepSelection(
      id(req.params.id),
      getAuthenticatedUserId(req),
      body.selections,
    );
    res.json(Api.UpdateActionStepSelectionResponse.parse(proposal));
  } catch (error) {
    res.status(400).json({ error: message(error) });
  }
});

router.post("/action-proposals/:id/approve", (req, res) => {
  try {
    const body = Api.ApproveActionProposalBody.parse(req.body ?? {});
    const proposal = approveActionProposal(
      id(req.params.id),
      getAuthenticatedUserId(req),
      body.note ?? null,
    );
    res.json(Api.ApproveActionProposalResponse.parse(proposal));
  } catch (error) {
    res.status(400).json({ error: message(error) });
  }
});

router.post("/action-proposals/:id/preflight", async (req, res) => {
  try {
    const proposal = await preflightActionProposal(id(req.params.id), getAuthenticatedUserId(req));
    res.json(Api.PreflightActionProposalResponse.parse(proposal));
  } catch (error) {
    res.status(400).json({ error: message(error) });
  }
});

router.post("/action-proposals/:id/execute", async (req, res) => {
  try {
    const body = Api.ExecuteActionProposalBody.parse(req.body);
    const proposal = await executeActionProposal(
      id(req.params.id),
      getAuthenticatedUserId(req),
      body.confirmed,
      undefined,
      { postflight: true },
    );
    res.json(Api.ExecuteActionProposalResponse.parse(proposal));
  } catch (error) {
    res.status(400).json({ error: message(error) });
  }
});

router.post("/action-proposals/:id/revert", async (req, res) => {
  try {
    const body = Api.RevertActionProposalBody.parse(req.body);
    const proposal = await revertActionProposal(
      id(req.params.id),
      getAuthenticatedUserId(req),
      body.confirmed,
    );
    res.json(Api.RevertActionProposalResponse.parse(proposal));
  } catch (error) {
    res.status(400).json({ error: message(error) });
  }
});

router.post("/action-proposals/:id/cancel", (req, res) => {
  try {
    const proposal = cancelActionProposal(id(req.params.id), getAuthenticatedUserId(req));
    res.json(Api.CancelActionProposalResponse.parse(proposal));
  } catch (error) {
    res.status(400).json({ error: message(error) });
  }
});

router.post("/action-proposals/:id/retry", async (req, res) => {
  try {
    const proposal = await retryActionProposal(id(req.params.id), getAuthenticatedUserId(req));
    res.json(Api.RetryActionProposalResponse.parse(proposal));
  } catch (error) {
    res.status(400).json({ error: message(error) });
  }
});

router.get("/archive/naming-actions", async (req, res) => {
  try {
    const query = Api.GetArchiveNamingActionCandidatesQueryParams.parse(req.query);
    const result = await readNamingActionCandidates(getAuthenticatedUserId(req), {
      confidence: query.confidence,
      pattern: query.pattern,
      mediaType: query.mediaType,
      volume: query.volume,
      limit: query.limit,
    });
    res.json(Api.GetArchiveNamingActionCandidatesResponse.parse(result));
  } catch (error) {
    res.status(400).json({ error: message(error) });
  }
});

router.post("/archive/naming-actions", async (req, res) => {
  try {
    const body = Api.PlanArchiveNamingNormalizationBody.parse(req.body ?? {});
    const proposal = await planNamingNormalization(getAuthenticatedUserId(req), {
      confidence: body.confidence,
      pattern: body.pattern,
      mediaType: body.mediaType,
      volume: body.volume,
      limit: body.limit,
      fileRecordIds: body.fileRecordIds,
    });
    res.status(201).json(Api.PlanArchiveNamingNormalizationResponse.parse(proposal));
  } catch (error) {
    res.status(400).json({ error: message(error) });
  }
});

router.get("/archive/reconcile-actions", async (req, res) => {
  try {
    const query = Api.GetArchiveReconcileActionCandidatesQueryParams.parse(req.query);
    const result = await readReconcileActionCandidates(getAuthenticatedUserId(req), {
      limit: query.limit,
    });
    res.json(Api.GetArchiveReconcileActionCandidatesResponse.parse(result));
  } catch (error) {
    res.status(400).json({ error: message(error) });
  }
});

router.post("/archive/reconcile-actions", async (req, res) => {
  try {
    const body = Api.PlanArchiveReconciliationBody.parse(req.body ?? {});
    const proposal = await planReconciliation(getAuthenticatedUserId(req), {
      limit: body.limit,
      fileRecordIds: body.fileRecordIds,
    });
    res.status(201).json(Api.PlanArchiveReconciliationResponse.parse(proposal));
  } catch (error) {
    res.status(400).json({ error: message(error) });
  }
});

export default router;
