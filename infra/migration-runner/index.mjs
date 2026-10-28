// The migration step's runner (MOTIR-9812): a CloudFormation custom resource,
// driven by CDK's provider framework, that runs the manifest's
// `database.migrateCommand` as a one-off Fargate task inside the VPC and does
// not report success until that task has STOPPED with exit code 0.
//
// The app (the Lambda function or the ECS service) depends on this resource, so
// CloudFormation updates it only after the migration finished. A failed
// migration fails the deploy before any traffic moves, and the stack rolls back.
//
// The resource's `Release` property is the image tag, so every new image runs
// the migration again; an unchanged image re-runs nothing.

import { DescribeTasksCommand, ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs';

const ecs = new ECSClient({});

/** Start the migration task. Deleting the resource runs nothing. */
export async function onEvent(event) {
  const props = event.ResourceProperties;
  if (event.RequestType === 'Delete') return { PhysicalResourceId: event.PhysicalResourceId };

  const out = await ecs.send(
    new RunTaskCommand({
      cluster: props.Cluster,
      taskDefinition: props.TaskDefinition,
      launchType: 'FARGATE',
      count: 1,
      startedBy: 'motir-migrate',
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: props.Subnets,
          securityGroups: props.SecurityGroups,
          assignPublicIp: 'DISABLED',
        },
      },
    }),
  );
  const taskArn = out.tasks?.[0]?.taskArn;
  if (!taskArn) {
    throw new Error(`The migration task did not start: ${JSON.stringify(out.failures ?? [])}`);
  }
  return { PhysicalResourceId: props.TaskDefinitionFamily, Data: { TaskArn: taskArn } };
}

/** Polled by the provider framework until the task has stopped. */
export async function isComplete(event) {
  if (event.RequestType === 'Delete') return { IsComplete: true };

  const props = event.ResourceProperties;
  const taskArn = event.Data?.TaskArn;
  const out = await ecs.send(
    new DescribeTasksCommand({ cluster: props.Cluster, tasks: [taskArn] }),
  );
  const task = out.tasks?.[0];
  if (!task) throw new Error(`The migration task ${taskArn} was not found`);
  if (task.lastStatus !== 'STOPPED') return { IsComplete: false };

  const container = task.containers?.find((c) => c.name === props.ContainerName);
  if (container?.exitCode === 0) return { IsComplete: true, Data: { TaskArn: taskArn } };
  throw new Error(
    `The migration task ${taskArn} failed (exit code ${container?.exitCode ?? 'none'}): ` +
      `${container?.reason ?? task.stoppedReason ?? 'no reason given'}`,
  );
}
