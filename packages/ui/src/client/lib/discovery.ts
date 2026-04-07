/**
 * Agent discovery utilities
 * Build-time static analysis for finding agents in the codebase
 */

import type { DiscoveredAgent, RegisteredAgent } from '../types/agent';

// Default file patterns for agent discovery
export const DEFAULT_AGENT_PATTERNS = [
  '**/*.agent.ts',
  '**/agents/**/*.ts',
  '**/*.noetic.ts',
];

// Environment variable for custom patterns
const PATTERNS_ENV_VAR = 'NOETIC_UI_AGENT_PATTERNS';

/**
 * Check if running in Node.js environment
 */
function isNodeEnvironment(): boolean {
  return typeof process !== 'undefined' && process.versions?.node !== undefined;
}

/**
 * Get the file patterns to scan for agents
 */
export function getAgentPatterns(): string[] {
  if (typeof process !== 'undefined' && process.env[PATTERNS_ENV_VAR]) {
    return process.env[PATTERNS_ENV_VAR].split(',').map((p) => p.trim());
  }
  return DEFAULT_AGENT_PATTERNS;
}

/**
 * Hash function to generate unique agent IDs
 * Combines file path and export name
 */
export function generateAgentId(filePath: string, exportName: string): string {
  const str = `${filePath}:${exportName}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return `agent-${Math.abs(hash).toString(36)}`;
}

/**
 * Extract agent name from file path or JSDoc
 */
export function extractAgentName(filePath: string, jsDocName?: string): string {
  if (jsDocName) {
    return jsDocName;
  }

  // Extract filename without extension
  const fileName =
    filePath
      .split('/')
      .pop()
      ?.replace(/\.[^.]+$/, '') ?? 'unknown';

  // Convert kebab/snake case to title case
  return fileName.replace(/[-_]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * Parse JSDoc comments from agent file content
 */
export function parseJSDocComments(content: string): {
  name?: string;
  description?: string;
} {
  const jsdocRegex = /\/\*\*\s*([\s\S]*?)\s*\*\//;
  const match = content.match(jsdocRegex);

  if (!match) {
    return {};
  }

  const jsdoc = match[1];
  const nameMatch = jsdoc.match(/@name\s+(\S+)/);
  const descMatch = jsdoc.match(/@description\s+(.+)/) ?? jsdoc.match(/^\s*\*\s+(.+)$/m);

  return {
    name: nameMatch?.[1],
    description: descMatch?.[1]?.trim(),
  };
}

/**
 * Check if file content contains AgentHarness usage
 */
export function containsAgentHarness(content: string): boolean {
  return (
    content.includes('AgentHarness') ||
    content.includes('createAgent') ||
    content.includes('createDebugHarness')
  );
}

/**
 * Discover agents from file system (build-time)
 * This would be called during dev server start or build
 *
 * Note: This function uses Node.js fs module and only works server-side.
 * In client-side environments, it returns an empty array.
 */
export async function discoverAgents(
  projectRoot: string,
  patterns?: string[],
): Promise<DiscoveredAgent[]> {
  // Only scan files in Node.js environment (server-side/build-time)
  if (!isNodeEnvironment()) {
    return [];
  }

  // Dynamic import of fs module (only evaluated server-side)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = await import(/* webpackIgnore: true */ 'node:fs/promises');

  const scanPatterns = patterns ?? getAgentPatterns();
  const discovered: DiscoveredAgent[] = [];

  await scanDirectoryWithFs(projectRoot, scanPatterns, discovered, fs);

  return discovered;
}

/**
 * Simple glob pattern matcher
 * Supports * (any chars) and ** (any dirs)
 */
function matchGlobPattern(filePath: string, pattern: string): boolean {
  // Convert glob pattern to regex
  const regexPattern = pattern
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(filePath);
}

/**
 * Recursively scan directory for files matching patterns
 * Requires fs module passed as parameter
 */
async function scanDirectoryWithFs(
  dir: string,
  patterns: string[],
  discovered: DiscoveredAgent[],
  fs: typeof import('node:fs/promises'),
): Promise<void> {
  try {
    const entries = await fs.readdir(dir, {
      withFileTypes: true,
      recursive: true,
    });

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      // Get relative path from project root
      const relativePath = entry.parentPath
        ? `${entry.parentPath}/${entry.name}`.replace(dir, '').replace(/^\//, '')
        : entry.name;

      // Check if file matches any pattern
      const matchesPattern = patterns.some(
        (pattern) =>
          matchGlobPattern(relativePath, pattern) || matchGlobPattern(entry.name, pattern),
      );

      if (matchesPattern) {
        const fullPath = entry.parentPath
          ? `${entry.parentPath}/${entry.name}`
          : `${dir}/${entry.name}`;

        try {
          const content = await fs.readFile(fullPath, 'utf-8');

          // Check if file contains agent harness
          if (containsAgentHarness(content)) {
            const jsdoc = parseJSDocComments(content);

            // Find export names (simple regex-based extraction)
            const exportMatches = content.match(/export\s+(?:const|let|var|default)\s+(\w+)/g);
            const exportNames = exportMatches?.map((m) => {
              const match = m.match(/export\s+(?:const|let|var|default)\s+(\w+)/);
              return match?.[1] || 'default';
            }) || [
              'default',
            ];

            for (const exportName of exportNames) {
              discovered.push({
                id: generateAgentId(fullPath, exportName),
                filePath: fullPath,
                exportName,
                name: extractAgentName(fullPath, jsdoc.name),
                description: jsdoc.description,
                discoveredAt: Date.now(),
                discoveryMethod: 'static',
              });
            }
          }
        } catch (error) {
          // Skip files that can't be read
          console.warn(`[Discovery] Failed to read file ${fullPath}:`, error);
        }
      }
    }
  } catch (error) {
    console.error('[Discovery] Failed to scan directory:', error);
  }
}

/**
 * Manual agent registration
 * For agents not caught by static analysis
 */
export function registerAgent(agent: RegisteredAgent): void {
  // In a real implementation, this would:
  // 1. Validate the agent configuration
  // 2. Store in localStorage for persistence
  // 3. Notify the UI store of the new agent
  // 4. Optionally load the harness module

  const registration = {
    ...agent,
    registeredAt: Date.now(),
  };

  // Persist to localStorage
  if (typeof localStorage !== 'undefined') {
    const existing = JSON.parse(localStorage.getItem('noetic-registered-agents') ?? '[]');
    existing.push(registration);
    localStorage.setItem('noetic-registered-agents', JSON.stringify(existing));
  }
}

/**
 * Load manually registered agents from localStorage
 */
export function loadRegisteredAgents(): RegisteredAgent[] {
  if (typeof localStorage === 'undefined') {
    return [];
  }

  try {
    const stored = localStorage.getItem('noetic-registered-agents');
    if (!stored) {
      return [];
    }
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) {
      return [];
    }

    // Filter items that have the required properties
    return parsed.filter((item: unknown) => {
      if (typeof item !== 'object' || item === null) {
        return false;
      }
      // Direct property access without intermediate variable
      return (
        'id' in item &&
        typeof item.id === 'string' &&
        'filePath' in item &&
        typeof item.filePath === 'string' &&
        'name' in item &&
        typeof item.name === 'string'
      );
    });
  } catch (error) {
    console.error('[Discovery] Failed to load agents from localStorage:', error);
    return [];
  }
}

/**
 * Unregister a manually added agent
 */
export function unregisterAgent(id: string): void {
  if (typeof localStorage === 'undefined') {
    return;
  }

  const existing = JSON.parse(localStorage.getItem('noetic-registered-agents') ?? '[]');
  const filtered = existing.filter((a: RegisteredAgent) => a.id !== id);
  localStorage.setItem('noetic-registered-agents', JSON.stringify(filtered));
}

/**
 * Discovery status types
 */
export interface DiscoveryStatus {
  isScanning: boolean;
  filesScanned: number;
  agentsFound: number;
  lastScanTime: number | null;
  error?: string;
}

/**
 * Create a discovery status tracker
 */
export function createDiscoveryTracker(): {
  status: DiscoveryStatus;
  startScan: () => void;
  updateProgress: (filesScanned: number, agentsFound: number) => void;
  completeScan: () => void;
  failScan: (error: string) => void;
} {
  const status: DiscoveryStatus = {
    isScanning: false,
    filesScanned: 0,
    agentsFound: 0,
    lastScanTime: null,
  };

  return {
    status,
    startScan: () => {
      status.isScanning = true;
      status.filesScanned = 0;
      status.agentsFound = 0;
      status.error = undefined;
    },
    updateProgress: (filesScanned, agentsFound) => {
      status.filesScanned = filesScanned;
      status.agentsFound = agentsFound;
    },
    completeScan: () => {
      status.isScanning = false;
      status.lastScanTime = Date.now();
    },
    failScan: (error: string) => {
      status.isScanning = false;
      status.error = error;
    },
  };
}
