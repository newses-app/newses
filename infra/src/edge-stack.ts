import { join } from 'node:path';
import { WEB_CSP } from '@rss-reader/server/web-csp';
import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import type * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import { CERTIFICATE_ARN, HOSTED_ZONE, REPO_ROOT, type StageConfig } from './config.ts';

/** Paths served by the API; everything else is the static SPA. */
export const API_PATHS = ['/api/*', '/reader/*', '/accounts/*', '/public/*'];

/** Extensionless paths are client-side routes, so S3 serves index.html for them. */
const SPA_ROUTES = `function handler(event) {
  var request = event.request;
  if (!/\\.[A-Za-z0-9]+$/.test(request.uri)) request.uri = '/index.html';
  return request;
}`;

export interface EdgeStackProps extends StackProps {
  stage: StageConfig;
  api: apigw.HttpApi;
  originSecret: secrets.Secret;
  /** Built web app (`web/dist`). */
  webDir?: string;
}

/** CloudFront serving the SPA from S3 and the API paths from the HTTP API, on the stage's domain. */
export class EdgeStack extends Stack {
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);
    const { stage } = props;

    const site = new s3.Bucket(this, 'Site', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const headers = new cloudfront.ResponseHeadersPolicy(this, 'SiteHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: WEB_CSP, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        // Feed images and links must not learn the reader's URLs.
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: false,
          override: true,
        },
      },
    });

    const apiOrigin = new origins.HttpOrigin(
      `${props.api.apiId}.execute-api.${this.region}.amazonaws.com`,
      {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        customHeaders: { 'x-origin-verify': props.originSecret.secretValue.unsafeUnwrap() },
      },
    );
    const apiBehavior: cloudfront.BehaviorOptions = {
      origin: apiOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    };

    this.distribution = new cloudfront.Distribution(this, 'Cdn', {
      domainNames: [stage.domainName],
      certificate: acm.Certificate.fromCertificateArn(this, 'Certificate', CERTIFICATE_ARN),
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(site),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
        functionAssociations: [
          {
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            function: new cloudfront.Function(this, 'SpaRoutes', {
              runtime: cloudfront.FunctionRuntime.JS_2_0,
              code: cloudfront.FunctionCode.fromInline(SPA_ROUTES),
            }),
          },
        ],
      },
      additionalBehaviors: Object.fromEntries(API_PATHS.map((path) => [path, apiBehavior])),
    });

    // Vite fingerprints assets/, so they are immutable; everything else is revalidated.
    // Old assets are kept for clients still running the previous build.
    const webDir = props.webDir ?? join(REPO_ROOT, 'web/dist');
    const assets = new s3deploy.BucketDeployment(this, 'DeployAssets', {
      sources: [s3deploy.Source.asset(webDir, { exclude: ['*', '!assets', '!assets/**'] })],
      destinationBucket: site,
      cacheControl: [s3deploy.CacheControl.fromString('public, max-age=31536000, immutable')],
      prune: false,
    });
    const shell = new s3deploy.BucketDeployment(this, 'DeployShell', {
      sources: [s3deploy.Source.asset(webDir, { exclude: ['assets', 'assets/**'] })],
      destinationBucket: site,
      cacheControl: [s3deploy.CacheControl.noCache()],
      prune: false,
      distribution: this.distribution,
      distributionPaths: ['/*'],
    });
    shell.node.addDependency(assets);

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', HOSTED_ZONE);
    const target = route53.RecordTarget.fromAlias(
      new route53Targets.CloudFrontTarget(this.distribution),
    );
    const recordName = stage.domainName.slice(0, -HOSTED_ZONE.zoneName.length - 1);
    new route53.ARecord(this, 'Alias', { zone, recordName, target });
    new route53.AaaaRecord(this, 'AliasV6', { zone, recordName, target });
  }
}
