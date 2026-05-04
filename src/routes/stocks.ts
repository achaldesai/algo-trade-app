import { Router } from "express";
import { z } from "zod";
import { getContainer } from "../util/getContainer";
import { validateBody } from "../middleware/validateRequest";
import { userAuthMiddleware } from "../middleware/userAuth";

const router = Router();
router.use(userAuthMiddleware);

const createStockSchema = z.object({
  symbol: z.string().min(1, "Symbol is required"),
  name: z.string().min(1, "Name is required"),
});

router.get("/", async (req, res, next) => {
  try {
    const { portfolioService } = getContainer(req);
    const userId = req.user!.userId;
    const stocks = portfolioService.listStocks(userId);
    res.json({
      data: stocks.map((stock) => ({
        ...stock,
        createdAt: stock.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.post("/", validateBody(createStockSchema), async (req, res, next) => {
  try {
    const { portfolioService } = getContainer(req);
    const userId = req.user!.userId;
    const stock = await portfolioService.addStock(userId, req.body);
    res.status(201).json({
      data: {
        ...stock,
        createdAt: stock.createdAt.toISOString(),
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
