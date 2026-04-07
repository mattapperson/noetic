/**
 * Project root detection utility for Noetic
 *
 * Provides reliable detection of the project root directory (where package.json is located)
 * to ensure .noetic directories are created in the correct location regardless of
 * where the script is executed from.
 */

import { access, constants, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { cwd } from 'node:process';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Options for project root detection
 */
export interface ProjectRootOptions {
  /**
   * Explicit path to use (skips detection). Can be absolute or relative.
   * Environment variable NOETIC_PROJECT_ROOT takes precedence over this.
   */
  explicitPath?: string;

  /**
   * Maximum iterations when walking up directory tree (default: 20)
   */
  maxIterations?: number;

  /**
   * Starting directory for search (default: process.cwd())
   */
  startDir?: string;

  /**
   * Additional marker files to check for (besides package.json)
   * First match wins. Useful for monorepos or special project structures.
   */
  markerFiles?: string[];
}

/**
 * Result of project root detection
 */
export interface ProjectRootResult {
  /** The detected project root directory */
  root: string;

  /** How the root was determined */
  source: 'env' | 'explicit' | 'marker' | 'home';

  /** The marker file that was found (if applicable) */
  markerFound?: string;
}

// ============================================================================
// Environment Variable Names
// ============================================================================

const ENV_PROJECT_ROOT = 'NOETIC_PROJECT_ROOT';
const ENV_UI_STORAGE_PATH = 'NOETIC_UI_STORAGE_PATH';
const ENV_BASELINE_PATH = 'NOETIC_BASELINE_PATH';

// ============================================================================
// Core Detection Logic
// ============================================================================

/**
 * Detect the project root directory by looking for marker files
 * starting from the current working directory (or specified start) and walking up.
 *
 * Default marker files: package.json, .git
 * Additional markers can be specified via options.markerFiles
 */
export async function detectProjectRoot(
  options: ProjectRootOptions = {},
): Promise<ProjectRootResult | null> {
  const startTime = Date.now();
  const maxIterations = options.maxIterations ?? 20;
  let currentDir = options.startDir ? resolve(options.startDir) : cwd();

  // Default marker files
  const defaultMarkers = [
    'package.json',
    '.git',
  ];
  const customMarkers = options.markerFiles ?? [];
  const allMarkers = [
    ...customMarkers,
    ...defaultMarkers,
  ];

  for (let i = 0; i < maxIterations; i++) {
    // Check for marker files in priority order
    for (const marker of allMarkers) {
      try {
        const markerPath = join(currentDir, marker);
        await access(markerPath, constants.R_OK);

        // For package.json, verify it's valid
        if (marker === 'package.json') {
          const content = await readFile(markerPath, 'utf-8');
          const pkg = JSON.parse(content);
          if (!pkg.name) {
            continue; // Not a valid package.json, keep looking
          }
        }

        console.debug(
          `[ProjectRoot] Found at ${currentDir} via ${marker} in ${Date.now() - startTime}ms`,
        );
        return {
          root: currentDir,
          source: 'marker',
          markerFound: marker,
        };
      } catch {
        // Marker not found or not readable, continue to next marker
      }
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break; // Reached filesystem root
    }
    currentDir = parentDir;
  }

  console.debug(`[ProjectRoot] Not found after ${Date.now() - startTime}ms`);
  return null;
}

/**
 * Get the project root using the following priority:
 * 1. NOETIC_PROJECT_ROOT environment variable
 * 2. explicitPath option
 * 3. Auto-detection via detectProjectRoot()
 * 4. Fallback to home directory ~/.noetic/
 *
 * This ensures .noetic directories are always created in a predictable location.
 */
export async function getProjectRoot(options: ProjectRootOptions = {}): Promise<ProjectRootResult> {
  // Priority 1: Environment variable
  const envRoot = process.env[ENV_PROJECT_ROOT];
  if (envRoot) {
    const resolved = isAbsolute(envRoot) ? envRoot : resolve(cwd(), envRoot);
    console.debug(`[ProjectRoot] Using environment variable: ${resolved}`);
    return {
      root: resolved,
      source: 'env',
    };
  }

  // Priority 2: Explicit path option
  if (options.explicitPath) {
    const resolved = isAbsolute(options.explicitPath)
      ? options.explicitPath
      : resolve(options.startDir ?? cwd(), options.explicitPath);
    console.debug(`[ProjectRoot] Using explicit path: ${resolved}`);
    return {
      root: resolved,
      source: 'explicit',
    };
  }

  // Priority 3: Auto-detection
  const detected = await detectProjectRoot(options);
  if (detected) {
    return detected;
  }

  // Priority 4: Fallback to home directory
  const homeFallback = join(homedir(), '.noetic');
  console.debug(`[ProjectRoot] Falling back to home directory: ${homeFallback}`);
  return {
    root: homeFallback,
    source: 'home',
  };
}

/**
 * Get the default storage path for UI traces.
 * Uses NOETIC_UI_STORAGE_PATH env var, then project root detection, then home fallback.
 */
export async function getDefaultStoragePath(explicitPath?: string): Promise<string> {
  // Priority 1: UI-specific environment variable
  const envPath = process.env[ENV_UI_STORAGE_PATH];
  if (envPath) {
    return isAbsolute(envPath) ? envPath : resolve(cwd(), envPath);
  }

  // Priority 2: Explicit path (from constructor/options)
  if (explicitPath) {
    return isAbsolute(explicitPath) ? explicitPath : resolve(cwd(), explicitPath);
  }

  // Priority 3: Project root + .noetic/ui/traces
  const projectRoot = await getProjectRoot();
  return join(projectRoot.root, '.noetic', 'ui', 'traces');
}

/**
 * Get the default baseline path for eval baselines.
 * Uses NOETIC_BASELINE_PATH env var, then project root detection, then home fallback.
 */
export async function getDefaultBaselinePath(explicitPath?: string): Promise<string> {
  // Priority 1: Baseline-specific environment variable
  const envPath = process.env[ENV_BASELINE_PATH];
  if (envPath) {
    return isAbsolute(envPath) ? envPath : resolve(cwd(), envPath);
  }

  // Priority 2: Explicit path (from constructor/options)
  if (explicitPath) {
    return isAbsolute(explicitPath) ? explicitPath : resolve(cwd(), explicitPath);
  }

  // Priority 3: Project root + .noetic/baselines
  const projectRoot = await getProjectRoot();
  return join(projectRoot.root, '.noetic', 'baselines');
}

/**
 * Get a noetic subdirectory path (e.g., for custom storage needs)
 *
 * @param subdir - Subdirectory name under .noetic/ (e.g., 'custom-data')
 * @param explicitRoot - Optional explicit project root (overrides detection)
 */
export async function getNoeticSubdir(subdir: string, explicitRoot?: string): Promise<string> {
  if (explicitRoot) {
    return join(explicitRoot, '.noetic', subdir);
  }

  const projectRoot = await getProjectRoot();
  return join(projectRoot.root, '.noetic', subdir);
}

// ============================================================================
// Synchronous Variants (for cases where async is problematic)
// ============================================================================

import { existsSync, readFileSync } from 'node:fs';

/**
 * Synchronous version of detectProjectRoot
 * Uses sync fs operations - use with caution as it blocks the event loop.
 */
export function detectProjectRootSync(options: ProjectRootOptions = {}): ProjectRootResult | null {
  const maxIterations = options.maxIterations ?? 20;
  let currentDir = options.startDir ? resolve(options.startDir) : cwd();

  const defaultMarkers = [
    'package.json',
    '.git',
  ];
  const customMarkers = options.markerFiles ?? [];
  const allMarkers = [
    ...customMarkers,
    ...defaultMarkers,
  ];

  for (let i = 0; i < maxIterations; i++) {
    for (const marker of allMarkers) {
      try {
        const markerPath = join(currentDir, marker);
        if (!existsSync(markerPath)) {
          continue;
        }

        if (marker === 'package.json') {
          const content = readFileSync(markerPath, 'utf-8');
          const pkg = JSON.parse(content);
          if (!pkg.name) {
            continue;
          }
        }

        return {
          root: currentDir,
          source: 'marker',
          markerFound: marker,
        };
      } catch {
        // Continue to next marker
      }
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return null;
}

/**
 * Synchronous version of getProjectRoot
 */
export function getProjectRootSync(options: ProjectRootOptions = {}): ProjectRootResult {
  // Priority 1: Environment variable
  const envRoot = process.env[ENV_PROJECT_ROOT];
  if (envRoot) {
    const resolved = isAbsolute(envRoot) ? envRoot : resolve(cwd(), envRoot);
    return {
      root: resolved,
      source: 'env',
    };
  }

  // Priority 2: Explicit path
  if (options.explicitPath) {
    const resolved = isAbsolute(options.explicitPath)
      ? options.explicitPath
      : resolve(options.startDir ?? cwd(), options.explicitPath);
    return {
      root: resolved,
      source: 'explicit',
    };
  }

  // Priority 3: Auto-detection
  const detected = detectProjectRootSync(options);
  if (detected) {
    return detected;
  }

  // Priority 4: Fallback
  const homeFallback = join(homedir(), '.noetic');
  return {
    root: homeFallback,
    source: 'home',
  };
}

/**
 * Synchronous version of getDefaultBaselinePath
 */
export function getDefaultBaselinePathSync(explicitPath?: string): string {
  const envPath = process.env[ENV_BASELINE_PATH];
  if (envPath) {
    return isAbsolute(envPath) ? envPath : resolve(cwd(), envPath);
  }

  if (explicitPath) {
    return isAbsolute(explicitPath) ? explicitPath : resolve(cwd(), explicitPath);
  }

  const projectRoot = getProjectRootSync();
  return join(projectRoot.root, '.noetic', 'baselines');
}
