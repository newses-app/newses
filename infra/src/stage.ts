import { Stack, Stage, type StageProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import type { Construct } from 'constructs';
import { AppStack } from './app-stack.ts';
import { ACCOUNT, HOSTED_ZONE, REGION, type StageConfig } from './config.ts';
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

    // CloudFront only accepts certificates from us-east-1.
    const certStack = new Stack(this, 'Cert', {
      env: { account: ACCOUNT, region: 'us-east-1' },
      crossRegionReferences: true,
    });
    const certificate = new acm.Certificate(certStack, 'Certificate', {
      domainName: stage.domainName,
      validation: acm.CertificateValidation.fromDns(
        route53.HostedZone.fromHostedZoneAttributes(certStack, 'Zone', HOSTED_ZONE),
      ),
    });

    this.data = new DataStack(this, 'Data', { env, stage });
    this.app = new AppStack(this, 'App', {
      env,
      stage,
      cluster: this.data.cluster,
      blobs: this.data.blobs,
    });
    this.edge = new EdgeStack(this, 'Edge', {
      env,
      crossRegionReferences: true,
      stage,
      certificate,
      api: this.app.api,
      originSecret: this.app.originSecret,
      ...(props.webDir !== undefined && { webDir: props.webDir }),
    });
  }
}
