import { Router, type IRouter } from "express";
import { GetProviderRefreshStateQueryParams, GetProviderRefreshStateResponse, ListProviderRefreshHistoryQueryParams, ListProviderRefreshHistoryResponse } from "@workspace/api-zod";
import { getAuthenticatedUserId } from "../middlewares/requireAuth";
import { providerNames, readProviderRefreshHistory, readProviderRefreshState, type ProviderName } from "../services/provider-refresh";

const router: IRouter = Router();

function provider(value: unknown): ProviderName {
  if (typeof value === "string" && providerNames.includes(value as ProviderName)) return value as ProviderName;
  throw new Error("Provider must be plex or jellyfin.");
}

router.get("/provider/refresh", (req, res) => {
  try {
    const query = GetProviderRefreshStateQueryParams.parse(req.query);
    res.json(GetProviderRefreshStateResponse.parse(readProviderRefreshState(getAuthenticatedUserId(req), provider(query.provider))));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid provider." });
  }
});

router.get("/provider/refresh/history", (req, res) => {
  try {
    const query = ListProviderRefreshHistoryQueryParams.parse(req.query);
    const result = readProviderRefreshHistory(getAuthenticatedUserId(req), provider(query.provider), query.page, query.pageSize);
    res.json(ListProviderRefreshHistoryResponse.parse(result));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid provider." });
  }
});

export default router;
