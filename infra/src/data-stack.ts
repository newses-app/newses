import {
  ARCHIVE_COLUMNS,
  ARCHIVE_PARTITION,
  ARCHIVE_PREFIX,
  ARCHIVE_TABLE,
  type ArchiveFieldType,
  ENCLOSURE_FIELDS,
  ENCLOSURES_COLUMN,
} from '@rss-reader/server';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { resourceName, type StageConfig } from './config.ts';

/** Athena writes query results under this prefix of the blob bucket. */
const ATHENA_RESULTS = 'athena-results';

const HIVE_TYPES: Record<ArchiveFieldType, string> = {
  int: 'int',
  bigint: 'bigint',
  string: 'string',
  timestamp: 'timestamp',
};

/** The blob bucket, and the catalog Athena reads the archive in the bucket through. */
export class DataStack extends Stack {
  readonly blobs: s3.Bucket;
  /** Where Athena reads the archive: the Glue database and the workgroup to query in. */
  readonly archive: { database: string; workgroup: string };

  constructor(scope: Construct, id: string, props: StackProps & { stage: StageConfig }) {
    super(scope, id, props);
    const { stage } = props;
    const removalPolicy = stage.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

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
        // Query results, and what an interrupted compaction left behind.
        { id: 'athena-results', prefix: `${ATHENA_RESULTS}/`, expiration: Duration.days(1) },
        { id: 'archive-staging', prefix: 'archive/staging/', expiration: Duration.days(1) },
      ],
    });
    // The TTRSS import script writes the archive here from the operator's machine.
    new CfnOutput(this, 'BlobBucket', { value: this.blobs.bucketName });

    this.archive = {
      database: resourceName(stage).replaceAll('-', '_'),
      workgroup: resourceName(stage),
    };
    const database = new glue.CfnDatabase(this, 'ArchiveDatabase', {
      catalogId: this.account,
      databaseInput: { name: this.archive.database },
    });
    const location = `s3://${this.blobs.bucketName}/${ARCHIVE_PREFIX}/`;
    const enclosure = ENCLOSURE_FIELDS.map((f) => `${f.name}:${HIVE_TYPES[f.type]}`).join(',');
    new glue.CfnTable(this, 'ArchiveTable', {
      catalogId: this.account,
      databaseName: database.ref,
      tableInput: {
        name: ARCHIVE_TABLE,
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
    new athena.CfnWorkGroup(this, 'ArchiveWorkGroup', {
      name: this.archive.workgroup,
      description: `${resourceName(stage)} archive queries`,
      recursiveDeleteOption: true,
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        // A runaway query stops here; the whole archive is far smaller.
        bytesScannedCutoffPerQuery: 10 * 1024 ** 3,
        resultConfiguration: { outputLocation: `s3://${this.blobs.bucketName}/${ATHENA_RESULTS}/` },
      },
    });
  }
}
