import { Stage, type StageProps, Tags } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { AppStack } from './app-stack.ts';
import { ACCOUNT, PROJECT, REGION, resourceName, type StageConfig } from './config.ts';
import { DataStack } from './data-stack.ts';
import { EdgeStack } from './edge-stack.ts';

export interface RssReaderStageProps extends StageProps {
  stage: StageConfig;
  /** Built web app; defaults to `web/dist`. */
  webDir?: string;
}

/** One deployment of the reader: data, Lambdas, and CloudFront on the stage's domain. */
export class RssReaderStage extends Stage {
  readonly data: DataStack;
  readonly app: AppStack;
  readonly edge: EdgeStack;

  constructor(scope: Construct, id: string, props: RssReaderStageProps) {
    super(scope, id, props);
    const { stage } = props;
    const env = { account: ACCOUNT, region: REGION };
    Tags.of(this).add('project', PROJECT);
    Tags.of(this).add('stage', stage.name);

    this.data = new DataStack(this, 'Data', {
      env,
      stackName: resourceName(stage, 'data'),
      stage,
    });
    this.app = new AppStack(this, 'App', {
      env,
      stackName: resourceName(stage, 'app'),
      stage,
      cluster: this.data.cluster,
      dbPassword: this.data.dbPassword,
      blobs: this.data.blobs,
    });
    this.edge = new EdgeStack(this, 'Edge', {
      env,
      stackName: resourceName(stage, 'edge'),
      stage,
      api: this.app.api,
      originHeader: this.app.originHeader,
      ...(props.webDir !== undefined && { webDir: props.webDir }),
    });
  }
}
