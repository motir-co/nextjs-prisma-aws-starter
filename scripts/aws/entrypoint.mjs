// The image's ENTRYPOINT (MOTIR-9812): loads the variables the AWS stack keeps
// in Secrets Manager (environment.mjs), then runs the command it was given —
// the manifest's `startCommand` (the image's CMD) or its
// `database.migrateCommand` (the migration task's command) — with them, and
// exits with that command's status.
//
// This is the hosting record's "secret delivery" (MOTIR-5769 §4): Lambda caps
// its environment at 4 KB, so on AWS the values live in one secret per
// environment and are loaded before `startCommand`. Off AWS no ARN is set, so
// it adds nothing and simply runs the command.

import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { resolveEnvironment } from './environment.mjs';

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('entrypoint: no command to run');
  process.exit(64);
}

async function readSecret(arn) {
  const { SecretsManagerClient, GetSecretValueCommand } =
    await import('@aws-sdk/client-secrets-manager');
  const out = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: arn }));
  if (typeof out.SecretString !== 'string')
    throw new Error(`The secret ${arn} has no string value`);
  return out.SecretString;
}

let added;
try {
  added = await resolveEnvironment(process.env, readSecret);
} catch (error) {
  console.error(`entrypoint: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(78);
}

const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env, ...added } });
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', (error) => {
  console.error(`entrypoint: ${command}: ${error.message}`);
  process.exit(127);
});
child.on('exit', (code, signal) => {
  process.exit(code ?? 128 + (signal ? constants.signals[signal] : 0));
});
