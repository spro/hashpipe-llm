const assert = require("node:assert/strict")
const test = require("node:test")

const { _internal } = require("../dist/index.js")
const { extractModelFlag } = _internal

test("passes args through when no flag is present", () => {
    assert.deepEqual(extractModelFlag(["summarize", "this"]), {
        model: null,
        rest: ["summarize", "this"],
    })
})

test("extracts -m and its value from the front", () => {
    assert.deepEqual(extractModelFlag(["-m", "gpt-5.4-mini", "hi there"]), {
        model: "gpt-5.4-mini",
        rest: ["hi there"],
    })
})

test("extracts --model anywhere in the args", () => {
    assert.deepEqual(
        extractModelFlag(["summarize", "--model", "claude-haiku-4-5"]),
        { model: "claude-haiku-4-5", rest: ["summarize"] },
    )
})

test("last flag wins when repeated", () => {
    assert.deepEqual(extractModelFlag(["-m", "a", "-m", "b", "go"]), {
        model: "b",
        rest: ["go"],
    })
})

test("throws when -m has no value", () => {
    assert.throws(() => extractModelFlag(["prompt", "-m"]), /-m needs a model id/)
})

test("leaves -m alone inside a single quoted string", () => {
    assert.deepEqual(extractModelFlag(["explain the -m flag"]), {
        model: null,
        rest: ["explain the -m flag"],
    })
})
