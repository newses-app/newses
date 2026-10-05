import { Duration, RemovalPolicy, SecretValue, Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { resourceName, type StageConfig } from './config.ts';
import type { GeneratedParameter } from './generated-parameter.ts';

/**
 * Aurora Serverless v2 PostgreSQL that pauses at 0 ACU when idle, and the blob bucket.
 * Lambdas run outside any VPC (no NAT), so the cluster is public and accepts TLS only.
 */
export class DataStack extends Stack {
  readonly cluster: rds.DatabaseCluster;
  readonly blobs: s3.Bucket;

  // Named rather than looked up, so synthesis needs no AWS credentials.
  override get availabilityZones(): string[] {
    return [`${this.region}a`, `${this.region}b`];
  }

  constructor(
    scope: Construct,
    id: string,
    props: StackProps & { stage: StageConfig; dbPassword: GeneratedParameter },
  ) {
    super(scope, id, props);
    const { stage } = props;
    const removalPolicy = stage.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    const vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: resourceName(stage),
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC }],
    });
    const securityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
      vpc,
      securityGroupName: resourceName(stage, 'db'),
      description: 'PostgreSQL over TLS from Lambdas, which run outside the VPC',
    });
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(5432));

    const engine = rds.DatabaseClusterEngine.auroraPostgres({
      version: rds.AuroraPostgresEngineVersion.VER_18_4,
    });
    this.cluster = new rds.DatabaseCluster(this, 'Db', {
      engine,
      clusterIdentifier: resourceName(stage),
      writer: rds.ClusterInstance.serverlessV2('writer', {
        instanceIdentifier: resourceName(stage, 'writer'),
        publiclyAccessible: true,
      }),
      serverlessV2MinCapacity: 0,
      serverlessV2MaxCapacity: 2,
      serverlessV2AutoPauseDuration: Duration.minutes(5),
      vpc,
      subnetGroup: new rds.SubnetGroup(this, 'DbSubnets', {
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        subnetGroupName: resourceName(stage, 'db'),
        description: `${resourceName(stage)} database`,
        removalPolicy,
      }),
      securityGroups: [securityGroup],
      credentials: rds.Credentials.fromPassword(
        'rss_reader',
        SecretValue.ssmSecure(props.dbPassword.parameterName),
      ),
      defaultDatabaseName: 'rss_reader',
      parameterGroup: new rds.ParameterGroup(this, 'DbParameters', {
        engine,
        name: resourceName(stage, 'db'),
        description: `${resourceName(stage)} database: TLS required`,
        parameters: { 'rds.force_ssl': '1' },
      }),
      storageEncrypted: true,
      backup: { retention: Duration.days(stage.backupDays) },
      deletionProtection: stage.retainData,
      removalPolicy: stage.retainData ? RemovalPolicy.SNAPSHOT : RemovalPolicy.DESTROY,
    });

    this.blobs = new s3.Bucket(this, 'Blobs', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: !stage.retainData,
    });
  }
}
