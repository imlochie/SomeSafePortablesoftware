import { Router, type IRouter } from "express";
import {
  InspectLocalMediaBody,
  InspectLocalMediaResponse,
  InspectMediaSourceBody,
  InspectMediaSourceResponse,
  PrepareDownloadBody,
  PrepareDownloadResponse,
} from "@workspace/api-zod";
import { readSettings } from "../lib/archive-db";
import { inspectLocalMedia, inspectMediaSource, prepareDownload } from "../services/media";

const router: IRouter = Router();

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The local media service could not complete the request.";
}

router.post("/media/inspect", async (req, res) => {
  try {
    const body = InspectMediaSourceBody.parse(req.body ?? {});
    const result = await inspectMediaSource(body.url, readSettings(), body.forceRefresh);
    res.json(InspectMediaSourceResponse.parse(result));
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

router.post("/media/local-inspect", async (req, res) => {
  try {
    const body = InspectLocalMediaBody.parse(req.body ?? {});
    const result = await inspectLocalMedia(body.path, readSettings());
    res.json(InspectLocalMediaResponse.parse(result));
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

router.post("/media/prepare-download", (req, res) => {
  try {
    const body = PrepareDownloadBody.parse(req.body ?? {});
    const result = prepareDownload(body, readSettings());
    res.json(PrepareDownloadResponse.parse(result));
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

export default router;