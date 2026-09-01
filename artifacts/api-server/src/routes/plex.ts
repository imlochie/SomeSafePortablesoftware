import { Router, type IRouter } from "express";
import {
  GetPlexConfigResponse,
  UpdatePlexConfigBody,
  UpdatePlexConfigResponse,
} from "@workspace/api-zod";
import { archiveDb } from "../lib/archive-db";

const router: IRouter = Router();

function readPlexConfig() {
  const rows = archiveDb
    .prepare("SELECT key, value FROM setting WHERE key IN ('plexServerUrl', 'plexToken')")
    .all() as Array<{ key: string; value: string }>;
  const values = Object.fromEntries(
    rows.map((row) => {
      try {
        return [row.key, JSON.parse(row.value)];
      } catch {
        return [row.key, row.value];
      }
    }),
  ) as { plexServerUrl?: string; plexToken?: string };
  const serverUrl = values.plexServerUrl ?? "";
  const hasToken = Boolean(values.plexToken);
  const configured = Boolean(serverUrl && hasToken);
  return {
    serverUrl,
    configured,
    hasToken,
    status: configured ? ("ready" as const) : ("not_configured" as const),
  };
}

router.get("/plex/config", (_req, res) => {
  res.json(GetPlexConfigResponse.parse(readPlexConfig()));
});

router.patch("/plex/config", (req, res) => {
  const updates = UpdatePlexConfigBody.parse(req.body ?? {});
  const statement = archiveDb.prepare(
    "INSERT INTO setting (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
  );
  if (updates.serverUrl !== undefined) {
    statement.run("plexServerUrl", JSON.stringify(updates.serverUrl));
  }
  if (updates.token !== undefined && updates.token.length > 0) {
    statement.run("plexToken", JSON.stringify(updates.token));
  }
  res.json(UpdatePlexConfigResponse.parse(readPlexConfig()));
});

export default router;