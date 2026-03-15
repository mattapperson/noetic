# Testing Rules

## Setup

- **Framework**: `bun test` (Bun's built-in test runner)
- **Location**: Tests live in `test/` directory
- **Extension**: `.test.ts`
- **Run**: `bun test` (package level)

## Requirements

- Plain functions should always be tested
- Do not use `any` in tests
- Use `assert` for optional properties, not if statements

## Scripts

All scripting should be done in TypeScript.
