import { App } from 'aws-cdk-lib';
import { AppStack, APP_MODES, type AppMode } from '../lib/app-stack';
import { readStackManifest } from '../lib/manifest';

// The CDK app (MOTIR-9812). Every input is a context value the AWS adapter
// passes with `-c key=value`; nothing about an account lives in the repository.
//
//   appName          names the stack and every named resource (a DNS label)
//   mode             functions | containers (default functions)
//   imageRepository  the ECR repository CI pushed to (default: appName)
//   imageTag         the release's tag or digest (default: latest)
//   appUrl           optional — the public origin, as BETTER_AUTH_URL
//   certificateArn   optional, containers — HTTPS on the load balancer
//   invokerArn       optional, functions — who may invoke the function URL
//
// The account and region are the CDK environment's (CDK_DEFAULT_ACCOUNT /
// CDK_DEFAULT_REGION); with neither set, `cdk synth` emits an
// environment-agnostic template, which is what CI checks.

const app = new App();

function context(key: string): string | undefined {
  const value: unknown = app.node.tryGetContext(key);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

const appName = context('appName') ?? 'nextjs-prisma-aws-starter';
if (!/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(appName)) {
  throw new Error(`appName "${appName}" is not a DNS label of at most 63 characters`);
}
const mode = context('mode') ?? 'functions';
if (!(APP_MODES as readonly string[]).includes(mode)) {
  throw new Error(`mode "${mode}" is not one of ${APP_MODES.join(', ')}`);
}

new AppStack(app, 'App', {
  stackName: appName,
  appName,
  mode: mode as AppMode,
  manifest: readStackManifest(),
  imageRepository: context('imageRepository') ?? appName,
  imageTag: context('imageTag') ?? 'latest',
  appUrl: context('appUrl'),
  certificateArn: context('certificateArn'),
  invokerArn: context('invokerArn'),
  env: {
    account: process.env['CDK_DEFAULT_ACCOUNT'],
    region: process.env['CDK_DEFAULT_REGION'],
  },
});
