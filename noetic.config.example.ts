/**
 * Example Noetic configuration with worktree setup including post-merge hooks
 * and automatic dependency installation.
 */
import type { AgentConfig } from './packages/cli/src/types/config.js';

export default {
  model: 'anthropic/claude-sonnet-4',
  apiKey: process.env.NOETIC_API_KEY!,
  maxTurns: 100,
  cwd: process.cwd(),

  worktree: {
    // Custom worktree path template (optional)
    'worktree-path': '{{ repo_path }}/.worktrees/{{ agent_id | sanitize }}',
    
    // Custom branch template (optional)
    branch: 'noetic/{{ agent_id }}',
    
    // Run before creating the worktree
    'pre-start': 'git fetch origin',
    
    // Run after creating the worktree (in background)
    // Note: 'bun install' is automatically added to post-start hooks
    'post-start': {
      'setup-env': 'cp .env.example .env',
      'install-playwright': 'bunx playwright install --with-deps',
    },
    
    // NEW: Clone files from main worktree to new worktree (supports glob patterns)
    'clone-files': [
      '.env*',              // Clone all .env files
      'config/.env*',       // Clone config/*.env files
      '*.local',            // Clone any .local files
      'certificates/*',     // Clone entire certificates directory
    ],
    
    // NEW: Run after merging worktree back to main (for dependency updates)
    'post-merge': {
      'install-deps': 'bun install',
      'update-lockfile': 'bun install --frozen-lockfile=false',
      'rebuild': 'bun run build',
    },
    
    // Run before removing the worktree
    'pre-remove': 'bun run lint',
    
    // When to clean up worktrees: 'always' | 'if-clean' | 'never'
    cleanup: 'if-clean',
  },
} satisfies AgentConfig;