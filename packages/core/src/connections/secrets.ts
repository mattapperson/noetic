/**
 * Secrets (spec 35 § Secrets). A secret is resolved through
 * `environment.secrets` immediately before the call is sent, allowed only in
 * fields a profile marks `sensitive`, and never by the model. Before any
 * output, event, read or text is stored, traced or shown, every resolved value
 * — and its URL-encoded and base64 forms — is replaced with `"<redacted>"`.
 */

import type { JsonSchemaObject, Secret, SecretResolver } from '@noetic-tools/types';
import { frameworkCast, isSecret, REDACTED_TEXT } from '@noetic-tools/types';
import { invalidConnectionError, secretRefusedError } from './errors';
import type { JsonPath } from './json-schema';
import { secretAllowedAt } from './json-schema';
import type { ConnectionCaller } from './registry-types';
import { findDeep, mapDeep } from './values';

//#region Types

/** Where secrets are being checked or filled. */
export interface SecretSite {
  readonly connection: string;
  readonly op: string;
  readonly caller: ConnectionCaller;
  /** The operation's input schema; secrets are allowed only where it accepts `{ $secret }`. */
  readonly inputSchema: JsonSchemaObject;
  /** For documents: the only secrets (and the fields they fill) the call may send. */
  readonly allowedSecrets?: ReadonlyArray<{
    readonly name: string;
    readonly field: string;
  }>;
}

//#endregion

//#region Helpers

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64Url(encoded: string): string {
  return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fieldOf(path: JsonPath): string {
  return path.filter((segment) => typeof segment === 'string').join('.');
}

function secretDeclared(site: SecretSite, name: string, path: JsonPath): boolean {
  if (!site.allowedSecrets) {
    return true;
  }
  const field = fieldOf(path);
  return site.allowedSecrets.some((allowed) => allowed.name === name && allowed.field === field);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

//#endregion

//#region Public API

/** Remembers every resolved secret value and replaces it wherever it shows up. */
export class SecretScrubber {
  private readonly forms = new Set<string>();
  private pattern: RegExp | undefined;

  /** Registers a resolved value: raw, URL-encoded and base64 (standard and URL-safe). */
  add(value: string): void {
    if (value.length === 0) {
      return;
    }
    const encoded = base64(value);
    const candidates = [
      value,
      encodeURIComponent(value),
      encoded,
      encoded.replace(/=+$/, ''),
      base64Url(encoded),
    ];
    for (const form of candidates) {
      this.forms.add(form);
    }
    this.pattern = undefined;
  }

  /** Whether any secret has been resolved yet. */
  get active(): boolean {
    return this.forms.size > 0;
  }

  /** `text` with every known secret form replaced by `"<redacted>"`. */
  scrubText(text: string): string {
    if (this.forms.size === 0) {
      return text;
    }
    if (!this.pattern) {
      const longestFirst = [
        ...this.forms,
      ].sort((a, b) => b.length - a.length);
      this.pattern = new RegExp(longestFirst.map(escapeRegExp).join('|'), 'g');
    }
    return text.replace(this.pattern, REDACTED_TEXT);
  }

  /** A copy of `value` with every string scrubbed. */
  scrub<T>(value: T): T {
    if (this.forms.size === 0) {
      return value;
    }
    const scrubbed = mapDeep(value, (node) =>
      typeof node.value === 'string'
        ? {
            replace: this.scrubText(node.value),
          }
        : undefined,
    );
    // mapDeep keeps the shape of `value`, replacing only strings with strings.
    return frameworkCast<T>(scrubbed);
  }
}

/** The secrets in `args`, with where each sits. */
export function findSecrets(args: unknown): ReadonlyArray<{
  readonly value: Secret;
  readonly path: JsonPath;
}> {
  return findDeep(args, isSecret);
}

/**
 * Refuses secrets the model sent, that sit outside a `sensitive` field, or —
 * for a document — that its node does not write out.
 *
 * @throws NoeticErrorImpl `connection_secret_refused`.
 */
export function checkSecrets(args: unknown, site: SecretSite): void {
  const secrets = findSecrets(args);
  if (secrets.length === 0) {
    return;
  }
  if (site.caller === 'model') {
    throw secretRefusedError(site.connection, site.op);
  }
  for (const found of secrets) {
    if (!secretDeclared(site, found.value.$secret, found.path)) {
      throw secretRefusedError(site.connection, site.op);
    }
    if (!secretAllowedAt(site.inputSchema, found.path)) {
      throw secretRefusedError(site.connection, site.op);
    }
  }
}

/**
 * Replaces each `{ $secret }` in `args` with its resolved value and registers
 * the value with `scrubber`.
 *
 * @throws NoeticConfigError `CONNECTION_INVALID` when secrets are used but no resolver is configured.
 */
export async function fillSecrets(
  args: unknown,
  deps: {
    readonly resolver: SecretResolver | undefined;
    readonly scrubber: SecretScrubber;
    readonly signal: AbortSignal;
  },
): Promise<unknown> {
  const secrets = findSecrets(args);
  if (secrets.length === 0) {
    return args;
  }
  const resolver = deps.resolver;
  if (!resolver) {
    throw invalidConnectionError(
      'A call uses secret() but the harness has no secret resolver.',
      'Set `environment.secrets` on the AgentHarness to resolve secret names.',
    );
  }
  const resolved = new Map<string, string>();
  for (const found of secrets) {
    const name = found.value.$secret;
    if (resolved.has(name)) {
      continue;
    }
    const value = await resolver.resolve(name, {
      signal: deps.signal,
    });
    deps.scrubber.add(value);
    resolved.set(name, value);
  }
  return mapDeep(args, (node) =>
    isSecret(node.value)
      ? {
          replace: resolved.get(node.value.$secret),
        }
      : undefined,
  );
}

//#endregion
