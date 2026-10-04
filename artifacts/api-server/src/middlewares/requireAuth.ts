import { getAuth } from "@clerk/express";
import type { Request, RequestHandler } from "express";
import { claimLegacyData } from "../lib/archive-db";
import { runtimeConfig } from "../lib/runtime-config";

export function getAuthenticatedUserId(req: Request) {
  // Test-only identity injection lets HTTP tests exercise the same owner
  // boundary as Clerk without trusting a client-supplied owner field in
  // production. The flag is never enabled by normal runtime configuration.
  if (process.env.ARCHIVE_ASSISTANT_ALLOW_TEST_AUTH === "1") {
    const testOwnerId = req.header("x-test-owner-id");
    if (testOwnerId?.trim()) return testOwnerId.trim();
  }
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