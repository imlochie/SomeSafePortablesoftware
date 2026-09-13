// TEMPORARY: side-effect import, deliberately first. ESM hoists every import
// above surrounding statements, so calling an installer here would run *after*
// the modules below had already been evaluated -- and module-scope path
// resolution is the prime suspect. Importing for side effects instead makes
// this the first module evaluated in the graph.
import "./lib/launch-diagnostics";

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
