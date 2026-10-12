import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as sns from 'aws-cdk-lib/aws-sns';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { PROJECT } from './config.ts';

/**
 * Monthly cost budget over everything tagged with the project, both stages and their pipelines,
 * notifying a topic as actual spend nears the limit or the forecast passes it. Untaggable charges,
 * such as X-Ray traces and tax, fall outside it.
 */
export class ProjectBudget extends Construct {
  constructor(scope: Construct, id: string, props: { limitUsd: number; topic: sns.Topic }) {
    super(scope, id);
    const { limitUsd, topic } = props;

    // Budgets filter on cost-allocation tags, which count only once activated.
    const activation = new cr.AwsCustomResource(this, 'ActivateTag', {
      onUpdate: {
        service: 'CostExplorer',
        action: 'UpdateCostAllocationTagsStatus',
        parameters: { CostAllocationTagsStatus: [{ TagKey: 'project', Status: 'Active' }] },
        // Cost Explorer has a single endpoint.
        region: 'us-east-1',
        physicalResourceId: cr.PhysicalResourceId.of('project-cost-allocation-tag'),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['ce:UpdateCostAllocationTagsStatus'],
          resources: ['*'],
        }),
      ]),
      installLatestAwsSdk: false,
    });

    const { policyDependable } = topic.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['sns:Publish'],
        principals: [new iam.ServicePrincipal('budgets.amazonaws.com')],
        resources: [topic.topicArn],
      }),
    );
    const notify = (notificationType: 'ACTUAL' | 'FORECASTED', threshold: number) => ({
      notification: {
        notificationType,
        comparisonOperator: 'GREATER_THAN',
        threshold,
        thresholdType: 'PERCENTAGE',
      },
      subscribers: [{ subscriptionType: 'SNS', address: topic.topicArn }],
    });
    const budget = new budgets.CfnBudget(this, 'Budget', {
      budget: {
        budgetName: PROJECT,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: limitUsd, unit: 'USD' },
        filterExpression: {
          tags: { key: 'project', values: [PROJECT], matchOptions: ['EQUALS'] },
        },
      },
      notificationsWithSubscribers: [
        notify('ACTUAL', 80),
        notify('ACTUAL', 100),
        notify('FORECASTED', 100),
      ],
    });
    budget.node.addDependency(activation);
    // Budgets checks that it may publish when the budget is created.
    if (policyDependable) budget.node.addDependency(policyDependable);
  }
}
