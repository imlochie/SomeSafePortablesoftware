import { Router, type IRouter } from "express";
import healthRouter from "./health";
import systemRouter from "./system";
import settingsRouter from "./settings";
import plexRouter from "./plex";
import mediaRouter from "./media";
import downloadsRouter from "./downloads";
import archiveRouter from "./archive";

import integrationsRouter from "./integrations";

const router: IRouter = Router();

router.use(healthRouter);
router.use(systemRouter);
router.use(settingsRouter);
router.use(plexRouter);
router.use(integrationsRouter);
router.use(mediaRouter);
router.use(downloadsRouter);
router.use(archiveRouter);

export default router;
