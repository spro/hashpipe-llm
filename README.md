# hashpipe-llm

Experimental LLM commands for [hashpipe](https://github.com/spro/hashpipe) —
pipe JSON through Anthropic or OpenAI models via the AI SDK.

## Setup

This is a hashpipe module — a package whose exports follow the hashpipe
command signature, loaded into a session with `use`. Any of the routes below
works; they only differ in where `use` finds the code.

**Install with npm**, in the directory you run hashpipe from:

```sh
npm install github:spro/hashpipe-llm
```

`use <name>` resolves the package `hashpipe-<name>` against the working
directory's `node_modules`, so after installing:

```coffee
#| use llm
```

**Or clone it into the module search path.** `use llm` also looks for a
module named `llm` in each directory of `HASHPIPE_PATH` (colon-separated)
and then in `~/.hashpipe/modules/`:

```sh
git clone https://github.com/spro/hashpipe-llm ~/.hashpipe/modules/llm
```

**Or point at a checkout directly** with an explicit `./`, `/`, or `~` path:

```coffee
#| use ~/src/hashpipe-llm
```

The compiled `dist/` is committed, so a plain clone works with no build step.
If you change the TypeScript in `src/`, run `npm run build` to recompile.

**API keys.** The commands read `ANTHROPIC_API_KEY` (Claude models) and
`OPENAI_API_KEY` (OpenAI models) from the environment of the shell that
launches hashpipe:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
hashpipe
```

**Check the install:**

```coffee
#| use llm ; which llm
{ command: 'llm', type: 'module' }

#| llm "say hi in three words"
'Hi there, friend'
```

## Commands

**`llm <prompt...>`** — sends the prompt; any piped input is attached as JSON
context. Returns the response text.

```coffee
#| {name: 'sparky', age: 58} | llm "write a one-line bio for this dog"
'Sparky, 58 dog years young, is a distinguished gentleman...'

#| echo write a haiku about pipes | llm
'Data flows through pipes...'
```

**`llm.json <prompt...>`** — same, but the model is instructed to return JSON
and the result is parsed, so it pipes like any other hashpipe value:

```coffee
#| llm.json "three dog names as an array" || upper
[ 'BISCUIT', 'MAPLE', 'ROSCO' ]

#| [12, 7, 42, 3] | llm.json "sort this descending"
[ 42, 12, 7, 3 ]
```

**`llm.structured [schema] <prompt...>`** — uses the AI SDK structured output
API. Without a schema it behaves like a stricter JSON mode; with a schema it
asks the provider for validated structured output and returns the parsed value.

The common schema form is intentionally compact: field names map to type hints
or descriptions, and the command compiles that into strict JSON Schema
internally. Plain strings are string field descriptions:

```coffee
#| {subject: "Password reset broken", body: "I cannot get into account 1827"}
#| | llm.structured {
#|     title: "Short support ticket title",
#|     priority: ["low", "medium", "high"],
#|     accountId: "string?: Account id if present",
#|     needsReply: "boolean: Whether support should reply",
#|     confidence: "number: Confidence from 0 to 1"
#|   } "Normalize this support ticket"
{
  title: 'Password reset issue',
  priority: 'high',
  accountId: '1827',
  needsReply: true,
  confidence: 0.94
}
```

Supported shorthand field values:

- `"description"` means a string with that description.
- `"string: description"`, `"number: description"`, `"integer: description"`,
  and `"boolean: description"` set scalar types.
- `"date: description"` and `"datetime: description"` produce string fields
  with date-oriented descriptions.
- `"string[]: description"`, `"number[]: description"`, and similar forms
  produce arrays of scalar values.
- `["low", "medium", "high"]` produces a string enum.
- A `?` suffix makes a field nullable while keeping the output shape stable.
  Bare hashpipe keys cannot contain `?`, so quote optional key names like
  `"accountId?"`, or put the suffix in the type string: `"string?: ..."`.

Nested objects and arrays use normal hashpipe object/array syntax:

```coffee
#| files.cat meeting-notes.md
#| | llm.structured {
#|     summary: "One sentence summary",
#|     tasks: [{
#|       task: "Action item",
#|       "owner?": "Owner if named",
#|       priority: ["low", "medium", "high"]
#|     }]
#|   } "Extract action items"
#| | @ tasks
```

You can also pass raw JSON Schema, or a wrapper with output metadata:

```coffee
#| $ticketSchema = {
#|   name: "TicketSummary",
#|   description: "Normalized support ticket fields",
#|   fields: {
#|     title: "Short ticket title",
#|     priority: ["low", "medium", "high"]
#|   }
#| }
#| files.cat ticket.txt | llm.structured $ticketSchema "Extract the ticket"
```

A longer example can use one model call to create structured data, normal
hashpipe commands to filter and reshape it, and a second model call mapped over
each item in parallel:

```coffee
#| llm.json "Create 5 fictional dog records as a JSON array. Each object must have: name string, breed string, energy integer from 1 to 10, and tricks array of 1 to 3 short strings. Return only the JSON array."
#| | filter {| $(@ energy) > 6 }
#| | sort -energy
#| || @ {name: $(@ name | upper), energy: energy}
#| || llm.json "Using the input dog object, return one JSON object with: name string, energy number, tier string one of 'rocket', 'sport', or 'steady', and activity string with a short recommended activity. Base tier and activity on this one dog's energy. Return only JSON."
#| | sort tier
[
  {
    "name": "NALA",
    "energy": 9,
    "tier": "rocket",
    "activity": "high-intensity fetch"
  },
  {
    "name": "MAYA",
    "energy": 8,
    "tier": "sport",
    "activity": "Long runs or agility training"
  },
  {
    "name": "BAXTER",
    "energy": 7,
    "tier": "sport",
    "activity": "Take a brisk 30-minute run"
  }
]
```

Structured output also composes with live APIs. Here one model call invents
nothing downstream — it just picks cities and coordinates; open-meteo supplies
real temperatures for all of them in a single request, and the final
`@ {cities: ., verdict: ...}` projection pipes the whole table into a second
model call while keeping the data next to the verdict:

```coffee
#| use http
#| $cities = llm.structured {cities: [{name: "city name", lat: "number: latitude", lon: "number: longitude"}]} "four major cities, each on a different continent" @ cities
#| $lats = $cities @ :lat | join ","
#| $lons = $cities @ :lon | join ","
#| $wx = get "api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&current=temperature_2m"
#| $report = zip $($cities @ :name) $($wx @ :current:temperature_2m) @ :{city: $(@ 0), temp_c: $(@ 1)}
#| $report @ {cities: ., verdict: $(llm "one short sentence: which of these cities has the most pleasant temperature right now?")}
{
  cities: [
    { city: 'Tokyo', temp_c: 23.4 },
    { city: 'Cairo', temp_c: 30.7 },
    { city: 'São Paulo', temp_c: 12.8 },
    { city: 'Sydney', temp_c: 12.8 }
  ],
  verdict: 'Tokyo likely has the most pleasant temperature right now at 23.4°C.'
}
```

**`llm.models`** — lists common model ids for the supported AI SDK providers.

```coffee
#| llm.models
{ anthropic: [ 'claude-opus-4-8', ... ], openai: [ 'gpt-5.5', ... ] }

#| llm.models openai
[ 'gpt-5.5', 'gpt-5.4', ... ]
```

## Configuration

The default model is `claude-opus-4-8`. Override per-call with `-m` (or
`--model`), which works on `llm`, `llm.json`, and `llm.structured`:

```coffee
#| llm -m gpt-5.4-mini "three words about pipes"
```

Or per-session with a hashpipe variable:

```coffee
#| $llm_model = 'claude-haiku-4-5'
```

Provider is inferred from the model id for `claude-*`, `gpt-*`, and `o*`
models. You can also make it explicit:

```coffee
#| $llm_model = 'openai:gpt-5.4-mini'
#| $llm_provider = 'openai'
#| $llm_model = 'gpt-4.1'
```

Environment variables work too:

```sh
LLM_PROVIDER=openai LLM_MODEL=gpt-4.1
```

## Notes

- Experimental: command names and behavior may change.
