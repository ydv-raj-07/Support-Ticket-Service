import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { Deps } from "../types";
import { CATEGORIES, PRIORITIES } from "../config";
import { ingestTicket, computeDueAt } from "../services/tickets";
import { rank } from "../checker";

const TRANSITIONS = {
  open: ["in_progress"],
  in_progress: ["resolved"],
  resolved: ["open"],   // customer dobara reply kare
} as const;

function requireAgent(req: Request, res: Response, next: NextFunction) {
  const id = req.header("X-Agent-Id");
  if (!id) return res.status(401).json({ error: "X-Agent-Id header required" });
  res.locals.agentId = id;
  next();
}

const parseId = (v: string | string[] | undefined) => {
  const s = Array.isArray(v) ? v[0] : v;
  return s && /^\d+$/.test(s) ? Number(s) : null;
};

export function ticketRoutes({ db, enqueue }: Deps) {
  const r = Router();

  r.post("/tickets", async (req, res) => {
    const result = await ingestTicket({ db, enqueue }, req.body);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.status(result.created ? 201 : 200).json(result.ticket);
  });

  r.post("/tickets/:id/claim", requireAgent, async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "invalid id" });
    
    const { count } = await db.ticket.updateMany({ where: { id, assignee: null }, data: { assignee: res.locals.agentId } });
    const t = await db.ticket.findUnique({ where: { id } });
    if (!t) return res.status(404).json({ error: "ticket not found" });
    if (count === 1) return res.json(t);
    res.status(409).json({ error: `already claimed by ${t.assignee}` });
  });

  r.patch("/tickets/:id/status", requireAgent, async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "invalid id" });
    const body = z.object({ status: z.enum(["open", "in_progress", "resolved"]) }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "status must be open, in_progress or resolved" });

    const t = await db.ticket.findUnique({ where: { id } });
    if (!t) return res.status(404).json({ error: "ticket not found" });
    const allowed: readonly string[] = TRANSITIONS[t.status];
    if (!allowed.includes(body.data.status)) {
      return res.status(409).json({ error: `cannot move from ${t.status} to ${body.data.status}`, allowed });
    }
    
    const { count } = await db.ticket.updateMany({ where: { id, status: t.status }, data: { status: body.data.status } });
    if (count === 0) return res.status(409).json({ error: "status changed by someone else, retry" });
    res.json(await db.ticket.findUnique({ where: { id } }));
  });

  r.patch("/tickets/:id/triage", requireAgent, async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "invalid id" });
    const body = z.object({
      category: z.enum(CATEGORIES).optional(),
      priority: z.enum(PRIORITIES).optional(),
      reason: z.string().trim().min(3),
    }).refine((v) => v.category || v.priority, { message: "category or priority required" }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: body.error.flatten() });

    const t = await db.ticket.findUnique({ where: { id } });
    if (!t) return res.status(404).json({ error: "ticket not found" });
    if (t.triageDecision !== "manual_review") {
      return res.status(409).json({ error: "only tickets in manual_review can be changed" });
    }
    const category = body.data.category ?? t.category;
    const priority = body.data.priority ?? t.priority;
    if (t.customerPlan === "enterprise" && priority && rank(priority) > rank("P1")) {
      return res.status(422).json({ error: "enterprise tickets cannot go below P1" });
    }
    const dueAt = priority ? computeDueAt(t.createdAt, priority) : t.dueAt;   

    const [updated] = await db.$transaction([
      db.ticket.update({ where: { id }, data: { category, priority, dueAt } }),
      db.ticketEvent.create({ data: {
        ticketId: id, agentId: res.locals.agentId, kind: "triage_override", reason: body.data.reason,
        oldValue: { category: t.category, priority: t.priority }, newValue: { category, priority },
      } }),
    ]);
    res.json(updated);
  });

  r.get("/tickets", async (req, res) => {
    const q = z.object({
      status: z.enum(["open", "in_progress", "resolved"]).optional(),
      priority: z.enum(PRIORITIES).optional(),
      category: z.enum(CATEGORIES).optional(),
      triage_decision: z.enum(["auto_accept", "manual_review"]).optional(),
      cursor: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    }).safeParse(req.query);
    if (!q.success) return res.status(400).json({ error: q.error.flatten() });

    const rows = await db.ticket.findMany({
      where: {
        status: q.data.status, priority: q.data.priority, category: q.data.category,
        triageDecision: q.data.triage_decision,
        ...(q.data.cursor ? { id: { lt: q.data.cursor } } : {}),   // keyset: OFFSET nahi
      },
      orderBy: { id: "desc" },
      take: q.data.limit + 1,
    });
    const hasMore = rows.length > q.data.limit;
    const items = hasMore ? rows.slice(0, -1) : rows;
    res.json({ items, nextCursor: hasMore ? items[items.length - 1].id : null });
  });

  return r;
}