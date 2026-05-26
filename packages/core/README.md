# @noetic-tools/core

Core primitives for the [Noetic](https://github.com/mattapperson/noetic) agent framework: step types, the interpreter, the runtime, the memory layer contract, and built-in patterns.

## Install

```bash
npm install @noetic-tools/core @openrouter/agent zod
```

`@openrouter/agent` is an optional peer dependency — required only if you use the OpenRouter adapter. `zod` is required.

## Quick start

```ts
import { AgentHarness, step } from '@noetic-tools/core';

const harness = new AgentHarness({
  model: 'anthropic/claude-sonnet-4',
  llm: { apiKey: process.env.OPENROUTER_API_KEY },
});

const greet = step.llm({
  id: 'greet',
  prompt: ({ input }) => `Say hi to ${input}.`,
});

const result = await harness.run(greet, 'Sam');
console.log(result.output);
```

## Documentation

Full docs, specs, and examples live in the [main repo](https://github.com/mattapperson/noetic).

## License

Apache-2.0
