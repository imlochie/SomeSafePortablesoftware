import { Router, type IRouter } from "express";
import healthRouter from "./health";
import systemRouter from "./system";
import assistantRouter from "./assistant";
import settingsRouter from "./settings";
import plexRouter from "./plex";
import jellyfinRouter from "./jellyfin";
import mediaRouter from "./media";
import downloadsRouter from "./downloads";
import archiveRouter from "./archive";
import integrationsRouter from "./integrations";
import acquisitionJobsRouter from "./acquisition-jobs";
import controlPlaneRouter from "./control-plane";
import agentRouter from "./agent";

const router: IRouter = Router();

router.use(healthRouter);
router.use(assistantRouter);
router.use(systemRouter);
router.use(settingsRouter);
router.use(plexRouter);
router.use(jellyfinRouter);
router.use(mediaRouter);
router.use(downloadsRouter);
router.use(archiveRouter);
router.use(integrationsRouter);
router.use(acquisitionJobsRouter);
router.use(controlPlaneRouter);
router.use(agentRouter);

export default router;
