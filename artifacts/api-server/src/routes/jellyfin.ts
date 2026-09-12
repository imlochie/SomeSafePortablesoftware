import { Router, type IRouter } from "express";
import {
  GetJellyfinConfigResponse,
  GetJellyfinInventoryResponse,
  StartJellyfinSyncResponse,
  TestJellyfinConnectionResponse,
  UpdateJellyfinConfigBody,
  UpdateJellyfinConfigResponse,
} from "@workspace/api-zod";
import { getAuthenticatedUserId } from "../middlewares/requireAuth";
import {
  getJellyfinConfig,
  JellyfinConfigurationError,
  readJellyfinInventory,
  saveJellyfinConfig,
  startJellyfinSync,
  testJellyfinConnection,
} from "../services/jellyfin";

const router: IRouter = Router();

router.get("/jellyfin/config", (req, res) => {
  res.json(GetJellyfinConfigResponse.parse(getJellyfinConfig(getAuthenticatedUserId(req))));
});

router.patch("/jellyfin/config", (req, res) => {
  const ownerId = getAuthenticatedUserId(req);
  const updates = UpdateJellyfinConfigBody.parse(req.body ?? {});
  try {
    return res.json(UpdateJellyfinConfigResponse.parse(saveJellyfinConfig(ownerId, updates)));
  } catch (error) {
    if (error instanceof JellyfinConfigurationError) {
      return res.status(400).json({ error: error.message });
    }
    throw error;
  }
});

router.post("/jellyfin/test-connection", async (req, res) => {
  const result = await testJellyfinConnection(getAuthenticatedUserId(req));
  res.json(TestJellyfinConnectionResponse.parse(result));
});

router.post("/jellyfin/sync", (req, res) => {
  try {
    return res
      .status(202)
      .json(StartJellyfinSyncResponse.parse(startJellyfinSync(getAuthenticatedUserId(req))));
  } catch (error) {
    if (error instanceof JellyfinConfigurationError) {
      return res.status(400).json({ error: error.message });
    }
    throw error;
  }
});

router.get("/jellyfin/inventory", (req, res) => {
  res.json(GetJellyfinInventoryResponse.parse(readJellyfinInventory(getAuthenticatedUserId(req))));
});

export default router;
