## Vercel Deployment Optimization

This change optimizes CI/CD by only triggering Vercel builds when the web package is modified.

### Changes Made

1. **Path-based CI Filtering** (`.github/workflows/ci.yml`)
   - Added `changes` job to detect which packages were modified
   - Split CI into separate jobs: `ci-core`, `ci-web`, and `eval-regression`
   - Web-related jobs only run when `packages/web/**` files change
   - Core jobs run when `packages/core/**` or `packages/memory/**` change
   - Eval jobs run when `packages/eval/**` changes
   - All jobs still run on push to main for safety

2. **Dedicated Vercel Workflow** (`.github/workflows/vercel.yml`)
   - Separate workflow specifically for Vercel deployments
   - Uses `paths` filter to only trigger on `packages/web/**` changes
   - Deploys to preview for PRs and production for main branch pushes
   - Posts preview URL as PR comment

### Benefits

- **Faster CI:** Web builds skipped when only core/eval packages change
- **No wasted Vercel builds:** Vercel only deploys when web content actually changes
- **Clearer CI feedback:** Separate job statuses for core vs web changes
- **Cost savings:** Fewer Vercel deployments = lower usage costs

### When Vercel Builds

Vercel will deploy when:
- ✅ Files in `packages/web/**` are modified
- ✅ The Vercel workflow file itself is modified
- ✅ On any push to main (to ensure production stays up to date)

Vercel will NOT deploy when:
- ❌ Only `packages/core/**` files change
- ❌ Only `packages/eval/**` files change
- ❌ Only documentation or config files outside web package change

### Testing

The CI workflow now has three separate jobs that can run independently:

1. **Core & Memory** - Runs when core packages change
2. **Web (Vercel)** - Runs when web package changes  
3. **Eval Regression** - Runs when eval package changes

All jobs still run linting across the entire codebase to ensure code quality.
