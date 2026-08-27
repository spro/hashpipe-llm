const assert = require("node:assert/strict")
const test = require("node:test")

const { _internal } = require("../dist/index.js")

function compile(spec) {
    return _internal.compileStructuredOutput(spec).schema
}

test("compiles shorthand scalar fields into strict object schema", () => {
    assert.deepEqual(
        compile({
            name: "Customer display name",
            age: "integer: Age in years",
            active: "boolean: Whether the account is active",
            score: "number?: Fit score from 0 to 100",
        }),
        {
            type: "object",
            properties: {
                name: {
                    type: "string",
                    description: "Customer display name",
                },
                age: {
                    type: "integer",
                    description: "Age in years",
                },
                active: {
                    type: "boolean",
                    description: "Whether the account is active",
                },
                score: {
                    type: ["number", "null"],
                    description: "Fit score from 0 to 100",
                },
            },
            required: ["name", "age", "active", "score"],
            additionalProperties: false,
        },
    )
})

test("supports quoted optional key suffixes", () => {
    assert.deepEqual(compile({ "accountId?": "Customer account id" }), {
        type: "object",
        properties: {
            accountId: {
                type: ["string", "null"],
                description: "Customer account id",
            },
        },
        required: ["accountId"],
        additionalProperties: false,
    })
})

test("supports scalar arrays and date-oriented string shorthands", () => {
    assert.deepEqual(
        compile({
            tags: "string[]: Searchable labels",
            dueDate: "date: Due date if known",
            createdAt: "datetime: Creation timestamp",
        }),
        {
            type: "object",
            properties: {
                tags: {
                    type: "array",
                    items: { type: "string" },
                    description: "Searchable labels",
                },
                dueDate: {
                    type: "string",
                    description: "Due date if known",
                },
                createdAt: {
                    type: "string",
                    description: "Creation timestamp",
                },
            },
            required: ["tags", "dueDate", "createdAt"],
            additionalProperties: false,
        },
    )
})

test("compiles nested objects, arrays, and enums", () => {
    assert.deepEqual(
        compile({
            title: "Short ticket title",
            priority: ["low", "medium", "high"],
            customer: {
                name: "Customer name",
                "email?": "Customer email if present",
            },
            tasks: [
                {
                    task: "Action item",
                    done: "boolean: Whether this is already complete",
                },
            ],
        }),
        {
            type: "object",
            properties: {
                title: {
                    type: "string",
                    description: "Short ticket title",
                },
                priority: {
                    type: "string",
                    enum: ["low", "medium", "high"],
                },
                customer: {
                    type: "object",
                    properties: {
                        name: {
                            type: "string",
                            description: "Customer name",
                        },
                        email: {
                            type: ["string", "null"],
                            description: "Customer email if present",
                        },
                    },
                    required: ["name", "email"],
                    additionalProperties: false,
                },
                tasks: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            task: {
                                type: "string",
                                description: "Action item",
                            },
                            done: {
                                type: "boolean",
                                description: "Whether this is already complete",
                            },
                        },
                        required: ["task", "done"],
                        additionalProperties: false,
                    },
                },
            },
            required: ["title", "priority", "customer", "tasks"],
            additionalProperties: false,
        },
    )
})

test("supports typed containers, enum array items, and unions", () => {
    assert.deepEqual(
        compile({
            matrix: {
                type: "array",
                description: "Rows of numeric measurements",
                items: { type: "array", items: "number" },
            },
            recipients: {
                type: "array",
                items: ["to", "cc", "bcc"],
            },
            address: {
                type: "object",
                description: "Shipping address",
                fields: {
                    street: "Street address",
                    city: "City",
                },
            },
            reference: {
                anyOf: ["string", "integer"],
                description: "External or internal reference",
            },
        }),
        {
            type: "object",
            properties: {
                matrix: {
                    type: "array",
                    description: "Rows of numeric measurements",
                    items: { type: "array", items: { type: "number" } },
                },
                recipients: {
                    type: "array",
                    items: {
                        type: "string",
                        enum: ["to", "cc", "bcc"],
                    },
                },
                address: {
                    type: "object",
                    description: "Shipping address",
                    properties: {
                        street: {
                            type: "string",
                            description: "Street address",
                        },
                        city: { type: "string", description: "City" },
                    },
                    required: ["street", "city"],
                    additionalProperties: false,
                },
                reference: {
                    anyOf: [{ type: "string" }, { type: "integer" }],
                    description: "External or internal reference",
                },
            },
            required: ["matrix", "recipients", "address", "reference"],
            additionalProperties: false,
        },
    )
})

test("optional enum fields stay satisfiable when made nullable", () => {
    assert.deepEqual(
        compile({ "status?": { type: "string", enum: ["active", "inactive"] } }),
        {
            type: "object",
            properties: {
                status: {
                    type: ["string", "null"],
                    enum: ["active", "inactive", null],
                },
            },
            required: ["status"],
            additionalProperties: false,
        },
    )
})

test("rejects incomplete typed containers", () => {
    assert.throws(
        () => compile({ values: { type: "array" } }),
        /array fields need an items specification/,
    )
    assert.throws(
        () => compile({ address: { type: "object" } }),
        /object fields need a fields object/,
    )
})

test("strictifies raw JSON schema objects", () => {
    assert.deepEqual(
        compile({
            type: "object",
            properties: {
                vendor: { type: "string" },
                lines: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            amount: { type: "number" },
                        },
                    },
                },
            },
        }),
        {
            type: "object",
            properties: {
                vendor: { type: "string" },
                lines: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            amount: { type: "number" },
                        },
                        required: ["amount"],
                        additionalProperties: false,
                    },
                },
            },
            required: ["vendor", "lines"],
            additionalProperties: false,
        },
    )
})

test("strictifies nullable arrays and oneOf branches in raw JSON Schema", () => {
    assert.deepEqual(
        compile({
            type: ["array", "null"],
            items: {
                type: "object",
                properties: { id: { type: "integer" } },
            },
        }),
        {
            type: ["array", "null"],
            items: {
                type: "object",
                properties: { id: { type: "integer" } },
                required: ["id"],
                additionalProperties: false,
            },
        },
    )

    assert.deepEqual(
        compile({
            oneOf: [
                { type: "object", properties: { text: { type: "string" } } },
                { type: "object", properties: { count: { type: "integer" } } },
            ],
        }),
        {
            oneOf: [
                {
                    type: "object",
                    properties: { text: { type: "string" } },
                    required: ["text"],
                    additionalProperties: false,
                },
                {
                    type: "object",
                    properties: { count: { type: "integer" } },
                    required: ["count"],
                    additionalProperties: false,
                },
            ],
        },
    )
})

test("detects schema arguments for llm.structured", () => {
    assert.deepEqual(_internal.splitStructuredArgs([{ name: "A" }, "extract"]), {
        schemaSpec: { name: "A" },
        promptArgs: ["extract"],
    })
    assert.deepEqual(_internal.splitStructuredArgs(["extract", "json"]), {
        schemaSpec: null,
        promptArgs: ["extract", "json"],
    })
})

test("a bare shorthand field named 'name' stays a field, not output meta", () => {
    const result = _internal.compileStructuredOutput({
        name: "official company name",
        founded: "integer: year founded",
    })
    assert.equal(result.name, undefined)
    assert.deepEqual(result.schema.properties.name, {
        type: "string",
        description: "official company name",
    })
})

test("wrapper form still hoists name and description into meta", () => {
    const result = _internal.compileStructuredOutput({
        name: "company_info",
        description: "Basic company facts",
        fields: { founded: "integer: year founded" },
    })
    assert.equal(result.name, "company_info")
    assert.equal(result.description, "Basic company facts")
    assert.deepEqual(Object.keys(result.schema.properties), ["founded"])
})

test("rejects wrapper names the providers would refuse", () => {
    assert.throws(
        () =>
            _internal.compileStructuredOutput({
                name: "company info",
                fields: { founded: "integer" },
            }),
        /schema name must match/,
    )
})
