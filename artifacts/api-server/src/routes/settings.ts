import { Router, type IRouter } from "express";
import {
  GetSettingsResponse,
  UpdateSettingsBody,
  UpdateSettingsResponse,
} from "@workspace/api-zod";
import { readSettings, writeSettings } from "../lib/archive-db";

const router: IRouter = Router();

router.get("/settings", (_req, res) => {
  res.json(GetSettingsResponse.parse(readSettings()));
});

router.patch("/settings", (req, res) => {
  const updates = UpdateSettingsBody.parse(req.body ?? {});
  res.json(UpdateSettingsResponse.parse(writeSettings(updates)));
});

export default router;