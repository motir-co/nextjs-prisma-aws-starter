import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { databaseUrl, RDS_CA_BUNDLE, resolveEnvironment } from '../scripts/aws/environment.mjs';

// THE IMAGE'S AWS ENTRYPOINT (MOTIR-9812): on AWS it turns the secret ARNs the
// stack hands the process into DATABASE_URL and the app's other variables; off
// AWS it adds nothing and runs the command as given.

const DB_ARN = 'arn:aws:secretsmanager:region:account:secret:db';
const ENV_ARN = 'arn:aws:secretsmanager:region:account:secret:env';
const rdsSecret = {
  username: 'app',
  password: 'p@ss/w:rd?',
  host: 'db.internal',
  port: 5432,
  engine: 'postgres',
};

function secrets(values: Record<string, unknown>) {
  const reads: string[] = [];
  const read = async (arn: string) => {
    reads.push(arn);
    if (!(arn in values)) throw new Error(`unexpected read of ${arn}`);
    return JSON.stringify(values[arn]);
  };
  return { read, reads };
}

describe('resolveEnvironment', () => {
  it('adds nothing and reads nothing when no ARN is set', async () => {
    const { read, reads } = secrets({});
    expect(await resolveEnvironment({ PORT: '3000' }, read)).toEqual({});
    expect(reads).toEqual([]);
  });

  it('builds DATABASE_URL from the RDS secret, with the RDS CA trusted', async () => {
    const { read } = secrets({ [DB_ARN]: rdsSecret });
    const added = await resolveEnvironment(
      { MOTIR_DATABASE_SECRET_ARN: DB_ARN, MOTIR_DATABASE_NAME: 'app' },
      read,
    );
    expect(added).toEqual({
      DATABASE_URL: 'postgresql://app:p%40ss%2Fw%3Ard%3F@db.internal:5432/app?sslmode=require',
      NODE_EXTRA_CA_CERTS: RDS_CA_BUNDLE,
    });
    expect(new URL(added['DATABASE_URL']!).password).toBe(encodeURIComponent(rdsSecret.password));
  });

  it('loads the environment secret, and an explicit variable wins over it', async () => {
    const { read } = secrets({
      [ENV_ARN]: { BETTER_AUTH_SECRET: 'from-secret', GOOGLE_CLIENT_ID: 'id', NOT_A_STRING: 1 },
    });
    const added = await resolveEnvironment(
      { MOTIR_ENV_SECRET_ARN: ENV_ARN, GOOGLE_CLIENT_ID: 'explicit' },
      read,
    );
    expect(added).toEqual({ BETTER_AUTH_SECRET: 'from-secret' });
  });

  it('leaves an explicit DATABASE_URL alone', async () => {
    const { read, reads } = secrets({});
    const added = await resolveEnvironment(
      { MOTIR_DATABASE_SECRET_ARN: DB_ARN, DATABASE_URL: 'postgresql://x' },
      read,
    );
    expect(added).toEqual({});
    expect(reads).toEqual([]);
  });

  it('refuses a secret that is not a JSON object', async () => {
    await expect(
      resolveEnvironment({ MOTIR_ENV_SECRET_ARN: ENV_ARN }, async () => 'not json'),
    ).rejects.toThrow('The secret named by MOTIR_ENV_SECRET_ARN is not JSON');
  });
});

describe('databaseUrl', () => {
  it('prefers the secret’s dbname over the fallback', () => {
    expect(databaseUrl({ ...rdsSecret, password: 'pw', dbname: 'main' }, 'app')).toBe(
      'postgresql://app:pw@db.internal:5432/main?sslmode=require',
    );
  });

  it('names every field it is missing', () => {
    expect(() => databaseUrl({ username: 'app' }, undefined)).toThrow(
      'The database secret has no password, host, port, dbname',
    );
  });
});

describe('entrypoint.mjs', () => {
  const entrypoint = join(__dirname, '..', 'scripts', 'aws', 'entrypoint.mjs');
  const env = { NODE_ENV: 'test', PATH: process.env['PATH'] } as const;

  it('off AWS, runs the command as given and exits with its status', () => {
    const run = spawnSync(
      process.execPath,
      [
        entrypoint,
        process.execPath,
        '-e',
        'console.log(process.env.DATABASE_URL ?? "unset"); process.exit(3)',
      ],
      { env, encoding: 'utf8' },
    );
    expect(run.stdout.trim()).toBe('unset');
    expect(run.status).toBe(3);
  });

  it('refuses to start with no command', () => {
    const run = spawnSync(process.execPath, [entrypoint], { env, encoding: 'utf8' });
    expect(run.status).toBe(64);
    expect(run.stderr).toContain('no command to run');
  });
});
