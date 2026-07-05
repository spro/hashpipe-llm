import { jsonSchema, Output } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"

export type StructuredOutput =
    | ReturnType<typeof Output.object>
    | ReturnType<typeof Output.array>
    | ReturnType<typeof Output.choice>
    | ReturnType<typeof Output.json>

type JsonObject = Record<string, unknown>

interface OutputMeta {
    name?: string
    description?: string
}

interface CompileResult extends OutputMeta {
    schema?: JSONSchema7
    output: StructuredOutput
}

const SCALAR_TYPES = new Set([
    "string",
    "number",
    "integer",
    "boolean",
    "null",
    "date",
    "datetime",
])

const FORMAT_DESCRIPTIONS: Record<string, string> = {
    date: "ISO 8601 date",
    datetime: "ISO 8601 datetime",
}

export function compileStructuredOutput(spec: unknown): CompileResult {
    if (spec == null) {
        return { output: Output.json() }
    }

    if (isStringEnum(spec)) {
        return { output: Output.choice({ options: spec }) }
    }

    const normalized = normalizeSpecWrapper(spec)
    if (normalized.rawJsonSchema) {
        return compileJsonSchema(normalized.rawJsonSchema, normalized.meta)
    }

    const schema = compileShorthandObject(normalized.spec)
    return {
        ...normalized.meta,
        schema,
        output: Output.object({
            ...normalized.meta,
            schema: jsonSchema(schema),
        }),
    }
}

function normalizeSpecWrapper(spec: unknown): {
    spec: JsonObject
    meta: OutputMeta
    rawJsonSchema?: JSONSchema7
} {
    if (!isPlainObject(spec)) {
        throw new Error("llm.structured: schema must be an object, array of choices, or omitted")
    }

    // name/description are only meta in the wrapper forms ({name, fields}
    // or {name, schema}); in bare shorthand they are ordinary fields, and
    // hoisting them would leak field descriptions into the provider's
    // response-format name.
    const meta: OutputMeta = {}
    if (isPlainObject(spec.schema) || isPlainObject(spec.fields)) {
        if (typeof spec.name === "string") meta.name = spec.name
        if (typeof spec.description === "string") {
            meta.description = spec.description
        }
        if (meta.name != null && !/^[a-zA-Z0-9_-]+$/.test(meta.name)) {
            throw new Error(
                "llm.structured: schema name must match [a-zA-Z0-9_-]+, got " +
                    JSON.stringify(meta.name),
            )
        }
    }

    if (isPlainObject(spec.schema)) {
        return {
            spec: spec.schema,
            meta,
            rawJsonSchema: spec.schema as JSONSchema7,
        }
    }

    if (isPlainObject(spec.fields)) {
        return { spec: spec.fields, meta }
    }

    if (looksLikeJsonSchema(spec)) {
        return { spec, meta, rawJsonSchema: spec as JSONSchema7 }
    }

    return { spec, meta }
}

function compileJsonSchema(schema: JSONSchema7, meta: OutputMeta): CompileResult {
    const strictSchema = makeStrictSchema(schema)
    const output =
        strictSchema.type === "array" && isPlainObject(strictSchema.items)
            ? Output.array({
                  ...meta,
                  element: jsonSchema(makeStrictSchema(strictSchema.items as JSONSchema7)),
              })
            : Output.object({
                  ...meta,
                  schema: jsonSchema(strictSchema),
              })

    return { ...meta, schema: strictSchema, output }
}

function compileShorthandObject(fields: JsonObject): JSONSchema7 {
    const properties: Record<string, JSONSchema7> = {}
    const required: string[] = []

    for (const [rawKey, value] of Object.entries(fields)) {
        const keyOptional = rawKey.endsWith("?")
        const key = keyOptional ? rawKey.slice(0, -1) : rawKey
        if (!key) {
            throw new Error("llm.structured: field names cannot be empty")
        }

        const compiled = compileField(value)
        const optional = keyOptional || compiled.optional
        properties[key] = optional ? makeNullable(compiled.schema) : compiled.schema
        required.push(key)
    }

    return {
        type: "object",
        properties,
        required,
        additionalProperties: false,
    }
}

function compileField(value: unknown): { schema: JSONSchema7; optional: boolean } {
    if (typeof value === "string") {
        return parseScalarShorthand(value)
    }

    if (Array.isArray(value)) {
        if (value.length === 1 && isPlainObject(value[0])) {
            return {
                schema: {
                    type: "array",
                    items: compileShorthandObject(value[0]),
                },
                optional: false,
            }
        }

        if (value.length === 1 && typeof value[0] === "string" && isArrayType(value[0])) {
            return {
                schema: {
                    type: "array",
                    items: scalarSchema(parseTypeToken(value[0]).type),
                },
                optional: parseTypeToken(value[0]).optional,
            }
        }

        if (!value.length) {
            throw new Error("llm.structured: enum arrays must contain at least one value")
        }
        return {
            schema: {
                type: enumJsonType(value),
                enum: value as JSONSchema7["enum"],
            },
            optional: false,
        }
    }

    if (isPlainObject(value)) {
        if (typeof value.type === "string") {
            return compileExplicitField(value)
        }
        return { schema: compileShorthandObject(value), optional: false }
    }

    throw new Error(
        "llm.structured: fields must be strings, enum arrays, object specs, or array specs",
    )
}

function compileExplicitField(value: JsonObject): {
    schema: JSONSchema7
    optional: boolean
} {
    const typeInfo = parseTypeToken(value.type)
    let schema: JSONSchema7

    if (typeInfo.array) {
        schema = {
            type: "array",
            items: scalarSchema(typeInfo.type),
        }
    } else {
        schema = scalarSchema(typeInfo.type)
    }

    if (typeof value.description === "string") {
        schema.description = value.description
    }
    if (Array.isArray(value.enum)) {
        schema.enum = value.enum as JSONSchema7["enum"]
    }

    return {
        schema,
        optional: typeInfo.optional || value.optional === true,
    }
}

function parseScalarShorthand(value: string): {
    schema: JSONSchema7
    optional: boolean
} {
    const trimmed = value.trim()
    const match = trimmed.match(/^([a-zA-Z][a-zA-Z0-9_-]*)(\[\])?(\?)?\s*:\s*(.*)$/)
    if (!match) {
        return {
            schema: { type: "string", description: trimmed },
            optional: false,
        }
    }

    const [, rawType, arraySuffix, optionalSuffix, description] = match
    const type = normalizeType(rawType)
    if (!SCALAR_TYPES.has(type)) {
        return {
            schema: { type: "string", description: trimmed },
            optional: false,
        }
    }

    const schema: JSONSchema7 = arraySuffix
        ? { type: "array", items: scalarSchema(type) }
        : scalarSchema(type)
    const desc = description.trim() || FORMAT_DESCRIPTIONS[type]
    if (desc) schema.description = desc

    return { schema, optional: optionalSuffix === "?" }
}

function parseTypeToken(value: unknown): {
    type: string
    array: boolean
    optional: boolean
} {
    const token = String(value).trim()
    const match = token.match(/^([a-zA-Z][a-zA-Z0-9_-]*)(\[\])?(\?)?$/)
    if (!match) {
        throw new Error("llm.structured: invalid type " + token)
    }
    const type = normalizeType(match[1])
    if (!SCALAR_TYPES.has(type)) {
        throw new Error("llm.structured: unsupported type " + match[1])
    }
    return { type, array: match[2] === "[]", optional: match[3] === "?" }
}

function scalarSchema(type: string): JSONSchema7 {
    if (type === "date" || type === "datetime") {
        return {
            type: "string",
            description: FORMAT_DESCRIPTIONS[type],
        }
    }
    return { type: type as JSONSchema7["type"] }
}

function normalizeType(type: string): string {
    const normalized = type.toLowerCase()
    if (normalized === "bool") return "boolean"
    if (normalized === "int") return "integer"
    if (normalized === "date-time") return "datetime"
    return normalized
}

function isArrayType(value: string): boolean {
    return /^[a-zA-Z][a-zA-Z0-9_-]*\[\]\??$/.test(value.trim())
}

function makeNullable(schema: JSONSchema7): JSONSchema7 {
    const copy: JSONSchema7 = { ...schema }
    if (Array.isArray(copy.type)) {
        copy.type = copy.type.includes("null") ? copy.type : [...copy.type, "null"]
    } else if (copy.type != null) {
        copy.type = [copy.type, "null"]
    } else if (copy.anyOf) {
        copy.anyOf = [...copy.anyOf, { type: "null" }]
    }
    return copy
}

function makeStrictSchema(schema: JSONSchema7): JSONSchema7 {
    if (!isPlainObject(schema)) return schema

    const copy: JSONSchema7 = { ...schema }

    if (copy.type === "object" || copy.properties != null) {
        const properties = copy.properties || {}
        copy.type = "object"
        copy.properties = Object.fromEntries(
            Object.entries(properties).map(([key, value]) => [
                key,
                makeStrictSchema(value as JSONSchema7),
            ]),
        )
        copy.required = Object.keys(properties)
        copy.additionalProperties = false
    }

    if (copy.type === "array" && isPlainObject(copy.items)) {
        copy.items = makeStrictSchema(copy.items as JSONSchema7)
    }

    if (copy.anyOf) {
        copy.anyOf = copy.anyOf.map((item: unknown) =>
            makeStrictSchema(item as JSONSchema7),
        )
    }

    if (copy.$defs && isPlainObject(copy.$defs)) {
        copy.$defs = Object.fromEntries(
            Object.entries(copy.$defs).map(([key, value]) => [
                key,
                makeStrictSchema(value as JSONSchema7),
            ]),
        )
    }

    return copy
}

function enumJsonType(values: unknown[]): JSONSchema7["type"] {
    const types = new Set(values.map((value) => typeof value))
    if (types.size !== 1) {
        throw new Error("llm.structured: enum arrays must contain one value type")
    }
    const type = types.values().next().value
    if (type === "string" || type === "number" || type === "boolean") {
        return type
    }
    throw new Error("llm.structured: enum arrays can contain strings, numbers, or booleans")
}

function isStringEnum(value: unknown): value is string[] {
    return (
        Array.isArray(value) &&
        value.length > 0 &&
        value.every((item) => typeof item === "string")
    )
}

function isPlainObject(value: unknown): value is JsonObject {
    return value != null && typeof value === "object" && !Array.isArray(value)
}

function looksLikeJsonSchema(value: JsonObject): boolean {
    return (
        typeof value.type === "string" ||
        value.properties != null ||
        value.items != null ||
        value.anyOf != null ||
        value.$defs != null
    )
}
