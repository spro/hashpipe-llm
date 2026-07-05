// hashpipe-llm — experimental LLM commands for hashpipe.
//
//   #| use llm                  (npm-installed)  or  use ./hashpipe-llm
//   #| {name: 'sparky', age: 58} | llm "how old is this dog in dog years?"
//   #| llm.json "three dog names as an array"
//
// Requires ANTHROPIC_API_KEY for Claude models or OPENAI_API_KEY for OpenAI
// models. Override the model per-call with `-m <model>` (or `--model`), or
// per-session by setting the hashpipe variable $llm_model (default:
// claude-opus-4-8). You can also set $llm_provider to "anthropic" or
// "openai", or prefix models as "anthropic:..." / "openai:...".

import { generateText, NoObjectGeneratedError } from "ai"
import { anthropic } from "@ai-sdk/anthropic"
import { openai } from "@ai-sdk/openai"
import { compileStructuredOutput } from "./structured"

const DEFAULT_MODEL = "claude-opus-4-8"
const MAX_TOKENS = 16000

const SYSTEM = [
    "You are the `llm` command inside hashpipe, a JSON-based shell.",
    "When piped input is present it appears in an <input> tag as JSON.",
    "Respond with only the result - no preamble, no commentary, no",
    "markdown fences unless the user asks for markdown.",
].join(" ")

const STRUCTURED_SYSTEM = [
    SYSTEM,
    "When producing structured data, use the supplied schema descriptions",
    "as the contract for each field.",
].join(" ")

const KNOWN_MODELS = {
    anthropic: [
        "claude-opus-4-8",
        "claude-sonnet-4-6",
        "claude-haiku-4-5",
    ],
    openai: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-4.1"],
}

type ProviderName = keyof typeof KNOWN_MODELS

interface HashpipeContext {
    get?: (bucket: string, name?: string) => unknown
}

type Callback = (err: unknown, value?: unknown) => void
type HashpipeFunction = (
    inp: unknown,
    args: unknown[],
    ctx: HashpipeContext,
    cb: Callback,
) => void

function getVar(ctx: HashpipeContext, name: string): unknown {
    return ctx && typeof ctx.get === "function" ? ctx.get("vars", name) : null
}

function normalizeProvider(provider: unknown): ProviderName | null {
    if (provider == null || provider === "") return null
    const p = String(provider).toLowerCase()
    if (p === "anthropic" || p === "claude") return "anthropic"
    if (p === "openai" || p === "gpt") return "openai"
    throw new Error("unknown llm_provider: " + provider)
}

function inferProvider(model: string): ProviderName | null {
    if (/^claude[-_]/i.test(model)) return "anthropic"
    if (/^(gpt|o[0-9])[-_.]/i.test(model) || /^o[0-9]$/i.test(model)) {
        return "openai"
    }
    return null
}

// -m <model> / --model <model> anywhere in the args wins over $llm_model.
function extractModelFlag(args: unknown[]): {
    model: string | null
    rest: unknown[]
} {
    const rest: unknown[] = []
    let model: string | null = null
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg === "-m" || arg === "--model") {
            if (i + 1 >= args.length) {
                throw new Error(arg + " needs a model id (try llm.models)")
            }
            model = String(args[++i])
        } else {
            rest.push(arg)
        }
    }
    return { model, rest }
}

function resolveModel(ctx: HashpipeContext, override?: string | null) {
    const rawModel =
        override || getVar(ctx, "llm_model") || process.env.LLM_MODEL || DEFAULT_MODEL
    const match = String(rawModel).match(/^(anthropic|claude|openai|gpt):(.+)$/i)
    const model = match ? match[2] : String(rawModel)
    const explicitProvider = match
        ? match[1]
        : getVar(ctx, "llm_provider") || process.env.LLM_PROVIDER
    const provider = normalizeProvider(explicitProvider) || inferProvider(model)

    if (!provider) {
        throw new Error(
            "could not infer provider for model " +
                model +
                "; set llm_provider to anthropic or openai",
        )
    }
    if (provider === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
        throw new Error("set ANTHROPIC_API_KEY to use Anthropic models")
    }
    if (provider === "openai" && !process.env.OPENAI_API_KEY) {
        throw new Error("set OPENAI_API_KEY to use OpenAI models")
    }

    return {
        provider,
        id: model,
        model: provider === "anthropic" ? anthropic(model) : openai(model),
    }
}

function buildPrompt(inp: unknown, args: unknown[]): string | null {
    const instruction = args.map((arg) => String(arg)).join(" ").trim()
    if (!instruction && inp == null) {
        return null
    }
    const parts: string[] = []
    if (instruction) parts.push(instruction)
    if (inp != null) {
        const data = typeof inp === "string" ? inp : JSON.stringify(inp, null, 2)
        if (instruction) {
            parts.push("<input>\n" + data + "\n</input>")
        } else {
            // No instruction: the piped input is the prompt itself.
            parts.push(data)
        }
    }
    return parts.join("\n\n")
}

function formatError(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}

function complete(
    inp: unknown,
    args: unknown[],
    ctx: HashpipeContext,
    extraSystem: string | null,
    cb: Callback,
): void {
    try {
        const flags = extractModelFlag(args)
        const prompt = buildPrompt(inp, flags.rest)
        if (prompt == null) {
            return cb("llm: give a prompt as arguments or piped input")
        }
        const model = resolveModel(ctx, flags.model)
        generateText({
            model: model.model,
            maxOutputTokens: MAX_TOKENS,
            system: extraSystem ? SYSTEM + " " + extraSystem : SYSTEM,
            prompt,
        })
            .then((result) => {
                if (result.finishReason === "content-filter") {
                    return cb("llm: the model declined this request")
                }
                cb(null, result.text.trim())
            })
            .catch((err) => cb("llm: " + formatError(err)))
    } catch (err) {
        cb("llm: " + formatError(err))
    }
}

function isStructuredSpec(value: unknown): boolean {
    return (
        value != null &&
        typeof value === "object" &&
        (Array.isArray(value) || !("quoted" in value))
    )
}

function splitStructuredArgs(args: unknown[]): {
    schemaSpec: unknown
    promptArgs: unknown[]
} {
    if (args.length && isStructuredSpec(args[0])) {
        return { schemaSpec: args[0], promptArgs: args.slice(1) }
    }
    return { schemaSpec: null, promptArgs: args }
}

// llm <prompt...> - piped input (any JSON) is attached as context.
export const llm: HashpipeFunction = (inp, args, ctx, cb) => {
    complete(inp, args, ctx, null, cb)
}

// llm.json <prompt...> - response is parsed JSON, ready for piping.
export const json: HashpipeFunction = (inp, args, ctx, cb) => {
    complete(
        inp,
        args,
        ctx,
        "Respond with ONLY valid JSON (an object, array, string, number, or boolean). No prose, no markdown fences.",
        (err, text) => {
            if (err != null) return cb(err)
            const cleaned = String(text)
                .replace(/^```(?:json)?\s*/i, "")
                .replace(/```\s*$/, "")
            try {
                cb(null, JSON.parse(cleaned))
            } catch {
                cb("llm.json: model did not return valid JSON: " + cleaned.slice(0, 120))
            }
        },
    )
}

// llm.structured [schema] <prompt...> - structured output with optional schema.
export const structured: HashpipeFunction = (inp, args, ctx, cb) => {
    try {
        const flags = extractModelFlag(args)
        const { schemaSpec, promptArgs } = splitStructuredArgs(flags.rest)
        const prompt = buildPrompt(inp, promptArgs)
        if (prompt == null) {
            return cb("llm.structured: give a prompt as arguments or piped input")
        }

        const structuredOutput = compileStructuredOutput(schemaSpec)
        const model = resolveModel(ctx, flags.model)

        generateText({
            model: model.model,
            maxOutputTokens: MAX_TOKENS,
            system: STRUCTURED_SYSTEM,
            prompt,
            output: structuredOutput.output,
        })
            .then((result) => {
                if (result.finishReason === "content-filter") {
                    return cb("llm.structured: the model declined this request")
                }
                cb(null, result.output)
            })
            .catch((err) => {
                if (NoObjectGeneratedError.isInstance(err)) {
                    return cb("llm.structured: " + formatNoObjectError(err))
                }
                cb("llm.structured: " + formatError(err))
            })
    } catch (err) {
        cb("llm.structured: " + formatError(err))
    }
}

function formatNoObjectError(err: InstanceType<typeof NoObjectGeneratedError>): string {
    const cause =
        err.cause instanceof Error
            ? err.cause.message
            : err.cause == null
              ? ""
              : String(err.cause)
    const text = err.text ? " output: " + err.text.slice(0, 120) : ""
    return [err.message, cause].filter(Boolean).join(" cause: ") + text
}

// llm.models - list common model ids for the supported AI SDK providers.
export const models: HashpipeFunction = (inp, args, ctx, cb) => {
    try {
        const provider = normalizeProvider(args[0] || getVar(ctx, "llm_provider"))
        if (provider) return cb(null, KNOWN_MODELS[provider])
        cb(null, KNOWN_MODELS)
    } catch (err) {
        cb("llm: " + formatError(err))
    }
}

export const _internal = {
    buildPrompt,
    compileStructuredOutput,
    extractModelFlag,
    inferProvider,
    normalizeProvider,
    splitStructuredArgs,
}
