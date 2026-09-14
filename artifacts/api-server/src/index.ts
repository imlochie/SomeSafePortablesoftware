import app from "./app";
import { logger } from "./lib/logger";
import { databasePathSource } from "./services/storage-diagnostics";
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

  // The database path is logged at startup because a packaged run once showed
  // a populated archive in the UI while the expected AppData database held
  // almost nothing. When ARCHIVE_DB_PATH does not arrive, the path below
  // silently becomes `${cwd}/data/archive-assistant.sqlite` and a brand new
  // database is created there -- the server still reports healthy. Logging the
  // resolved path and its source makes that failure visible in the launch
  // diagnostics instead of days later.
  logger.info(
    {
      authMode: runtimeConfig.authMode,
      host: runtimeConfig.host,
      port: address.port,
      databasePath: runtimeConfig.databasePath,
      databasePathSource: databasePathSource(),
      workingDirectory: process.cwd(),
    },
    "Server listening",
  );

  if (databasePathSource() === "working_directory_fallback") {
    logger.warn(
      {
        databasePath: runtimeConfig.databasePath,
        workingDirectory: process.cwd(),
      },
      "ARCHIVE_DB_PATH was not supplied; using a working-directory database. In a packaged install this is not the persistent application database, and data written here will appear to vanish.",
    );
  }
  process.stdout.write(
    `ARCHIVE_ASSISTANT_READY ${JSON.stringify({ port: address.port })}\n`,
  );
  const stopAcquisitionPolling = startAcquisitionJobPolling();
  process.once("SIGTERM", stopAcquisitionPolling);
  process.once("SIGINT", stopAcquisitionPolling);
});
