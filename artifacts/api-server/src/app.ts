import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import router from "./routes";
import { logger } from "./lib/logger";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import { requireAuth } from "./middlewares/requireAuth";
import { isAllowedLocalOrigin, runtimeConfig } from "./lib/runtime-config";
import acquisitionWebhooksRouter from "./routes/acquisition-webhooks";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

if (runtimeConfig.authMode === "clerk") {
  app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
}
app.use(
  cors({
    credentials: true,
    origin: runtimeConfig.allowAnyCorsOrigin
      ? true
      : (origin, callback) => {
          if (!origin || isAllowedLocalOrigin(origin)) {
            callback(null, true);
            return;
          }
          callback(new Error("Origin is not allowed by the local API boundary."));
        },
  }),
);
app.use(
  "/api/acquisition-webhooks",
  express.raw({
    type: "*/*",
    limit: "256kb",
  }),
  acquisitionWebhooksRouter,
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (runtimeConfig.authMode === "clerk") {
  app.use(
    clerkMiddleware((req) => ({
      publishableKey: publishableKeyFromHost(
        getClerkProxyHost(req) ?? "",
        process.env.CLERK_PUBLISHABLE_KEY,
      ),
    })),
  );
}

app.use("/api", requireAuth, router);

export default app;
