import { App } from 'aws-cdk-lib';
import { ACCOUNT, REGION, STAGES } from './config.ts';
import { PipelineStack } from './pipeline-stack.ts';

const app = new App();
for (const stage of STAGES) {
  new PipelineStack(app, `RssReaderPipeline-${stage.name}`, {
    env: { account: ACCOUNT, region: REGION },
    stage,
  });
}
app.synth();
