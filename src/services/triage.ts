import type { Db } from "../db";
import type { AiClient } from "../AI/types";
import {
  AI_TIMEOUT_MS,
  DUPLICATE_WINDOW_MINUTES,
  STUCK_AFTER_MS,
  type Category,
} from "../config";
import {
  checkAiAnswer,
  hasInjection,
  manual,
  type CheckResult,
} from "../checker";
import { computeDueAt } from "./tickets";

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          Object.assign(new Error("AI timeout"), { name: "TimeoutError" }),
        ),
      ms,
    );
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
const isTimeout = (e: any) =>
  e?.name === "TimeoutError" || e?.name === "AbortError";


async function saveResult(
  db: Db,
  t: { id: number; createdAt: Date },
  r: CheckResult,
) {
  const { count } = await db.ticket.updateMany({
    where: { id: t.id, triageState: "pending" },
    data: {
      category: r.category,
      priority: r.priority,
      summary: r.summary,
      triageDecision: r.decision,
      reviewReason: r.reason,
      triageState: "done",
      dueAt: computeDueAt(t.createdAt, r.priority),
    },
  });
  return count === 1;
}

export async function sweepStuck(
  db: Db,
  now: Date,
  olderThanMs = STUCK_AFTER_MS,
) {
  const stuck = await db.ticket.findMany({
    where: {
      triageState: "pending",
      receivedAt: { lt: new Date(now.getTime() - olderThanMs) },
    },
  });
  for (const t of stuck)
    await saveResult(db, t, manual(t.customerPlan, "ai_timeout"));
  return stuck.length;
}

export function createTriage(opts: {
  db: Db;
  ai: AiClient;
  clock: () => Date;
  timeoutMs?: number;
  gapMs?: number;
}) {
  const { db, ai, timeoutMs = AI_TIMEOUT_MS, gapMs = 0 } = opts;
  let chain: Promise<void> = Promise.resolve(); 

  async function logCall(data: {
    ticketId: number;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    latencyMs?: number;
    rawOutput?: string;
    error?: string;
  }) {
    try {
      await db.aiCall.create({ data });
    } catch (e) {
      console.error("aiCall log failed", e);
    }
  }

  async function decide(t: {
    id: number;
    customerPlan: string;
    subject: string;
    body: string;
  }): Promise<CheckResult> {
    const plan = t.customerPlan;
    if (!t.subject.trim() && !t.body.trim())
      return manual(plan, "empty_ticket"); 
    if (hasInjection(t.subject, t.body))
      return manual(plan, "suspected_injection"); 

    const started = Date.now();
    try {
      const out = await withTimeout(
        ai.classify({ plan, subject: t.subject, body: t.body }),
        timeoutMs,
      );
      await logCall({
        ticketId: t.id,
        model: out.model,
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens,
        latencyMs: Date.now() - started,
        rawOutput: out.raw,
      });
      return checkAiAnswer(out.raw, { plan, subject: t.subject, body: t.body });
    } catch (e) {
      await logCall({
        ticketId: t.id,
        latencyMs: Date.now() - started,
        error: String(e),
      });
      return manual(plan, isTimeout(e) ? "ai_timeout" : "ai_error");
    }
  }

  
  async function linkDuplicate(
    t: { id: number; customerId: string; createdAt: Date },
    category: Category | null,
  ) {
    if (!category) return;
    const from = new Date(
      t.createdAt.getTime() - DUPLICATE_WINDOW_MINUTES * 60_000,
    );
    const original = await db.ticket.findFirst({
      where: {
        customerId: t.customerId,
        category,
        id: { not: t.id },
        duplicateOfId: null,
        createdAt: { gte: from, lte: t.createdAt },
      },
      orderBy: { createdAt: "asc" },
    });
    if (original)
      await db.ticket.update({
        where: { id: t.id },
        data: { duplicateOfId: original.id },
      });
  }

  async function failSafe(id: number) {
    try {
      const t = await db.ticket.findUnique({ where: { id } });
      if (t) await saveResult(db, t, manual(t.customerPlan, "checker_error"));
    } catch (e) {
      console.error("failSafe failed", e);
    }
  }

  async function runTriage(id: number) {
    try {
      const t = await db.ticket.findUnique({ where: { id } });
      if (!t || t.triageState !== "pending") return;
      const result = await decide(t);
      if (await saveResult(db, t, result))
        await linkDuplicate(t, result.category);
    } catch (e) {
      console.error("triage failed", id, e);
      await failSafe(id); 
    }
  }

  return {
    runTriage,
    enqueue: (id: number) => {
      chain = chain
        .then(() => runTriage(id))
        .then(() =>
          gapMs ? new Promise<void>((r) => setTimeout(r, gapMs)) : undefined,
        );
    },
    drain: () => chain, 
  };
}
