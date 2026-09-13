import app from "./app";
import { logger } from "./lib/logger";
import { runtimeConfig } from "./lib/runtime-config";
import { startAcquisitionJobPolling } from "./services/acquisition-jobs";

const server = app.listen(runtimeConfig.port, runtimeConfig.host, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    logger.error({ address }, "Could not determine the local API address");
    process.exit(1);
  }

  logger.info(
    {
      authMode: runtimeConfig.authMode,
      host: runtimeConfig.host,
      port: address.port,
    },
    "Server listening",
  );
  process.stdout.write(
    `ARCHIVE_ASSISTANT_READY ${JSON.stringify({ port: address.port })}\n`,
  );
  const stopAcquisitionPolling = startAcquisitionJobPolling();
  process.once("SIGTERM", stopAcquisitionPolling);
  process.once("SIGINT", stopAcquisitionPolling);
});
