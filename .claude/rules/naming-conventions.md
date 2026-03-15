# Naming Conventions

## Common Guidelines

- Use whole words in names when possible
- Abbreviations should be `CamelCased`: `Api`, `Url`, `Http`, `Json`

## Types and Interfaces

Use `PascalCase` for type and interface names. Do not use `I` prefix for interfaces.

```typescript
type Person = { name: string; age: number };

interface Warrior {
  atk: number;
  attack(): void;
}
```

## Enums

Use `PascalCase` for enum values:

```typescript
const Direction = {
  Up: 'up-here',
  Down: 'down-there',
} as const;
```

## Functions

Use `camelCase` for functions, `PascalCase` for classes:

```typescript
function attack(aAtk: number, bDef: number) { }

class Warrior { }
```

## Variables

- `camelCase` for properties and local variables
- `UPPERCASE` for top-level constants of `string`, `number`, or `boolean`
- `PascalCase` for zod schemas

```typescript
const damage = aAtk - bDef;
const MAX_ATK = 1e2;
const PersonSchema = z.object({ name: z.string() });
```
