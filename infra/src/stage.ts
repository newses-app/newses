import { Aspects, Stage, type StageProps, Tags } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { AppStack } from './app-stack.ts';
import { ACCOUNT, PROJECT, REGION, resourceName, type StageConfig } from './config.ts';
import { DataStack } from './data-stack.ts';
import { EdgeStack } from './edge-stack.ts';
import { ManagedLogGroups } from './managed-log-groups.ts';
import { ParamsStack } from './params-stack.ts';
import { ReleaseStack } from './release-stack.ts';

export interface RssReaderStageProps extends StageProps {
  stage: StageConfig;
  /** Built web app; defaults to `web/dist`. */
  webDir?: string;
}

/**
 * One deployment of the reader: credentials, data, Lambdas, CloudFront on the stage's domain,
 * and the pipeline that releases the apps to it.
 */
export class RssReaderStage extends Stage {
  readonly params: ParamsStack;
  readonly data: DataStack;
  readonly app: AppStack;
  readonly edge: EdgeStack;
  readonly release: ReleaseStack;

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
    });
    this.app = new AppStack(this, 'App', {
      env,
      stackName: resourceName(stage, 'app'),
      stage,
      params: this.params,
      blobs: this.data.blobs,
      archive: this.data.archive,
    });
    // Migrate reads the generated passwords; their names are literals, so no reference orders it.
    this.app.addStackDependency(this.params);
    this.edge = new EdgeStack(this, 'Edge', {
      env,
      stackName: resourceName(stage, 'edge'),
      stage,
      api: this.app.api,
      originHeader: this.params.originHeader,
      ...(props.webDir !== undefined && { webDir: props.webDir }),
    });
    // Publishes into the Edge stack's downloads bucket, which it names rather than references.
    this.release = new ReleaseStack(this, 'Release', {
      env,
      stackName: resourceName(stage, 'release'),
      stage,
    });
    this.release.addStackDependency(this.edge);
  }
}
