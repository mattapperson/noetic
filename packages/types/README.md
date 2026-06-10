# @noetic-tools/types

Foundational type contracts and primitives shared across the Noetic framework.

This package holds the dependency-free vocabulary the rest of Noetic is built
on: the conversation `Item` data model, LLM configuration (`LlmProviderConfig`,
`ModelParams`, `LLMResponse`), execution context and steering contracts,
platform adapter interfaces (`FsAdapter`, `ShellAdapter`, `SubprocessAdapter`),
the error model, and the `Item` schema.

It is consumed by [`@noetic-tools/memory`](https://www.npmjs.com/package/@noetic-tools/memory)
and [`@noetic-tools/core`](https://www.npmjs.com/package/@noetic-tools/core),
both of which re-export the parts relevant to their public surface. Application
code normally imports these types from `@noetic-tools/core` rather than from
this package directly.

The `MemoryLayer` contract is additionally exported at the
`@noetic-tools/types/contract` subpath for memory-layer authors who want the
contract without the rest of the vocabulary.

## License

Apache-2.0
