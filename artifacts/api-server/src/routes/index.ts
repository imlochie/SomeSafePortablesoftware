import { Router, type IRouter } from "express";
import healthRouter from "./health";
import systemRouter from "./system";
import settingsRouter from "./settings";
import plexRouter from "./plex";
import mediaRouter from "./media";
import downloadsRouter from "./downloads";
import archiveRouter from "./archive";
import acquisitionRouter from "./acquisition";

const router: IRouter = Router();

router.use(healthRouter);
router.use(systemRouter);
router.use(settingsRouter);
router.use(plexRouter);
router.use(mediaRouter);
router.use(downloadsRouter);
router.use(archiveRouter);
router.use(acquisitionRouter);

export default router;
