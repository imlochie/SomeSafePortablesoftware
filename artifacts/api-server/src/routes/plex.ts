import { Router, type IRouter } from "express";
import {
  GetPlexConfigResponse,
  UpdatePlexConfigBody,
  UpdatePlexConfigResponse,
} from "@workspace/api-zod";
import { readUserSetting, writeUserSetting } from "../lib/archive-db";
import { getAuthenticatedUserId } from "../middlewares/requireAuth";

const router: IRouter = Router();

function readPlexConfig(ownerId: string) {
  const serverUrl = typeof readUserSetting(ownerId, "plexServerUrl") === "string"
    ? readUserSetting(ownerId, "plexServerUrl") as string
    : "";
  const token = readUserSetting(ownerId, "plexToken");
  const hasToken = typeof token === "string" && token.length > 0;
  const configured = Boolean(serverUrl && hasToken);
  return {
    serverUrl,
    configured,
    hasToken,
    status: configured ? ("ready" as const) : ("not_configured" as const),
  };
}

router.get("/plex/config", (req, res) => {
  res.json(GetPlexConfigResponse.parse(readPlexConfig(getAuthenticatedUserId(req))));
});

router.patch("/plex/config", (req, res) => {
  const ownerId = getAuthenticatedUserId(req);
  const updates = UpdatePlexConfigBody.parse(req.body ?? {});
  if (updates.serverUrl !== undefined) {
    writeUserSetting(ownerId, "plexServerUrl", updates.serverUrl);
  }
  if (updates.token !== undefined && updates.token.length > 0) {
    writeUserSetting(ownerId, "plexToken", updates.token);
  }
  res.json(UpdatePlexConfigResponse.parse(readPlexConfig(ownerId)));
});

export default router;