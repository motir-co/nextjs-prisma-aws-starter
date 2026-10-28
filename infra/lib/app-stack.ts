import { join } from 'node:path';
import {
  CfnOutput,
  CfnParameter,
  CustomResource,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import type { StackManifest } from './manifest';

// The AWS web starter's infrastructure (MOTIR-9812): ONE stack, the compute
// chosen by `mode`.
//
//   functions   the image on Lambda through the Lambda Web Adapter, behind a
//               function URL that only a SigV4-signed caller may invoke
//               (the hosting record, MOTIR-5769 §3–§4: "AWS functions").
//   containers  the image on ECS Fargate behind an Application Load Balancer
//               that answers 403 to any request without the origin secret
//               (the record's "AWS containers").
//
// Shared by both: a VPC whose database subnets have no route out, RDS for
// PostgreSQL (the record's D-6; engine per MOTIR-9702) with its credentials
// generated into Secrets Manager, and a migration step — the manifest's
// `database.migrateCommand`, run as a one-off Fargate task inside the VPC —
// that the app depends on, so CloudFormation migrates before it moves traffic.
//
// The stack deploys nothing by itself and names no account, region or
// credential: those come from the CDK environment the AWS adapter deploys with.

export const APP_MODES = ['functions', 'containers'] as const;
export type AppMode = (typeof APP_MODES)[number];

/** The header a forwarder sends to a containers-mode upstream (record §4). */
export const ORIGIN_SECRET_HEADER = 'X-Motir-Origin-Secret';

export interface AppStackProps extends StackProps {
  /** Every name in the stack derives from this; the adapter supplies it. */
  appName: string;
  mode: AppMode;
  manifest: StackManifest;
  /** The ECR repository the repository's CI pushed the image to. */
  imageRepository: string;
  /** The tag (or digest) of the release being deployed. */
  imageTag: string;
  /** The app's public origin, given to Better-Auth as BETTER_AUTH_URL. */
  appUrl?: string;
  /** containers: an ACM certificate for the load balancer's HTTPS listener. */
  certificateArn?: string;
  /** functions: the principal allowed to invoke the function URL. */
  invokerArn?: string;
}

export class AppStack extends Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const { appName, mode, manifest } = props;

    // ── Network ─────────────────────────────────────────────────────────────
    // `app` subnets reach the internet through one NAT gateway (ECR, Secrets
    // Manager, OAuth providers); `data` subnets have no route out at all.
    const vpc = new ec2.Vpc(this, 'Network', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'app', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    const appSubnets = { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS };

    const appSg = new ec2.SecurityGroup(this, 'AppSecurityGroup', {
      vpc,
      description: `${appName} app`,
    });
    const migrateSg = new ec2.SecurityGroup(this, 'MigrateSecurityGroup', {
      vpc,
      description: `${appName} migration step`,
    });
    const dbSg = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc,
      description: `${appName} database: the app and the migration step only`,
      allowAllOutbound: false,
    });
    dbSg.addIngressRule(appSg, ec2.Port.tcp(5432), 'the app');
    dbSg.addIngressRule(migrateSg, ec2.Port.tcp(5432), 'the migration step');

    // ── Database ────────────────────────────────────────────────────────────
    const databaseName = 'app';
    const database = new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_17 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      publiclyAccessible: false,
      databaseName,
      credentials: rds.Credentials.fromGeneratedSecret('app', {
        secretName: `${appName}/database`,
      }),
      storageEncrypted: true,
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      backupRetention: Duration.days(7),
      deletionProtection: true,
      removalPolicy: RemovalPolicy.SNAPSHOT,
    });
    const databaseSecret = database.secret!;

    // Every other variable the app reads arrives through this one secret,
    // loaded by the image's entrypoint (scripts/aws/entrypoint.mjs) — Lambda's
    // environment is capped at 4 KB (record §4, "Secret delivery"). It starts
    // with a generated BETTER_AUTH_SECRET; the configuration work adds the rest.
    const environmentSecret = new secretsmanager.Secret(this, 'Environment', {
      secretName: `${appName}/environment`,
      description: `${appName}: environment variables the entrypoint loads`,
      generateSecretString: {
        secretStringTemplate: '{}',
        generateStringKey: 'BETTER_AUTH_SECRET',
        passwordLength: 48,
        excludePunctuation: true,
      },
    });

    const runtimeEnvironment: Record<string, string> = {
      MOTIR_DATABASE_SECRET_ARN: databaseSecret.secretArn,
      MOTIR_DATABASE_NAME: databaseName,
      MOTIR_ENV_SECRET_ARN: environmentSecret.secretArn,
      ...(props.appUrl ? { BETTER_AUTH_URL: props.appUrl } : {}),
    };

    const repository = ecr.Repository.fromRepositoryName(this, 'Images', props.imageRepository);
    const containerImage = ecs.ContainerImage.fromEcrRepository(repository, props.imageTag);
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc, clusterName: appName });

    // ── Migration step ──────────────────────────────────────────────────────
    const migrateFamily = `${appName}-migrate`;
    const migrateTask = new ecs.FargateTaskDefinition(this, 'MigrateTask', {
      family: migrateFamily,
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    const migrateContainer = migrateTask.addContainer('migrate', {
      image: containerImage,
      command: manifest.migrateCommand.split(' '),
      environment: runtimeEnvironment,
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'migrate',
        logGroup: this.logGroup('MigrateLogs', `/motir/${appName}/migrate`),
      }),
    });
    databaseSecret.grantRead(migrateTask.taskRole);
    environmentSecret.grantRead(migrateTask.taskRole);

    const runnerCode = lambda.Code.fromAsset(join(__dirname, '..', 'migration-runner'));
    const runnerProps = {
      runtime: lambda.Runtime.NODEJS_22_X,
      code: runnerCode,
      timeout: Duration.minutes(1),
    };
    const onEvent = new lambda.Function(this, 'MigrateStart', {
      ...runnerProps,
      handler: 'index.onEvent',
      logGroup: this.logGroup('MigrateStartLogs', `/motir/${appName}/migrate-start`),
    });
    const isComplete = new lambda.Function(this, 'MigrateWait', {
      ...runnerProps,
      handler: 'index.isComplete',
      logGroup: this.logGroup('MigrateWaitLogs', `/motir/${appName}/migrate-wait`),
    });
    onEvent.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecs:RunTask'],
        resources: [migrateTask.taskDefinitionArn],
        conditions: { ArnEquals: { 'ecs:cluster': cluster.clusterArn } },
      }),
    );
    onEvent.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [migrateTask.taskRole.roleArn, migrateTask.obtainExecutionRole().roleArn],
      }),
    );
    isComplete.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecs:DescribeTasks'],
        resources: [
          this.formatArn({ service: 'ecs', resource: 'task', resourceName: `${appName}/*` }),
        ],
      }),
    );
    const migrationProvider = new cr.Provider(this, 'MigrateProvider', {
      onEventHandler: onEvent,
      isCompleteHandler: isComplete,
      queryInterval: Duration.seconds(15),
      totalTimeout: Duration.minutes(30),
    });
    const migration = new CustomResource(this, 'Migration', {
      serviceToken: migrationProvider.serviceToken,
      resourceType: 'Custom::MotirMigration',
      properties: {
        Cluster: cluster.clusterArn,
        TaskDefinition: migrateTask.taskDefinitionArn,
        TaskDefinitionFamily: migrateFamily,
        ContainerName: migrateContainer.containerName,
        Subnets: vpc.selectSubnets(appSubnets).subnetIds,
        SecurityGroups: [migrateSg.securityGroupId],
        Release: props.imageTag,
      },
    });

    // ── Compute ─────────────────────────────────────────────────────────────
    const appUrl =
      mode === 'functions'
        ? this.functions(props, { vpc, appSg, appSubnets, repository, runtimeEnvironment }, [
            databaseSecret,
            environmentSecret,
          ])
        : this.containers(
            props,
            { vpc, appSg, appSubnets, cluster, containerImage, runtimeEnvironment },
            [databaseSecret, environmentSecret],
          );
    // The app is created or updated only after the migration step succeeded.
    appUrl.dependsOn.node.addDependency(migration);

    new CfnOutput(this, 'AppUrl', { value: appUrl.url, description: 'The upstream address' });
    new CfnOutput(this, 'Mode', { value: mode });
    new CfnOutput(this, 'MigrationTaskDefinitionArn', { value: migrateTask.taskDefinitionArn });
    new CfnOutput(this, 'MigrationClusterArn', { value: cluster.clusterArn });
    new CfnOutput(this, 'DatabaseSecretArn', { value: databaseSecret.secretArn });
    new CfnOutput(this, 'EnvironmentSecretArn', { value: environmentSecret.secretArn });
  }

  private functions(
    props: AppStackProps,
    shared: {
      vpc: ec2.IVpc;
      appSg: ec2.ISecurityGroup;
      appSubnets: ec2.SubnetSelection;
      repository: ecr.IRepository;
      runtimeEnvironment: Record<string, string>;
    },
    secrets: secretsmanager.ISecret[],
  ): { url: string; dependsOn: Construct } {
    const fn = new lambda.DockerImageFunction(this, 'App', {
      functionName: props.appName,
      code: lambda.DockerImageCode.fromEcr(shared.repository, { tagOrDigest: props.imageTag }),
      architecture: lambda.Architecture.X86_64,
      // 1,769 MB is one full vCPU (record §4, "Size / region").
      memorySize: 1769,
      timeout: Duration.seconds(30),
      vpc: shared.vpc,
      vpcSubnets: shared.appSubnets,
      securityGroups: [shared.appSg],
      environment: shared.runtimeEnvironment,
      logGroup: this.logGroup('AppLogs', `/motir/${props.appName}/app`),
    });
    for (const secret of secrets) secret.grantRead(fn);

    const live = new lambda.Alias(this, 'Live', { aliasName: 'live', version: fn.currentVersion });
    const url = live.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    });
    if (props.invokerArn) url.grantInvokeUrl(new iam.ArnPrincipal(props.invokerArn));
    return { url: url.url, dependsOn: fn };
  }

  private containers(
    props: AppStackProps,
    shared: {
      vpc: ec2.IVpc;
      appSg: ec2.ISecurityGroup;
      appSubnets: ec2.SubnetSelection;
      cluster: ecs.ICluster;
      containerImage: ecs.ContainerImage;
      runtimeEnvironment: Record<string, string>;
    },
    secrets: secretsmanager.ISecret[],
  ): { url: string; dependsOn: Construct } {
    const { manifest } = props;
    const task = new ecs.FargateTaskDefinition(this, 'AppTask', {
      family: props.appName,
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    task.addContainer('app', {
      image: shared.containerImage,
      command: manifest.startCommand.split(' '),
      environment: shared.runtimeEnvironment,
      portMappings: [{ containerPort: manifest.port }],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'app',
        logGroup: this.logGroup('AppLogs', `/motir/${props.appName}/app`),
      }),
    });
    for (const secret of secrets) secret.grantRead(task.taskRole);

    const service = new ecs.FargateService(this, 'App', {
      cluster: shared.cluster,
      serviceName: props.appName,
      taskDefinition: task,
      desiredCount: 1,
      vpcSubnets: shared.appSubnets,
      securityGroups: [shared.appSg],
      assignPublicIp: false,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { enable: true, rollback: true },
    });

    // The origin credential (record §4): motir-core derives it per app and the
    // adapter passes it at deploy time, so it is never written here.
    const originSecret = new CfnParameter(this, 'OriginSecret', {
      type: 'String',
      noEcho: true,
      minLength: 32,
      description: `The value every forwarder sends as ${ORIGIN_SECRET_HEADER}`,
    });

    const albSg = new ec2.SecurityGroup(this, 'LoadBalancerSecurityGroup', {
      vpc: shared.vpc,
      description: `${props.appName} load balancer`,
      allowAllOutbound: false,
    });
    albSg.addEgressRule(shared.appSg, ec2.Port.tcp(manifest.port), 'the app');
    shared.appSg.addIngressRule(albSg, ec2.Port.tcp(manifest.port), 'the load balancer');

    const alb = new elbv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
      vpc: shared.vpc,
      internetFacing: true,
      securityGroup: albSg,
      dropInvalidHeaderFields: true,
    });
    const listener = props.certificateArn
      ? alb.addListener('Https', {
          port: 443,
          certificates: [
            acm.Certificate.fromCertificateArn(this, 'Certificate', props.certificateArn),
          ],
          sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
          defaultAction: forbidden(),
        })
      : alb.addListener('Http', { port: 80, defaultAction: forbidden() });
    if (props.certificateArn) alb.addRedirect({ sourcePort: 80, targetPort: 443 });

    listener.addTargets('App', {
      priority: 1,
      conditions: [
        elbv2.ListenerCondition.httpHeader(ORIGIN_SECRET_HEADER, [originSecret.valueAsString]),
      ],
      port: manifest.port,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: {
        path: manifest.healthCheckPath,
        healthyHttpCodes: '200-299',
        interval: Duration.seconds(15),
      },
      deregistrationDelay: Duration.seconds(30),
    });

    const scheme = props.certificateArn ? 'https' : 'http';
    return { url: `${scheme}://${alb.loadBalancerDnsName}`, dependsOn: service };
  }

  private logGroup(id: string, name: string): logs.LogGroup {
    return new logs.LogGroup(this, id, {
      logGroupName: name,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }
}

function forbidden(): elbv2.ListenerAction {
  return elbv2.ListenerAction.fixedResponse(403, {
    contentType: 'text/plain',
    messageBody: 'Forbidden',
  });
}
