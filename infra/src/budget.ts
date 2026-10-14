import { Aspects, Stack, type StackProps, Stage, type StageProps, Tags } from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';
import { ACCOUNT, PROJECT, REGION } from './deploy-config.ts';
import { ManagedLogGroups } from './managed-log-groups.ts';

/** Services that only build and deploy the project, which the budget leaves out. */
export const BUILD_SERVICES = ['CodeBuild', 'AWS CodePipeline'];

/**
 * Monthly cost budget over running the project: everything tagged with it, both stages, except the
 * build pipelines' CodeBuild and CodePipeline charges. It notifies its own topic as actual spend
 * nears the limit or the forecast passes it. Untaggable charges, such as X-Ray traces and tax,
 * fall outside it. Budgets filter on cost-allocation tags, which count only once activated; only the
 * paying account (an organization's management account) can activate one, so `project` is
 * activated there by hand.
 */
export class BudgetStack extends Stack {
  /** Budget notifications; subscribe an email address to receive them. */
  readonly alerts: sns.Topic;

  constructor(scope: Construct, id: string, props: StackProps & { limitUsd: number }) {
    super(scope, id, props);

    this.alerts = new sns.Topic(this, 'Alerts', { topicName: `${PROJECT}-budget` });
    const { policyDependable } = this.alerts.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['sns:Publish'],
        principals: [new iam.ServicePrincipal('budgets.amazonaws.com')],
        resources: [this.alerts.topicArn],
      }),
    );
    const notify = (notificationType: 'ACTUAL' | 'FORECASTED', threshold: number) => ({
      notification: {
        notificationType,
        comparisonOperator: 'GREATER_THAN',
        threshold,
        thresholdType: 'PERCENTAGE',
      },
      subscribers: [{ subscriptionType: 'SNS', address: this.alerts.topicArn }],
    });
    const budget = new budgets.CfnBudget(this, 'Budget', {
      budget: {
        budgetName: PROJECT,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: props.limitUsd, unit: 'USD' },
        filterExpression: {
          and: [
            { tags: { key: 'project', values: [PROJECT], matchOptions: ['EQUALS'] } },
            // Service names as Cost Explorer reports them.
            { not: { dimensions: { key: 'SERVICE', values: BUILD_SERVICES } } },
          ],
        },
      },
      notificationsWithSubscribers: [
        notify('ACTUAL', 80),
        notify('ACTUAL', 100),
        notify('FORECASTED', 100),
      ],
    });
    // Budgets checks that it may publish when the budget is created.
    if (policyDependable) budget.node.addDependency(policyDependable);
  }
}

/**
 * The project budget, outside any stage: both pipelines deploy it, so it exists after either
 * stage's first deployment and survives either stage's removal.
 */
export class BudgetStage extends Stage {
  readonly budget: BudgetStack;

  constructor(scope: Construct, id: string, props: StageProps & { limitUsd: number }) {
    super(scope, id, props);
    Tags.of(this).add('project', PROJECT);
    Aspects.of(this).add(new ManagedLogGroups());
    this.budget = new BudgetStack(this, 'Budget', {
      env: { account: ACCOUNT, region: REGION },
      stackName: `${PROJECT}-budget`,
      limitUsd: props.limitUsd,
    });
  }
}
