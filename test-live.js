const assert = require("assert")
const fs = require("fs")
const path = require("path")

function loadDotenv(file) {
    if (!fs.existsSync(file)) return
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("#")) continue
        const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
        if (!match || process.env[match[1]] != null) continue
        process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2")
    }
}

function exec(pipe, script, ctx) {
    return pipe.exec(script, null, ctx)
}

async function main() {
    loadDotenv(path.join(__dirname, ".env"))

    if (!process.env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY is required for live OpenAI tests")
    }

    const hashpipeDir = path.resolve(__dirname, process.env.HASHPIPE_DIR || "../hashpipe")
    const { Pipeline } = require(path.join(hashpipeDir, "lib"))
    const model = process.env.LIVE_LLM_MODEL || process.env.LLM_MODEL || "gpt-4.1-mini"

    const pipe = new Pipeline()
        .use("http")
        .use("html")
        .use("files")
        .use("keywords")
        .use(__dirname)
    const ctx = pipe.subScope()
    ctx.set("vars", "llm_model", model)

    const models = await exec(pipe, "llm.models openai", ctx)
    assert(models.includes("gpt-4.1"), "llm.models openai should include gpt-4.1")
    console.log("ok llm.models openai")

    const text = await exec(
        pipe,
        'llm "Reply with exactly hashpipe-ok and no punctuation"',
        ctx,
    )
    assert.strictEqual(text, "hashpipe-ok")
    console.log("ok llm")

    const json = await exec(
        pipe,
        'llm.json "Return exactly this JSON object: {\\"status\\":\\"ok\\",\\"count\\":3,\\"items\\":[\\"pipe\\",\\"json\\"]}"',
        ctx,
    )
    assert.deepStrictEqual(json, {
        status: "ok",
        count: 3,
        items: ["pipe", "json"],
    })
    console.log("ok llm.json")

    const piped = await exec(
        pipe,
        '{name: "Ada", age: 9} | llm.json "Using the input JSON, return only {\\"name\\": string, \\"agePlusOne\\": number}."',
        ctx,
    )
    assert.deepStrictEqual(piped, { name: "Ada", agePlusOne: 10 })
    console.log("ok piped llm.json")

    // llm.structured - choice mode: string array schema → string result
    const sentiment = await exec(
        pipe,
        `"The product is absolutely fantastic and I love everything about it!" | llm.structured ["positive", "neutral", "negative"] "What is the sentiment of this text?"`,
        ctx,
    )
    assert(
        ["positive", "neutral", "negative"].includes(sentiment),
        `sentiment should be one of the enum values, got: ${JSON.stringify(sentiment)}`,
    )
    console.log("ok llm.structured choice:", sentiment)

    // llm.structured - object schema with inline enum, optional field, and boolean
    const ticket = await exec(
        pipe,
        `{subject: "Billing charge incorrect", body: "I was charged twice for my subscription this month. Account number 5512."} | llm.structured {category: ["billing", "technical", "account", "general"], urgency: "integer: severity from 1 (low) to 5 (critical)", "accountId?": "string?: Account number if mentioned", needsReply: "boolean: should support reply to the user"} "Normalize this support ticket"`,
        ctx,
    )
    assert(
        ["billing", "technical", "account", "general"].includes(ticket.category),
        `category should be valid enum, got: ${JSON.stringify(ticket.category)}`,
    )
    assert(
        Number.isInteger(ticket.urgency) && ticket.urgency >= 1 && ticket.urgency <= 5,
        `urgency should be integer 1-5, got: ${JSON.stringify(ticket.urgency)}`,
    )
    assert(
        typeof ticket.needsReply === "boolean",
        `needsReply should be boolean, got: ${JSON.stringify(ticket.needsReply)}`,
    )
    console.log("ok llm.structured object:", ticket)

    // llm.structured - nested array of typed objects
    const parsed = await exec(
        pipe,
        `"Marie Curie was born in Warsaw, Poland in 1867 and later moved to Paris." | llm.structured {entities: [{name: "entity name", type: ["person", "location", "date"]}]} "Extract all named entities from this text"`,
        ctx,
    )
    assert(
        Array.isArray(parsed.entities) && parsed.entities.length >= 2,
        `should extract multiple entities, got: ${JSON.stringify(parsed.entities)}`,
    )
    const validEntityTypes = new Set(["person", "location", "date"])
    assert(
        parsed.entities.every((e) => validEntityTypes.has(e.type)),
        `all entity types should be valid, got: ${JSON.stringify(parsed.entities)}`,
    )
    const curie = parsed.entities.find((e) => /curie|marie/i.test(e.name))
    assert(curie?.type === "person", `Marie Curie should be a person, got: ${JSON.stringify(curie)}`)
    console.log("ok llm.structured nested:", parsed)

    // llm.structured - typed containers, enum items, and a scalar union
    const delivery = await exec(
        pipe,
        `{recipients: ["to", "cc"], measurements: [[12.5, 8], [3, 4.25]], address: {street: "1 Main St", city: "Boston"}, reference: 4921} | llm.structured {recipients: {type: "array", description: "Delivery recipient roles", items: ["to", "cc", "bcc"]}, measurements: {type: "array", description: "Rows of numeric measurements", items: {type: "array", items: "number"}}, address: {type: "object", fields: {street: "Street address", city: "City"}}, reference: {anyOf: ["string", "integer"], description: "Customer or order id"}} "Copy the supplied delivery details exactly"`,
        ctx,
    )
    assert.deepStrictEqual(delivery, {
        recipients: ["to", "cc"],
        measurements: [[12.5, 8], [3, 4.25]],
        address: { street: "1 Main St", city: "Boston" },
        reference: 4921,
    })
    console.log("ok llm.structured typed containers:", delivery)
}

main().catch((err) => {
    console.error(err.message || err)
    process.exit(1)
})
