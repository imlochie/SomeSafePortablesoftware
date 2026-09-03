import { getAuth } from "@clerk/express";
import type { Request, RequestHandler } from "express";
import { claimLegacyData } from "../lib/archive-db";

export function getAuthenticatedUserId(req: Request) {
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