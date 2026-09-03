import { getAuth } from "@clerk/express";
import type { Request, RequestHandler } from "express";
import { claimLegacyData } from "../lib/archive-db";
import { runtimeConfig } from "../lib/runtime-config";

export function getAuthenticatedUserId(req: Request) {
  if (runtimeConfig.authMode === "local") {
    return runtimeConfig.localOwnerId;
  }
  const { userId } = getAuth(req);
  if (!userId) throw new Error("Authentication required.");
  return userId;
}

export const requireAuth: RequestHandler = (req, res, next) => {
  try {
    const userId = getAuthenticatedUserId(req);
    claimLegacyData(userId);
    next();
  } catch {
    res.status(401).json({ error: "Authentication required." });
  }
};