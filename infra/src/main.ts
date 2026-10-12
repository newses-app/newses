import { App } from 'aws-cdk-lib';
import { ACCOUNT, REGION, resourceName, STAGES } from './deploy-config.ts';
import { PipelineStack } from './pipeline-stack.ts';

const app = new App();
for (const stage of STAGES) {
  new PipelineStack(app, resourceName(stage, 'pipeline'), {
    env: { account: ACCOUNT, region: REGION },
    stage,
  });
}
app.synth();
