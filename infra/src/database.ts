import {
  Aspects,
  Duration,
  RemovalPolicy,
  SecretValue,
  Stack,
  type StackProps,
  Stage,
  type StageProps,
  Tags,
} from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import {
  ACCOUNT,
  DB_ENDPOINT_PARAMETER,
  DB_MASTER_PASSWORD_PARAMETER,
  DB_MASTER_USER,
  PROJECT,
  REGION,
} from './deploy-config.ts';
import { GeneratedParameter } from './generated-parameter.ts';
import { ManagedLogGroups } from './managed-log-groups.ts';

const NAME = `${PROJECT}-db`;

/**
 * The master password, in a stack of its own: CloudFormation resolves `ssm-secure` references
 * when it creates a change set, so the parameter must exist before `DatabaseStack` is prepared.
 */
export class DatabaseParamsStack extends Stack {
  readonly masterPassword: GeneratedParameter;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    this.masterPassword = new GeneratedParameter(this, 'MasterPassword', {
      parameterName: DB_MASTER_PASSWORD_PARAMETER,
      type: 'SecureString',
      length: 32,
    });
  }
}

/**
 * One small PostgreSQL instance holding every stage's database, each owned by the stage's own
 * role. Lambdas run outside any VPC (no NAT), so the instance is public and accepts TLS only.
 */
export class DatabaseStack extends Stack {
  readonly instance: rds.DatabaseInstance;

  // Named rather than looked up, so synthesis needs no AWS credentials.
  override get availabilityZones(): string[] {
    return [`${this.region}a`, `${this.region}b`];
  }

  constructor(
    scope: Construct,
    id: string,
    props: StackProps & { masterPassword: GeneratedParameter },
  ) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: NAME,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC }],
    });
    // Subnets are named after their construct path, which differs between the two pipelines.
    vpc.publicSubnets.forEach((subnet, i) => {
      Tags.of(subnet).add('Name', `${NAME}-public-${String(i + 1)}`);
    });
    const securityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
      vpc,
      securityGroupName: NAME,
      description: 'PostgreSQL over TLS from Lambdas, which run outside the VPC',
    });
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(5432));

    // The major version only, so minor upgrades in the maintenance window cause no drift.
    const engine = rds.DatabaseInstanceEngine.postgres({
      version: rds.PostgresEngineVersion.VER_18,
    });
    this.instance = new rds.DatabaseInstance(this, 'Db', {
      engine,
      instanceIdentifier: NAME,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE4_GRAVITON,
        ec2.InstanceSize.MICRO,
      ),
      multiAz: false,
      allocatedStorage: 20,
      maxAllocatedStorage: 50,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      vpc,
      subnetGroup: new rds.SubnetGroup(this, 'DbSubnets', {
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        subnetGroupName: NAME,
        description: `${NAME} database`,
        removalPolicy: RemovalPolicy.RETAIN,
      }),
      publiclyAccessible: true,
      securityGroups: [securityGroup],
      credentials: rds.Credentials.fromPassword(
        DB_MASTER_USER,
        SecretValue.ssmSecure(props.masterPassword.parameterName),
      ),
      parameterGroup: new rds.ParameterGroup(this, 'DbParameters', {
        engine,
        name: NAME,
        description: `${NAME}: TLS required`,
        parameters: { 'rds.force_ssl': '1' },
      }),
      backupRetention: Duration.days(14),
      enablePerformanceInsights: false,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.SNAPSHOT,
    });

    new ssm.StringParameter(this, 'Endpoint', {
      parameterName: DB_ENDPOINT_PARAMETER,
      description: `${NAME} address`,
      stringValue: this.instance.dbInstanceEndpointAddress,
    });
  }
}

/**
 * The shared database, outside any stage: both pipelines deploy it before their stage, so it
 * exists after either stage's first deployment and survives either stage's removal. A change
 * takes effect on `dev` and so reaches prod's data too.
 */
export class DatabaseStage extends Stage {
  readonly params: DatabaseParamsStack;
  readonly database: DatabaseStack;

  constructor(scope: Construct, id: string, props?: StageProps) {
    super(scope, id, props);
    const env = { account: ACCOUNT, region: REGION };
    Tags.of(this).add('project', PROJECT);
    Aspects.of(this).add(new ManagedLogGroups());
    this.params = new DatabaseParamsStack(this, 'Params', { env, stackName: `${NAME}-params` });
    this.database = new DatabaseStack(this, 'Database', {
      env,
      stackName: NAME,
      masterPassword: this.params.masterPassword,
    });
    // The parameter name is a literal, so the order is not implied by a reference.
    this.database.addStackDependency(this.params);
  }
}
