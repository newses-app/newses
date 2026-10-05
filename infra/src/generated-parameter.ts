import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CustomResource, Duration, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { REPO_ROOT } from './config.ts';

export interface GeneratedParameterProps {
  parameterName: string;
  /** CloudFront headers can only resolve `String` parameters. */
  type: 'String' | 'SecureString';
  length: number;
}

/**
 * A Standard SSM parameter holding a random alphanumeric value, generated once at creation.
 * CloudFormation can neither generate values nor create SecureString parameters.
 */
export class GeneratedParameter extends Construct {
  readonly parameterName: string;
  readonly parameterArn: string;

  constructor(scope: Construct, id: string, props: GeneratedParameterProps) {
    super(scope, id);
    this.parameterName = props.parameterName;
    const stack = Stack.of(this);
    this.parameterArn = stack.formatArn({
      service: 'ssm',
      resource: 'parameter',
      resourceName: props.parameterName.replace(/^\//, ''),
    });

    const provider = GeneratedParameter.provider(stack);
    provider.onEventHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:PutParameter', 'ssm:DeleteParameter'],
        resources: [this.parameterArn],
      }),
    );
    new CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::GeneratedParameter',
      properties: { Name: props.parameterName, Type: props.type, Length: props.length },
    });
  }

  grantRead(grantee: iam.IGrantable): void {
    iam.Grant.addToPrincipal({
      grantee,
      actions: ['ssm:GetParameter'],
      resourceArns: [this.parameterArn],
    });
  }

  /** One provider per stack, shared by its parameters. */
  private static provider(stack: Stack): cr.Provider {
    const id = 'GeneratedParameterProvider';
    const existing = stack.node.tryFindChild(id);
    if (existing) return existing as cr.Provider;
    const onEventHandler = new nodejs.NodejsFunction(stack, `${id}Handler`, {
      entry: fileURLToPath(new URL('generated-parameter-handler.ts', import.meta.url)),
      projectRoot: REPO_ROOT,
      depsLockFilePath: join(REPO_ROOT, 'pnpm-lock.yaml'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.seconds(30),
      logGroup: new logs.LogGroup(stack, `${id}Logs`, {
        retention: logs.RetentionDays.ONE_MONTH,
      }),
      bundling: {
        format: nodejs.OutputFormat.ESM,
        target: 'node24',
        externalModules: ['@aws-sdk/*'],
      },
    });
    return new cr.Provider(stack, id, { onEventHandler });
  }
}
