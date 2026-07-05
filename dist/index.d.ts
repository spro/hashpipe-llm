import { compileStructuredOutput } from "./structured";
declare const KNOWN_MODELS: {
    anthropic: string[];
    openai: string[];
};
type ProviderName = keyof typeof KNOWN_MODELS;
interface HashpipeContext {
    get?: (bucket: string, name?: string) => unknown;
}
type Callback = (err: unknown, value?: unknown) => void;
type HashpipeFunction = (inp: unknown, args: unknown[], ctx: HashpipeContext, cb: Callback) => void;
declare function normalizeProvider(provider: unknown): ProviderName | null;
declare function inferProvider(model: string): ProviderName | null;
declare function extractModelFlag(args: unknown[]): {
    model: string | null;
    rest: unknown[];
};
declare function buildPrompt(inp: unknown, args: unknown[]): string | null;
declare function splitStructuredArgs(args: unknown[]): {
    schemaSpec: unknown;
    promptArgs: unknown[];
};
export declare const llm: HashpipeFunction;
export declare const json: HashpipeFunction;
export declare const structured: HashpipeFunction;
export declare const models: HashpipeFunction;
export declare const _internal: {
    buildPrompt: typeof buildPrompt;
    compileStructuredOutput: typeof compileStructuredOutput;
    extractModelFlag: typeof extractModelFlag;
    inferProvider: typeof inferProvider;
    normalizeProvider: typeof normalizeProvider;
    splitStructuredArgs: typeof splitStructuredArgs;
};
export {};
