// vitest.config.ts  (tests ek DB share karte hain, isliye ek-ek karke chalein)
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { fileParallelism: false, testTimeout: 15000 } });