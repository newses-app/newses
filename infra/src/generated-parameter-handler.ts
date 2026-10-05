import { randomInt } from 'node:crypto';
import {
  DeleteParameterCommand,
  ParameterNotFound,
  PutParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const ssm = new SSMClient({});

interface Properties {
  ServiceToken: string;
  Name: string;
  Type: 'String' | 'SecureString';
  Length: string;
}

/** Writes a random value once on create and never regenerates it; deletes it with the resource. */
export async function handler(
  event: CloudFormationCustomResourceEvent,
): Promise<{ PhysicalResourceId: string }> {
  const { Name, Type, Length } = event.ResourceProperties as unknown as Properties;
  if (event.RequestType === 'Create') {
    const value = Array.from(
      { length: Number(Length) },
      () => ALPHABET[randomInt(ALPHABET.length)],
    );
    await ssm.send(
      new PutParameterCommand({ Name, Type, Value: value.join(''), Tier: 'Standard' }),
    );
    return { PhysicalResourceId: Name };
  }
  if (event.RequestType === 'Delete') {
    try {
      await ssm.send(new DeleteParameterCommand({ Name: event.PhysicalResourceId }));
    } catch (err) {
      if (!(err instanceof ParameterNotFound)) throw err;
    }
  }
  return { PhysicalResourceId: event.PhysicalResourceId };
}
