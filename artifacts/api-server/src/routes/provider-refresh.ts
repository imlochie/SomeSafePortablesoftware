import { Router, type IRouter } from "express";
import { getAuthenticatedUserId } from "../middlewares/requireAuth";
import { providerNames, readProviderRefreshHistory, readProviderRefreshState, type ProviderName } from "../services/provider-refresh";

const router: IRouter = Router();

function provider(value: unknown): ProviderName {
  if (typeof value === "string" && providerNames.includes(value as ProviderName)) return value as ProviderName;
  throw new Error("Provider must be plex or jellyfin.");
}

router.get("/provider/refresh", (req, res) => {
  try {
    res.json(readProviderRefreshState(getAuthenticatedUserId(req), provider(req.query.provider)));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid provider." });
  }
});

router.get("/provider/refresh/history", (req, res) => {
  try {
    const page = typeof req.query.page === "string" ? Number(req.query.page) : 1;
    const pageSize = typeof req.query.pageSize === "string" ? Number(req.query.pageSize) : 25;
    res.json(readProviderRefreshHistory(getAuthenticatedUserId(req), provider(req.query.provider), page, pageSize));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid provider." });
  }
});

export default router;
