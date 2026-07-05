import { Output } from "ai";
import type { JSONSchema7 } from "@ai-sdk/provider";
export type StructuredOutput = ReturnType<typeof Output.object> | ReturnType<typeof Output.array> | ReturnType<typeof Output.choice> | ReturnType<typeof Output.json>;
interface OutputMeta {
    name?: string;
    description?: string;
}
interface CompileResult extends OutputMeta {
    schema?: JSONSchema7;
    output: StructuredOutput;
}
export declare function compileStructuredOutput(spec: unknown): CompileResult;
export {};
