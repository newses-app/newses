import { CfnResource, type IAspect, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { IConstruct } from 'constructs';

/**
 * Gives every Lambda function that lacks one a log group owned by its stack. Functions CDK adds
 * internally (custom resource providers, bucket deployments) otherwise log to groups Lambda
 * creates on first run, which never expire and outlive every deployment.
 */
export class ManagedLogGroups implements IAspect {
  visit(node: IConstruct): void {
    if (!(node instanceof CfnResource) || node.cfnResourceType !== 'AWS::Lambda::Function') return;
    if (node instanceof lambda.CfnFunction) {
      const config = node.loggingConfig;
      if (config && ('logGroup' in config ? config.logGroup : true)) return;
    }
    const logGroup = new logs.LogGroup(Stack.of(node), `Logs${node.node.addr.slice(0, 12)}`, {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    node.addPropertyOverride('LoggingConfig.LogGroup', logGroup.logGroupName);
  }
}
