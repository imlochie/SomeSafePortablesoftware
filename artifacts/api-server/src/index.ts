import app from "./app";
import { logger } from "./lib/logger";
import { runtimeConfig } from "./lib/runtime-config";
import { startAcquisitionJobPolling } from "./services/acquisition-jobs";

app.listen(runtimeConfig.port, runtimeConfig.host, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info(
    {
      authMode: runtimeConfig.authMode,
      host: runtimeConfig.host,
      port: runtimeConfig.port,
    },
    "Server listening",
  );
  const stopAcquisitionPolling = startAcquisitionJobPolling();
  process.once("SIGTERM", stopAcquisitionPolling);
  process.once("SIGINT", stopAcquisitionPolling);
});
