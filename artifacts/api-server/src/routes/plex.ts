import { Router, type IRouter } from "express";
import {
  GetPlexConfigResponse,
  GetPlexInventoryResponse,
  StartPlexSyncResponse,
  TestPlexConnectionResponse,
  UpdatePlexConfigBody,
  UpdatePlexConfigResponse,
} from "@workspace/api-zod";
import { getAuthenticatedUserId } from "../middlewares/requireAuth";
import {
  getPlexConfig,
  readPlexArtwork,
  readPlexHierarchy,
  PlexConfigurationError,
  readPlexInventory,
  savePlexConfig,
  startPlexSync,
  testPlexConnection,
} from "../services/plex";

const router: IRouter = Router();

router.get("/plex/config", (req, res) => {
  res.json(GetPlexConfigResponse.parse(getPlexConfig(getAuthenticatedUserId(req))));
});

router.patch("/plex/config", (req, res) => {
  const ownerId = getAuthenticatedUserId(req);
  const updates = UpdatePlexConfigBody.parse(req.body ?? {});
  try {
    return res.json(UpdatePlexConfigResponse.parse(savePlexConfig(ownerId, updates)));
  } catch (error) {
    if (error instanceof PlexConfigurationError) {
      return res.status(400).json({ error: error.message });
    }
    throw error;
  }
});

router.post("/plex/test-connection", async (req, res) => {
  const result = await testPlexConnection(getAuthenticatedUserId(req));
  res.json(TestPlexConnectionResponse.parse(result));
});

router.post("/plex/sync", (req, res) => {
  try {
    return res.status(202).json(StartPlexSyncResponse.parse(startPlexSync(getAuthenticatedUserId(req))));
  } catch (error) {
    if (error instanceof PlexConfigurationError) {
      return res.status(400).json({ error: error.message });
    }
    throw error;
  }
});

router.get("/plex/inventory", (req, res) => {
  res.json(GetPlexInventoryResponse.parse(readPlexInventory(getAuthenticatedUserId(req))));
});

router.get("/plex/hierarchy", (req, res) => {
  const libraryId = typeof req.query.libraryId === "string" && /^\\d+$/.test(req.query.libraryId) ? Number(req.query.libraryId) : undefined;
  const page = typeof req.query.page === "string" ? Number(req.query.page) : 1;
  const pageSize = typeof req.query.pageSize === "string" ? Number(req.query.pageSize) : 24;
  res.json(readPlexHierarchy(getAuthenticatedUserId(req), libraryId, page, pageSize));
});

router.get("/plex/artwork/:ratingKey", async (req, res, next) => {
  try {
    const artwork = await readPlexArtwork(getAuthenticatedUserId(req), req.params.ratingKey);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.type(artwork.contentType).send(artwork.body);
  } catch (error) {
    if (error instanceof PlexConfigurationError) return res.status(400).json({ error: error.message });
    return next(error);
  }
});

export default router;