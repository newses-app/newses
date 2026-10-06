import { Aspects, Stage, type StageProps, Tags } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { AppStack } from './app-stack.ts';
import { ACCOUNT, PROJECT, REGION, resourceName, type StageConfig } from './config.ts';
import { DataStack } from './data-stack.ts';
import { EdgeStack } from './edge-stack.ts';
import { ManagedLogGroups } from './managed-log-groups.ts';
import { ParamsStack } from './params-stack.ts';

export interface RssReaderStageProps extends StageProps {
  stage: StageConfig;
  /** Built web app; defaults to `web/dist`. */
  webDir?: string;
}

/** One deployment of the reader: credentials, data, Lambdas, and CloudFront on the stage's domain. */
export class RssReaderStage extends Stage {
  readonly params: ParamsStack;
  readonly data: DataStack;
  readonly app: AppStack;
  readonly edge: EdgeStack;

  constructor(scope: Construct, id: string, props: RssReaderStageProps) {
    super(scope, id, props);
    const { stage } = props;
    const env = { account: ACCOUNT, region: REGION };
    Tags.of(this).add('project', PROJECT);
    Tags.of(this).add('stage', stage.name);
    Aspects.of(this).add(new ManagedLogGroups());

    this.params = new ParamsStack(this, 'Params', {
      env,
      stackName: resourceName(stage, 'params'),
      stage,
    });
    this.data = new DataStack(this, 'Data', {
      env,
      stackName: resourceName(stage, 'data'),
      stage,
      dbPassword: this.params.dbPassword,
    });
    // Parameter names are literals, so the order is not implied by a reference.
    this.data.addStackDependency(this.params);
    this.app = new AppStack(this, 'App', {
      env,
      stackName: resourceName(stage, 'app'),
      stage,
      cluster: this.data.cluster,
      params: this.params,
      blobs: this.data.blobs,
    });
    this.edge = new EdgeStack(this, 'Edge', {
      env,
      stackName: resourceName(stage, 'edge'),
      stage,
      api: this.app.api,
      originHeader: this.params.originHeader,
      ...(props.webDir !== undefined && { webDir: props.webDir }),
    });
  }
}
