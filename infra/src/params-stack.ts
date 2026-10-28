import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { StageConfig } from './config.ts';
import { PROJECT } from './deploy-config.ts';
import { GeneratedParameter } from './generated-parameter.ts';

/**
 * Generated credentials, in a stack of their own: CloudFormation resolves `ssm-secure`
 * references when a deployment starts, so the parameters must exist before `Data` deploys.
 */
export class ParamsStack extends Stack {
  readonly dbPassword: GeneratedParameter;
  readonly adminPassword: GeneratedParameter;
  readonly originHeader: GeneratedParameter;
  readonly appSecret: GeneratedParameter;

  constructor(scope: Construct, id: string, props: StackProps & { stage: StageConfig }) {
    super(scope, id, props);
    const path = `/${PROJECT}/${props.stage.name}`;

    this.dbPassword = new GeneratedParameter(this, 'DbPassword', {
      parameterName: `${path}/db-password`,
      type: 'SecureString',
      length: 32,
    });
    this.adminPassword = new GeneratedParameter(this, 'AdminPassword', {
      parameterName: `${path}/admin-password`,
      type: 'SecureString',
      length: 24,
    });
    this.appSecret = new GeneratedParameter(this, 'AppSecret', {
      parameterName: `${path}/app-secret`,
      type: 'SecureString',
      length: 64,
    });
    // A String parameter, because CloudFront headers cannot resolve SecureString parameters.
    this.originHeader = new GeneratedParameter(this, 'OriginHeader', {
      parameterName: `${path}/origin-header`,
      type: 'String',
      length: 40,
    });
  }
}
