# @noetic-tools/core

Core primitives for the [Noetic](https://github.com/mattapperson/noetic) agent framework: step types, the interpreter, the runtime, the memory layer contract, and built-in patterns.

## Install

```bash
npm install @noetic-tools/core
```

`@noetic-tools/core` depends on `@openrouter/agent` (the OpenRouter LLM adapter) and `zod`; your package manager installs both automatically. Runs on Node.js 18+ and Bun.

## Set your API key

Noetic talks to LLMs through [OpenRouter](https://openrouter.ai). Grab a key at [openrouter.ai/keys](https://openrouter.ai/keys) and export it — the runtime reads `OPENROUTER_API_KEY` by default:

```bash
export OPENROUTER_API_KEY=sk-or-...
```

## Quick start

A complete, runnable program. Save it as `agent.mjs` and run `node agent.mjs`:

```ts
import { AgentHarness, step } from '@noetic-tools/core';

// 1. Define a single LLM step. `model` and `instructions` live here.
const greet = step.llm({
  id: 'greet',
  model: 'openai/gpt-4o-mini', // any OpenRouter model id (provider/model)
  instructions: 'You are a friendly assistant. Greet the user by name in one short sentence.',
});

// 2. Create the harness. `name` and `params` are required; `llm` selects the provider.
const harness = new AgentHarness({
  name: 'greeter',
  params: {},
  llm: { provider: 'openrouter' }, // apiKey defaults to process.env.OPENROUTER_API_KEY
});

// 3. Run the step with a context and print the model's reply.
const ctx = harness.createContext();
const reply = await harness.run(greet, 'Sam', ctx);
console.log(reply); // -> "Hello, Sam! How can I help you today?"
```

**Using TypeScript?** Save the file as `agent.ts` and run it with `bunx tsx agent.ts` (or `bun run agent.ts`) — both execute TypeScript directly, no build step.

Model ids use OpenRouter's `provider/model` format (e.g. `openai/gpt-4o`, `anthropic/claude-sonnet-4`) — see [openrouter.ai/models](https://openrouter.ai/models).

## Documentation

Full docs, specs, and examples live at [noetic.tools/docs](https://noetic.tools/docs) and in the [main repo](https://github.com/mattapperson/noetic).

## License

Apache-2.0
