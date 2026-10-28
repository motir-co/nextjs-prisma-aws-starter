import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { APP_MODES, AppStack, ORIGIN_SECRET_HEADER, type AppMode } from '../infra/lib/app-stack';
import { readStackManifest } from '../infra/lib/manifest';

// THE AWS STACK, SYNTHESIZED IN BOTH MODES (MOTIR-9812).
//
// What must hold before anything is deployed, read off the CloudFormation
// templates themselves: the database is private and reachable only from the
// app and the migration step, its credential is a Secrets Manager secret, no
// IAM statement grants every action on every resource, the migration step runs
// before the app changes, and every name derives from `appName`. No AWS
// credential is needed — synth is local.

const APP_NAME = 'acme-crm';
const manifest = readStackManifest();

type Resources = Record<
  string,
  { Type: string; Properties?: Record<string, unknown>; DependsOn?: string[] }
>;

function synth(mode: AppMode): { template: Template; resources: Resources } {
  const app = new App();
  const stack = new AppStack(app, 'App', {
    stackName: APP_NAME,
    appName: APP_NAME,
    mode,
    manifest,
    imageRepository: `mh/${APP_NAME}/production`,
    imageTag: 'release-1',
  });
  const template = Template.fromStack(stack);
  return { template, resources: template.toJSON().Resources as Resources };
}

const templates = Object.fromEntries(APP_MODES.map((mode) => [mode, synth(mode)])) as Record<
  AppMode,
  ReturnType<typeof synth>
>;

function idsOf(resources: Resources, type: string): string[] {
  return Object.entries(resources)
    .filter(([, r]) => r.Type === type)
    .map(([id]) => id);
}

function only(resources: Resources, type: string): string {
  const ids = idsOf(resources, type);
  expect(ids).toHaveLength(1);
  return ids[0]!;
}

/** The logical id a `{ Fn::GetAtt: [id, …] }` or `{ Ref: id }` points at. */
function refTo(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as { Ref?: string; 'Fn::GetAtt'?: [string, string] };
  return v.Ref ?? v['Fn::GetAtt']?.[0];
}

/** Every IAM statement in the template: managed by CDK in Policy resources and role inline policies. */
function statements(resources: Resources): { id: string; Action: unknown; Resource: unknown }[] {
  const out: { id: string; Action: unknown; Resource: unknown }[] = [];
  for (const [id, r] of Object.entries(resources)) {
    const docs: { Statement: { Action: unknown; Resource: unknown }[] }[] = [];
    if (r.Type === 'AWS::IAM::Policy') docs.push(r.Properties!['PolicyDocument'] as never);
    if (r.Type === 'AWS::IAM::Role') {
      for (const p of (r.Properties!['Policies'] as { PolicyDocument: never }[] | undefined) ?? [])
        docs.push(p.PolicyDocument);
    }
    for (const doc of docs) for (const s of doc.Statement) out.push({ id, ...s });
  }
  return out;
}

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);

describe.each(APP_MODES)('the %s template', (mode) => {
  const { template, resources } = templates[mode];

  it('keeps the database private, in subnets with no route out', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      PubliclyAccessible: false,
      StorageEncrypted: true,
      Engine: 'postgres',
    });
    const db = resources[only(resources, 'AWS::RDS::DBInstance')]!;
    const subnetGroup = resources[refTo(db.Properties!['DBSubnetGroupName'])!]!;
    for (const subnet of subnetGroup.Properties!['SubnetIds'] as unknown[]) {
      const id = refTo(subnet)!;
      // An isolated subnet's route table has no default route.
      const association = Object.values(resources).find(
        (r) =>
          r.Type === 'AWS::EC2::SubnetRouteTableAssociation' &&
          refTo(r.Properties!['SubnetId']) === id,
      )!;
      const table = refTo(association.Properties!['RouteTableId']);
      const routes = Object.values(resources).filter(
        (r) => r.Type === 'AWS::EC2::Route' && refTo(r.Properties!['RouteTableId']) === table,
      );
      expect(routes).toEqual([]);
    }
  });

  it('admits only the app and the migration step to the database', () => {
    const db = resources[only(resources, 'AWS::RDS::DBInstance')]!;
    const dbSgs = (db.Properties!['VPCSecurityGroups'] as unknown[]).map(refTo);
    expect(dbSgs).toHaveLength(1);
    const dbSg = dbSgs[0]!;

    // No inline rule opens it to an address range.
    expect(resources[dbSg]!.Properties!['SecurityGroupIngress']).toBeUndefined();

    const sources = Object.values(resources)
      .filter(
        (r) =>
          r.Type === 'AWS::EC2::SecurityGroupIngress' && refTo(r.Properties!['GroupId']) === dbSg,
      )
      .map((r) => {
        expect(r.Properties!['CidrIp']).toBeUndefined();
        expect(r.Properties!['FromPort']).toBe(5432);
        expect(r.Properties!['ToPort']).toBe(5432);
        return refTo(r.Properties!['SourceSecurityGroupId']);
      });
    expect(sources.sort()).toEqual(
      ['AppSecurityGroup', 'MigrateSecurityGroup']
        .map((prefix) => Object.keys(resources).find((id) => id.startsWith(prefix))!)
        .sort(),
    );

    // And those two are the groups the app and the migration task run in.
    const migrate = resources[only(resources, 'Custom::MotirMigration')]!;
    expect((migrate.Properties!['SecurityGroups'] as unknown[]).map(refTo)).toEqual([
      sources.find((s) => s!.startsWith('MigrateSecurityGroup')),
    ]);
  });

  it('keeps the database credential in Secrets Manager', () => {
    const db = resources[only(resources, 'AWS::RDS::DBInstance')]!;
    const password = JSON.stringify(db.Properties!['MasterUserPassword']);
    expect(password).toContain('{{resolve:secretsmanager:');
    template.hasResourceProperties('AWS::SecretsManager::Secret', { Name: `${APP_NAME}/database` });
    template.resourceCountIs('AWS::SecretsManager::SecretTargetAttachment', 1);
    // The app receives the secret's ARN, never its value.
    expect(JSON.stringify(resources)).not.toMatch(/DATABASE_URL/);
  });

  it('grants no IAM statement every action on every resource', () => {
    const wild = statements(resources).filter(
      (s) => list(s.Action).includes('*') && list(s.Resource).includes('*'),
    );
    expect(wild).toEqual([]);
  });

  it('runs the migration step before the app is created or updated', () => {
    const migration = only(resources, 'Custom::MotirMigration');
    const appType = mode === 'functions' ? 'AWS::Lambda::Function' : 'AWS::ECS::Service';
    const app = Object.keys(resources).find(
      (id) => id.startsWith('App') && resources[id]!.Type === appType,
    )!;
    expect(resources[app]!.DependsOn).toContain(migration);

    // It runs the manifest's migrate command, from the release's image, again for each release.
    template.hasResourceProperties('Custom::MotirMigration', { Release: 'release-1' });
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: `${APP_NAME}-migrate`,
      ContainerDefinitions: [{ Command: manifest.migrateCommand.split(' ') }],
    });
  });

  it('derives every name from appName and writes no account id', () => {
    template.hasResourceProperties('AWS::ECS::Cluster', { ClusterName: APP_NAME });
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: `${APP_NAME}/environment`,
    });
    const json = JSON.stringify(template.toJSON());
    expect(json).not.toMatch(/\b\d{12}\b/);
    expect(json).not.toMatch(/AKIA[0-9A-Z]{16}/);
  });
});

describe('functions mode', () => {
  const { template } = templates.functions;

  it('runs the image on Lambda in the VPC behind an IAM-authenticated function URL', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: APP_NAME,
      PackageType: 'Image',
      Architectures: ['x86_64'],
      MemorySize: 1769,
      VpcConfig: {},
    });
    template.hasResourceProperties('AWS::Lambda::Alias', { Name: 'live' });
    template.hasResourceProperties('AWS::Lambda::Url', {
      AuthType: 'AWS_IAM',
      InvokeMode: 'RESPONSE_STREAM',
    });
    template.resourceCountIs('AWS::ECS::Service', 0);
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0);
  });
});

describe('containers mode', () => {
  const { template, resources } = templates.containers;

  it('runs the image on Fargate behind a load balancer that checks the manifest’s health path', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      ServiceName: APP_NAME,
      LaunchType: 'FARGATE',
      NetworkConfiguration: { AwsvpcConfiguration: { AssignPublicIp: 'DISABLED' } },
    });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      Port: manifest.port,
      HealthCheckPath: manifest.healthCheckPath,
    });
    template.resourceCountIs('AWS::Lambda::Url', 0);
  });

  it('answers 403 unless the request carries the origin secret', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      DefaultActions: [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '403' } }],
    });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerRule', {
      Conditions: [
        {
          Field: 'http-header',
          HttpHeaderConfig: {
            HttpHeaderName: ORIGIN_SECRET_HEADER,
            Values: [{ Ref: 'OriginSecret' }],
          },
        },
      ],
    });
    template.hasParameter('OriginSecret', { NoEcho: true });
    // The app's port is open to the load balancer only.
    const appIngress = Object.values(resources).filter(
      (r) =>
        r.Type === 'AWS::EC2::SecurityGroupIngress' &&
        refTo(r.Properties!['GroupId'])?.startsWith('AppSecurityGroup'),
    );
    expect(appIngress.map((r) => refTo(r.Properties!['SourceSecurityGroupId']))).toEqual([
      expect.stringMatching(/^LoadBalancerSecurityGroup/),
    ]);
  });
});
