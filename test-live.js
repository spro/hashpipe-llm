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
    return new Promise((resolve, reject) => {
        pipe.exec(script, null, ctx, (err, data) => {
            if (err != null) reject(new Error(String(err)))
            else resolve(data)
        })
    })
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
}

main().catch((err) => {
    console.error(err.message || err)
    process.exit(1)
})
