# Noetic UI Agent Configuration

Project-specific guidelines for working with the Noetic UI package.

## Pre-Edit Verification

Before making edits, verify:
1. Current TypeScript errors: `bunx tsc --noEmit`
2. Current lint status: `bunx biome check .`
3. Target file exists and is readable

## Common Error Prevention

### TypeScript Issues

**Always run type check after file modifications:**
```bash
cd packages/ui && bunx tsc --noEmit
```

**Common TypeScript errors to avoid:**
- Missing type imports (use `import type` for type-only imports)
- Unused variables (enable `noUnusedLocals` in tsconfig)
- Implicit any (strict mode is enabled)
- Missing return types on exported functions

**Type Safety Rules:**
- Use `satisfies` instead of `as` for type assertions when possible
- Avoid `as` type casts - use proper typing or runtime validation
- Use strict equality (`===`) instead of loose equality
- Always handle Promise rejections

### Linting (Biome)

**Always run linting after file modifications:**
```bash
cd packages/ui && bunx biome check .
```

**Common Biome rules that frequently error:**

1. **Block Statements** (`style/useBlockStatements`)
   - Always use braces for if/for/while statements
   - ❌ `if (condition) return;`
   - ✅ `if (condition) { return; }`

2. **Array Index Keys** (`suspicious/noArrayIndexKey`)
   - Never use array index as React key
   - ❌ `key={index}`
   - ✅ `key={item.id}` or `key={`${prefix}-${index}`}`

3. **Static Element Interactions** (`a11y/noStaticElementInteractions`)
   - Interactive elements should be focusable
   - Use `<button>` instead of `<div onClick={...}>`
   - Add `tabIndex` and keyboard handlers for custom interactive elements

4. **Type Casting** (`plugin` warnings about `as`)
   - Minimize use of `as` type casts
   - Use type guards or proper typing instead
   - When necessary, validate at runtime

5. **Focusable Interactive** (`a11y/useFocusableInteractive`)
   - Elements with interactive roles must be focusable
   - Add `tabIndex={0}` or make them actual buttons

**Auto-fix lint errors:**
```bash
cd packages/ui && bunx biome check --fix .
```

### React/Component Patterns

**Component Structure:**
- Use function declarations for components: `function Component() {}`
- Use arrow functions for callbacks and handlers
- Always specify return types for exported functions

**Hooks:**
- Follow rules of hooks (only call at top level)
- Include all dependencies in useEffect dependency arrays
- Use eslint-disable comments sparingly and only when necessary

**Styling:**
- Use CSS custom properties (variables) for theming
- Prefer `className` over inline styles for complex styling
- Use inline styles only for dynamic values

### State Management (Zustand)

**Store Patterns:**
- Use `persist` middleware carefully - don't persist computed values
- Keep stores focused (agent store, execution store, theme store)
- Use selectors to avoid unnecessary re-renders
- Type all store interfaces completely

**Common Issues:**
- Don't mutate state directly - always use setters
- Avoid circular dependencies between stores
- Be careful with Map/Set serialization when persisting

### File Structure

**Naming Conventions:**
- Components: PascalCase (e.g., `AgentBrowser.tsx`)
- Utilities: camelCase (e.g., `useConnection.ts`)
- Types: PascalCase with 'Type' suffix for clarity (e.g., `AgentType`)

**Directory Structure:**
```
src/
├── client/
│   ├── components/     # React components
│   ├── hooks/         # Custom React hooks
│   ├── stores/        # Zustand stores
│   ├── lib/           # Client utilities
│   └── styles/        # CSS and theme variables
├── service/           # Server-side code
└── shared/            # Shared types and utilities
```

## Build & Release

**Before releasing:**
1. Run type check: `bunx tsc --noEmit`
2. Run lint: `bunx biome check .`
3. Build executables: `bun run build:exe`
4. Test all distribution methods

**GitHub Actions:**
- Build matrix: macOS (x64, arm64), Linux (x64, arm64), Windows (x64)
- Check artifacts are created properly
- Verify install script works

## Testing Changes

**Manual Testing Checklist:**
1. Start server: `bun src/service/index.ts`
2. Open UI at http://localhost:3334
3. Verify WebSocket connection
4. Test agent discovery
5. Test run recording
6. Test resizable panels
7. Verify theme switching works

**Common Issues to Watch For:**
- Port already in use (3333 or 3334)
- Storage permissions in project directory
- WebSocket connection failures
- Missing dist folder for static files

## Code Review Checklist

Before considering work complete:
- [ ] TypeScript compiles without errors
- [ ] Biome linting passes
- [ ] No console errors in browser
- [ ] Responsive layout works
- [ ] Both light and dark themes render correctly
- [ ] Keyboard navigation works where applicable

## Documentation

**When to update:**
- README.md: Installation, usage, or API changes
- Specs (21-noetic-ui.md): Architecture or feature changes
- This file: Workflow or configuration changes

**Documentation standards:**
- Use clear, concise language
- Include code examples for APIs
- Keep installation instructions up to date
- Document breaking changes

## Debugging Tips

**Common Issues:**

1. **"Cannot find module" errors**
   - Check import paths (use `@/` alias for src)
   - Verify file exists and has correct extension
   - Run `bun install` to ensure dependencies

2. **WebSocket connection refused**
   - Check if server is running on correct port
   - Verify NOETIC_UI_ENABLED=true
   - Check firewall/browser extensions

3. **Theme not applying**
   - Check CSS variables are defined in :root
   - Verify class is being applied to documentElement
   - Check for CSS specificity issues

4. **Build failures**
   - Clear .next and dist directories
   - Run `bun install` to refresh dependencies
   - Check for syntax errors in modified files

## Environment Variables

**Required for development:**
- `NOETIC_UI_ENABLED=true` - Enable UI integration
- `NOETIC_UI_WS_PORT=3333` - WebSocket port (optional)
- `NOETIC_UI_API_PORT=3334` - API port (optional)

**Storage:**
- Traces stored in `./.noetic/ui/traces/` by default
- Ensure write permissions to project directory

## Dependencies

**Key dependencies:**
- `bun` - Required runtime (v1.0+)
- `next` - Web framework
- `react` + `react-dom` - UI library
- `zustand` - State management
- `ws` - WebSocket server
- `zod` - Schema validation

**Never:**
- Add unnecessary dependencies
- Mix npm/bun/pnpm (use bun exclusively)
- Commit lockfiles from different package managers

## Performance Guidelines

**State updates:**
- Batch multiple state updates when possible
- Use `React.memo()` for expensive components
- Avoid creating new objects/functions in render

**Rendering:**
- Virtualize long lists (runs, nodes)
- Use CSS transforms for animations
- Lazy load heavy components

**Memory:**
- Clean up event listeners in useEffect cleanup
- Limit trace history (auto-trim old runs)
- Monitor for memory leaks in long-running sessions

## Security

**Development only:**
- UI designed for localhost only
- No authentication in current version
- Never expose WebSocket to public internet

**PII/Sensitive data:**
- Traces stored locally in plaintext
- No automatic redaction (manual review required)
- Clear storage regularly

## CI/CD Integration

**GitHub Actions workflow:**
- Runs on: push to main, pull requests, releases
- Steps: lint → type check → build → test
- Artifacts: executables for all platforms

**Local CI testing:**
```bash
# Run workflow locally
npx @redwoodjs/agent-ci run --quiet --workflow .github/workflows/build-executables.yml
```

## Emergency Procedures

**If build breaks:**
1. Check for TypeScript errors: `bunx tsc --noEmit`
2. Run lint with auto-fix: `bunx biome check --fix .`
3. Clear caches: `rm -rf .next dist node_modules/.cache`
4. Reinstall dependencies: `bun install`

**If release fails:**
1. Check GitHub Actions logs
2. Verify all matrix builds succeeded
3. Check artifact upload/download
4. Verify GitHub token permissions

---

**Last Updated:** 2025-03-31
**Applies to:** packages/ui/*
