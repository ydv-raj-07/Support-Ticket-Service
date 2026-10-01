import { z } from "zod";
import { CATEGORIES, PRIORITIES, type Category, type Priority } from "../config";

export type Decision = "auto_accept" | "manual_review";

export interface CheckResult {
  decision: Decision; 
  reason: string | null;
  category: Category | null; 
  priority: Priority; 
  summary: string | null;
}

interface TicketText { 
  plan: string; 
  subject: string; 
  body: string 
}

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions|prompts?|rules)/i,
  /disregard\s+.{0,30}(instructions|rules)/i,
  /(classify|mark|set|treat)\s+(this\s+)?(ticket\s+)?as\s+P[0-3]/i,
  /system\s+prompt/i,
  /you\s+are\s+now\b/i,
];

export const hasInjection = (subject: string, body: string) =>
  INJECTION_PATTERNS.some((p) => p.test(`${subject}\n${body}`));

export const rank = (p: Priority) => PRIORITIES.indexOf(p); // chhota number = zyada urgent
export const fallbackPriority = (plan: string): Priority => (plan === "enterprise" ? "P1" : "P2");


export function manual(plan: string, reason: string, extra: Partial<CheckResult> = {}): CheckResult {
  return { decision: "manual_review", reason, category: null, priority: fallbackPriority(plan), summary: null, ...extra };
}

const answerSchema = z.object({
  category: z.enum(CATEGORIES),
  priority: z.enum(PRIORITIES),
  summary: z.string().trim().min(1),
});

const parseJson = (raw: string) =>
  JSON.parse(raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim());

function isOneShortSentence(s: string) {
  const words = s.split(/\s+/).filter(Boolean).length;
  return words <= 25 && !/[.!?]["')\]]*\s+\S/.test(s);
}

export function checkAiAnswer(raw: string | null, t: TicketText): CheckResult {
  try {
    if (hasInjection(t.subject, t.body)) return manual(t.plan, "suspected_injection");

    if (!raw) return manual(t.plan, "invalid_output");

    let json: unknown;
    try { 
      json = parseJson(raw); 
    }catch { 
      return manual(t.plan, "invalid_output"); 
    }
    const parsed = answerSchema.safeParse(json);
    if (!parsed.success || !isOneShortSentence(parsed.data.summary)) return manual(t.plan, "invalid_output");

    const { category, summary } = parsed.data;
    let priority = parsed.data.priority;

    let floorApplied = false;
    if (t.plan === "enterprise" && rank(priority) > rank("P1")) { priority = "P1"; floorApplied = true; }

    const base = { category, priority, summary };
    if (t.plan === "unknown") return { decision: "manual_review", reason: "invalid_plan", ...base };
    if (t.plan === "free" && priority === "P0") return { decision: "manual_review", reason: "priority_plan_mismatch", ...base };
    if (priority === "P0" && category === "feature_request") return { decision: "manual_review", reason: "priority_category_mismatch", ...base };

    return { decision: "auto_accept", reason: floorApplied ? "enterprise_floor_applied" : null, ...base };
  } catch {
    return manual(t.plan, "checker_error");
  }
}