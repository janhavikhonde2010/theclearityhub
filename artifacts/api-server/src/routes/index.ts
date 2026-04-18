import { Router, type IRouter } from "express";
import healthRouter from "./health";
import subscribersRouter from "./subscribers";
import uploadRouter from "./upload";

const router: IRouter = Router();

router.use(healthRouter);
router.use(uploadRouter);
router.use(subscribersRouter);

export default router;
