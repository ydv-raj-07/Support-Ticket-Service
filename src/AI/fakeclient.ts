import type { AiClient, AiInput, AiOutput } from "./types";

export class FakeAiClient implements AiClient {
  calls = 0;
  constructor(private impl: (i: AiInput) => AiOutput | Promise<AiOutput>) {}
  async classify(i: AiInput) { this.calls++; return this.impl(i); }
}
export const fakeReply = (answer: unknown) =>
  new FakeAiClient(() => ({
    raw: typeof answer === "string" ? answer : JSON.stringify(answer),
    model: "fake", inputTokens: 10, outputTokens: 10,
  }));