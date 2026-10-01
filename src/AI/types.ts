export interface AiInput { plan: string; subject: string; body: string }
export interface AiOutput { raw: string; model: string; inputTokens: number; outputTokens: number }
export interface AiClient { classify(input: AiInput): Promise<AiOutput> }