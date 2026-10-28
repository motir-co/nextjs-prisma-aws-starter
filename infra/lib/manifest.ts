import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The fields of `motir.hosting.json` the infrastructure is built from (MOTIR-9812).
//
// The stack reads the repository's own manifest rather than repeating its
// values, so the port the load balancer forwards to, the path its health check
// polls and the command the migration step runs can never drift from what
// Motir reads. The full schema is motir-core's `parseHostingManifest`;
// tests/hosting-manifest.test.ts holds this repository's copy to it. This
// reader only refuses what the stack cannot be built without.

export interface StackManifest {
  port: number;
  healthCheckPath: string;
  startCommand: string;
  migrateCommand: string;
}

export const MANIFEST_PATH = join(__dirname, '..', '..', 'motir.hosting.json');

export function readStackManifest(path: string = MANIFEST_PATH): StackManifest {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    targets?: unknown;
    port?: unknown;
    healthCheck?: { path?: unknown };
    startCommand?: unknown;
    database?: { kind?: unknown; migrateCommand?: unknown };
  };
  if (!Array.isArray(raw.targets) || !raw.targets.includes('aws')) {
    throw new Error(`${path}: targets does not list "aws"`);
  }
  if (typeof raw.port !== 'number') throw new Error(`${path}: port is not a number`);
  const healthCheckPath = raw.healthCheck?.path;
  if (typeof healthCheckPath !== 'string') throw new Error(`${path}: healthCheck.path is missing`);
  if (typeof raw.startCommand !== 'string') throw new Error(`${path}: startCommand is missing`);
  const migrateCommand = raw.database?.migrateCommand;
  if (raw.database?.kind !== 'postgres' || typeof migrateCommand !== 'string') {
    throw new Error(`${path}: database must be postgres with a migrateCommand`);
  }
  return { port: raw.port, healthCheckPath, startCommand: raw.startCommand, migrateCommand };
}
