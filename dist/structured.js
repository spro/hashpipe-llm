"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.compileStructuredOutput = compileStructuredOutput;
const ai_1 = require("ai");
const SCALAR_TYPES = new Set([
    "string",
    "number",
    "integer",
    "boolean",
    "null",
    "date",
    "datetime",
]);
const FORMAT_DESCRIPTIONS = {
    date: "ISO 8601 date",
    datetime: "ISO 8601 datetime",
};
function compileStructuredOutput(spec) {
    if (spec == null) {
        return { output: ai_1.Output.json() };
    }
    if (isStringEnum(spec)) {
        return { output: ai_1.Output.choice({ options: spec }) };
    }
    const normalized = normalizeSpecWrapper(spec);
    if (normalized.rawJsonSchema) {
        return compileJsonSchema(normalized.rawJsonSchema, normalized.meta);
    }
    const schema = compileShorthandObject(normalized.spec);
    return {
        ...normalized.meta,
        schema,
        output: ai_1.Output.object({
            ...normalized.meta,
            schema: (0, ai_1.jsonSchema)(schema),
        }),
    };
}
function normalizeSpecWrapper(spec) {
    if (!isPlainObject(spec)) {
        throw new Error("llm.structured: schema must be an object, array of choices, or omitted");
    }
    // name/description are only meta in the wrapper forms ({name, fields}
    // or {name, schema}); in bare shorthand they are ordinary fields, and
    // hoisting them would leak field descriptions into the provider's
    // response-format name.
    const meta = {};
    if (isPlainObject(spec.schema) || isPlainObject(spec.fields)) {
        if (typeof spec.name === "string")
            meta.name = spec.name;
        if (typeof spec.description === "string") {
            meta.description = spec.description;
        }
        if (meta.name != null && !/^[a-zA-Z0-9_-]+$/.test(meta.name)) {
            throw new Error("llm.structured: schema name must match [a-zA-Z0-9_-]+, got " +
                JSON.stringify(meta.name));
        }
    }
    if (isPlainObject(spec.schema)) {
        return {
            spec: spec.schema,
            meta,
            rawJsonSchema: spec.schema,
        };
    }
    if (isPlainObject(spec.fields)) {
        return { spec: spec.fields, meta };
    }
    if (looksLikeJsonSchema(spec)) {
        return { spec, meta, rawJsonSchema: spec };
    }
    return { spec, meta };
}
function compileJsonSchema(schema, meta) {
    const strictSchema = makeStrictSchema(schema);
    const output = strictSchema.type === "array" && isPlainObject(strictSchema.items)
        ? ai_1.Output.array({
            ...meta,
            element: (0, ai_1.jsonSchema)(makeStrictSchema(strictSchema.items)),
        })
        : ai_1.Output.object({
            ...meta,
            schema: (0, ai_1.jsonSchema)(strictSchema),
        });
    return { ...meta, schema: strictSchema, output };
}
function compileShorthandObject(fields) {
    const properties = {};
    const required = [];
    for (const [rawKey, value] of Object.entries(fields)) {
        const keyOptional = rawKey.endsWith("?");
        const key = keyOptional ? rawKey.slice(0, -1) : rawKey;
        if (!key) {
            throw new Error("llm.structured: field names cannot be empty");
        }
        const compiled = compileField(value);
        const optional = keyOptional || compiled.optional;
        properties[key] = optional ? makeNullable(compiled.schema) : compiled.schema;
        required.push(key);
    }
    return {
        type: "object",
        properties,
        required,
        additionalProperties: false,
    };
}
function compileField(value) {
    if (typeof value === "string") {
        return parseScalarShorthand(value);
    }
    if (Array.isArray(value)) {
        if (value.length === 1 && isPlainObject(value[0])) {
            return {
                schema: {
                    type: "array",
                    items: compileShorthandObject(value[0]),
                },
                optional: false,
            };
        }
        if (value.length === 1 && typeof value[0] === "string" && isArrayType(value[0])) {
            return {
                schema: {
                    type: "array",
                    items: scalarSchema(parseTypeToken(value[0]).type),
                },
                optional: parseTypeToken(value[0]).optional,
            };
        }
        if (!value.length) {
            throw new Error("llm.structured: enum arrays must contain at least one value");
        }
        return {
            schema: {
                type: enumJsonType(value),
                enum: value,
            },
            optional: false,
        };
    }
    if (isPlainObject(value)) {
        if (typeof value.type === "string") {
            return compileExplicitField(value);
        }
        return { schema: compileShorthandObject(value), optional: false };
    }
    throw new Error("llm.structured: fields must be strings, enum arrays, object specs, or array specs");
}
function compileExplicitField(value) {
    const typeInfo = parseTypeToken(value.type);
    let schema;
    if (typeInfo.array) {
        schema = {
            type: "array",
            items: scalarSchema(typeInfo.type),
        };
    }
    else {
        schema = scalarSchema(typeInfo.type);
    }
    if (typeof value.description === "string") {
        schema.description = value.description;
    }
    if (Array.isArray(value.enum)) {
        schema.enum = value.enum;
    }
    return {
        schema,
        optional: typeInfo.optional || value.optional === true,
    };
}
function parseScalarShorthand(value) {
    const trimmed = value.trim();
    const match = trimmed.match(/^([a-zA-Z][a-zA-Z0-9_-]*)(\[\])?(\?)?\s*:\s*(.*)$/);
    if (!match) {
        return {
            schema: { type: "string", description: trimmed },
            optional: false,
        };
    }
    const [, rawType, arraySuffix, optionalSuffix, description] = match;
    const type = normalizeType(rawType);
    if (!SCALAR_TYPES.has(type)) {
        return {
            schema: { type: "string", description: trimmed },
            optional: false,
        };
    }
    const schema = arraySuffix
        ? { type: "array", items: scalarSchema(type) }
        : scalarSchema(type);
    const desc = description.trim() || FORMAT_DESCRIPTIONS[type];
    if (desc)
        schema.description = desc;
    return { schema, optional: optionalSuffix === "?" };
}
function parseTypeToken(value) {
    const token = String(value).trim();
    const match = token.match(/^([a-zA-Z][a-zA-Z0-9_-]*)(\[\])?(\?)?$/);
    if (!match) {
        throw new Error("llm.structured: invalid type " + token);
    }
    const type = normalizeType(match[1]);
    if (!SCALAR_TYPES.has(type)) {
        throw new Error("llm.structured: unsupported type " + match[1]);
    }
    return { type, array: match[2] === "[]", optional: match[3] === "?" };
}
function scalarSchema(type) {
    if (type === "date" || type === "datetime") {
        return {
            type: "string",
            description: FORMAT_DESCRIPTIONS[type],
        };
    }
    return { type: type };
}
function normalizeType(type) {
    const normalized = type.toLowerCase();
    if (normalized === "bool")
        return "boolean";
    if (normalized === "int")
        return "integer";
    if (normalized === "date-time")
        return "datetime";
    return normalized;
}
function isArrayType(value) {
    return /^[a-zA-Z][a-zA-Z0-9_-]*\[\]\??$/.test(value.trim());
}
function makeNullable(schema) {
    const copy = { ...schema };
    if (Array.isArray(copy.type)) {
        copy.type = copy.type.includes("null") ? copy.type : [...copy.type, "null"];
    }
    else if (copy.type != null) {
        copy.type = [copy.type, "null"];
    }
    else if (copy.anyOf) {
        copy.anyOf = [...copy.anyOf, { type: "null" }];
    }
    return copy;
}
function makeStrictSchema(schema) {
    if (!isPlainObject(schema))
        return schema;
    const copy = { ...schema };
    if (copy.type === "object" || copy.properties != null) {
        const properties = copy.properties || {};
        copy.type = "object";
        copy.properties = Object.fromEntries(Object.entries(properties).map(([key, value]) => [
            key,
            makeStrictSchema(value),
        ]));
        copy.required = Object.keys(properties);
        copy.additionalProperties = false;
    }
    if (copy.type === "array" && isPlainObject(copy.items)) {
        copy.items = makeStrictSchema(copy.items);
    }
    if (copy.anyOf) {
        copy.anyOf = copy.anyOf.map((item) => makeStrictSchema(item));
    }
    if (copy.$defs && isPlainObject(copy.$defs)) {
        copy.$defs = Object.fromEntries(Object.entries(copy.$defs).map(([key, value]) => [
            key,
            makeStrictSchema(value),
        ]));
    }
    return copy;
}
function enumJsonType(values) {
    const types = new Set(values.map((value) => typeof value));
    if (types.size !== 1) {
        throw new Error("llm.structured: enum arrays must contain one value type");
    }
    const type = types.values().next().value;
    if (type === "string" || type === "number" || type === "boolean") {
        return type;
    }
    throw new Error("llm.structured: enum arrays can contain strings, numbers, or booleans");
}
function isStringEnum(value) {
    return (Array.isArray(value) &&
        value.length > 0 &&
        value.every((item) => typeof item === "string"));
}
function isPlainObject(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
}
function looksLikeJsonSchema(value) {
    return (typeof value.type === "string" ||
        value.properties != null ||
        value.items != null ||
        value.anyOf != null ||
        value.$defs != null);
}
