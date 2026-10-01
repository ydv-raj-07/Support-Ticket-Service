import express, { type NextFunction, type Request, type Response } from "express";
import type { Deps } from "./types";
import { ticketRoutes } from "./routes/tickets";
import { getStats } from "./services/stats";

export function buildApp(deps: Deps) {
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  app.use(ticketRoutes(deps));
  app.get("/stats", async (_req, res) => res.json(await getStats(deps.db, deps.clock())));
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "invalid JSON" });
    console.error(err);
    res.status(500).json({ error: "internal error" });
  });
  return app;
}