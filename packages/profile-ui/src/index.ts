/**
 * @noetic-tools/profile-ui — the `ui@1` connection profile (spec 36 § Catalog
 * v1) and the sense grammars shared by every profile: summary formatters and
 * matcher parsers for `ui`, `net`, `log`, `route`, `state`, `signal`,
 * `storage` and `time` (spec 36 § Senses).
 */

/** @public The profile name this package defines. */
export const PROFILE_NAME = 'ui';

export * from './fields';
export * from './profile';
export * from './senses/glob';
export * from './senses/lexer';
export * from './senses/log';
export * from './senses/net';
export * from './senses/registry';
export * from './senses/route';
export * from './senses/signal';
export * from './senses/state';
export * from './senses/storage';
export * from './senses/time';
export * from './senses/types';
export * from './senses/ui';
