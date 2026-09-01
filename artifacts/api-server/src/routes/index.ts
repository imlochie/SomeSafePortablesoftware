import { Router, type IRouter } from "express";
import healthRouter from "./health";
import systemRouter from "./system";
import settingsRouter from "./settings";
import plexRouter from "./plex";

const router: IRouter = Router();

router.use(healthRouter);
router.use(systemRouter);
router.use(settingsRouter);
router.use(plexRouter);

export default router;
