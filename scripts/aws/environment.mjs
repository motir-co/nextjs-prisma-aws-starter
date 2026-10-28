// What the AWS entrypoint adds to the app's environment (MOTIR-9812), kept
// apart from entrypoint.mjs so tests/aws-entrypoint.test.ts can drive it with
// no AWS call.
//
// On AWS the stack (infra/lib/app-stack.ts) hands the process ARNs, not values:
//
//   MOTIR_DATABASE_SECRET_ARN  the RDS-generated secret ({ username, password,
//                              host, port, dbname? }); MOTIR_DATABASE_NAME names
//                              the database when the secret does not
//   MOTIR_ENV_SECRET_ARN       a JSON object of further variables
//                              (BETTER_AUTH_SECRET, GOOGLE_*, …)
//
// A variable already set in the environment always wins, so a value passed
// explicitly is never replaced by the secret's. With neither ARN set — on Fly,
// on the serverless target, on a laptop — nothing is added.

/**
 * A failure the entrypoint may print. Its message is built only from fixed text
 * and variable NAMES, never from a value the environment or a secret holds, so
 * printing it cannot leak a credential.
 */
export class EnvironmentError extends Error {
  name = 'EnvironmentError';
}

/** The RDS certificate bundle the image ships; see the Dockerfile. */
export const RDS_CA_BUNDLE = '/app/aws/rds-global-bundle.pem';

/**
 * @param {Record<string, string | undefined>} env
 * @param {(arn: string) => Promise<string | undefined>} readSecret
 * @returns {Promise<Record<string, string>>}
 */
export async function resolveEnvironment(env, readSecret) {
  /** @type {Record<string, string>} */
  const added = {};

  const envSecretArn = env['MOTIR_ENV_SECRET_ARN'];
  if (envSecretArn) {
    const values = parseObject(
      await readNamedSecret(readSecret, envSecretArn, 'MOTIR_ENV_SECRET_ARN'),
      'MOTIR_ENV_SECRET_ARN',
    );
    for (const [name, value] of Object.entries(values)) {
      if (typeof value === 'string' && env[name] === undefined) added[name] = value;
    }
  }

  const databaseSecretArn = env['MOTIR_DATABASE_SECRET_ARN'];
  if (databaseSecretArn && env['DATABASE_URL'] === undefined) {
    const secret = parseObject(
      await readNamedSecret(readSecret, databaseSecretArn, 'MOTIR_DATABASE_SECRET_ARN'),
      'MOTIR_DATABASE_SECRET_ARN',
    );
    added['DATABASE_URL'] = databaseUrl(secret, env['MOTIR_DATABASE_NAME']);
    // RDS requires TLS, and node-postgres verifies the server's certificate,
    // which is signed by Amazon RDS's own CA rather than a public one.
    if (env['NODE_EXTRA_CA_CERTS'] === undefined) added['NODE_EXTRA_CA_CERTS'] = RDS_CA_BUNDLE;
  }

  return added;
}

/**
 * The Postgres URL for an RDS-generated secret. Every part is percent-encoded,
 * so a generated password with `@`, `/` or `:` in it cannot break the URL.
 *
 * @param {Record<string, unknown>} secret
 * @param {string | undefined} fallbackName
 */
export function databaseUrl(secret, fallbackName) {
  const field = (/** @type {string} */ name) => {
    const value = secret[name];
    if (typeof value === 'string' && value !== '') return value;
    if (typeof value === 'number') return String(value);
    return undefined;
  };
  const name = field('dbname') ?? fallbackName;
  const parts = {
    username: field('username'),
    password: field('password'),
    host: field('host'),
    port: field('port'),
    dbname: name,
  };
  const missing = Object.entries(parts)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new EnvironmentError(`The database secret has no ${missing.join(', ')}`);
  }
  const enc = encodeURIComponent;
  return `postgresql://${enc(parts.username)}:${enc(parts.password)}@${parts.host}:${parts.port}/${enc(parts.dbname)}?sslmode=require`;
}

/**
 * Reads one secret. A failure is reported by the variable that named it and the
 * error's class (`AccessDeniedException`, `ResourceNotFoundException`, …); the
 * SDK's own message is dropped, since nothing promises it holds no value.
 *
 * @param {(arn: string) => Promise<string | undefined>} readSecret
 * @param {string} arn
 * @param {string} source
 */
async function readNamedSecret(readSecret, arn, source) {
  let text;
  try {
    text = await readSecret(arn);
  } catch (error) {
    const kind = error instanceof Error ? error.name : typeof error;
    throw new EnvironmentError(`Reading the secret named by ${source} failed: ${kind}`);
  }
  if (typeof text !== 'string') {
    throw new EnvironmentError(`The secret named by ${source} has no string value`);
  }
  return text;
}

/**
 * @param {string} text
 * @param {string} source
 * @returns {Record<string, unknown>}
 */
function parseObject(text, source) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new EnvironmentError(`The secret named by ${source} is not JSON`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EnvironmentError(`The secret named by ${source} is not a JSON object`);
  }
  return value;
}
