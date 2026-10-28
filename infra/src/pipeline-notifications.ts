import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import type * as sns from 'aws-cdk-lib/aws-sns';
import type { StageConfig } from './config.ts';
import { resourceName } from './deploy-config.ts';

/**
 * The stage's deploy and release pipelines report each run's result to this topic, which the
 * pipeline stack owns; subscribe an email address to receive them.
 */
export const pipelinesTopicName = (stage: StageConfig) => resourceName(stage, 'pipelines');

/** Sends `pipeline`'s succeeded and failed runs to `topic`. */
export function notifyResults(
  pipeline: codepipeline.IPipeline,
  topic: sns.ITopic,
  ruleName: string,
): void {
  const rule = pipeline.notifyOn('Results', topic, {
    notificationRuleName: ruleName,
    events: [
      codepipeline.PipelineNotificationEvents.PIPELINE_EXECUTION_SUCCEEDED,
      codepipeline.PipelineNotificationEvents.PIPELINE_EXECUTION_FAILED,
    ],
  });
  // CodeStar Notifications refuses a rule whose topic does not yet let it publish, and the rule
  // only references the topic, not the policy that the binding adds. An imported topic adds none.
  rule.node.addDependency(topic);
}
