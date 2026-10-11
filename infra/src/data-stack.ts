import {
  ARCHIVE_COLUMNS,
  ARCHIVE_PARTITION,
  ARCHIVE_PREFIX,
  type ArchiveFieldType,
  ENCLOSURE_FIELDS,
  ENCLOSURES_COLUMN,
} from '@rss-reader/server';
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  SecretValue,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { resourceName, type StageConfig } from './config.ts';
import type { GeneratedParameter } from './generated-parameter.ts';

const HIVE_TYPES: Record<ArchiveFieldType, string> = {
  int: 'int',
  bigint: 'bigint',
  string: 'string',
  timestamp: 'timestamp',
};

/**
 * Aurora Serverless v2 PostgreSQL that pauses at 0 ACU when idle, the blob bucket, and the
 * catalog Athena reads the archive in the bucket through.
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
      lifecycleRules: [
        {
          id: 'archive-intelligent-tiering',
          prefix: `${ARCHIVE_PREFIX}/`,
          transitions: [
            {
              storageClass: s3.StorageClass.INTELLIGENT_TIERING,
              transitionAfter: Duration.days(0),
            },
          ],
        },
      ],
    });
    // The TTRSS import script writes the archive here from the operator's machine.
    new CfnOutput(this, 'BlobBucket', { value: this.blobs.bucketName });

    const database = new glue.CfnDatabase(this, 'ArchiveDatabase', {
      catalogId: this.account,
      databaseInput: { name: resourceName(stage).replaceAll('-', '_') },
    });
    const location = `s3://${this.blobs.bucketName}/${ARCHIVE_PREFIX}/`;
    const enclosure = ENCLOSURE_FIELDS.map((f) => `${f.name}:${HIVE_TYPES[f.type]}`).join(',');
    new glue.CfnTable(this, 'ArchiveTable', {
      catalogId: this.account,
      databaseName: database.ref,
      tableInput: {
        name: 'archive_entries',
        tableType: 'EXTERNAL_TABLE',
        partitionKeys: [{ name: ARCHIVE_PARTITION, type: 'string' }],
        // Partitions are projected from their `month=YYYY-MM` folders rather than registered.
        parameters: {
          classification: 'parquet',
          'projection.enabled': 'true',
          [`projection.${ARCHIVE_PARTITION}.type`]: 'date',
          [`projection.${ARCHIVE_PARTITION}.format`]: 'yyyy-MM',
          [`projection.${ARCHIVE_PARTITION}.range`]: '2000-01,NOW',
          [`projection.${ARCHIVE_PARTITION}.interval`]: '1',
          [`projection.${ARCHIVE_PARTITION}.interval.unit`]: 'MONTHS',
          'storage.location.template': `${location}${ARCHIVE_PARTITION}=\${${ARCHIVE_PARTITION}}/`,
        },
        storageDescriptor: {
          location,
          inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
          serdeInfo: {
            serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe',
          },
          columns: [
            ...ARCHIVE_COLUMNS.map((c) => ({ name: c.name, type: HIVE_TYPES[c.type] })),
            { name: ENCLOSURES_COLUMN, type: `array<struct<${enclosure}>>` },
          ],
        },
      },
    });
  }
}
