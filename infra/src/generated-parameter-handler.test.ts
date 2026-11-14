import {
  DeleteParameterCommand,
  ParameterNotFound,
  PutParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handler } from './generated-parameter-handler.ts';

const send = vi.spyOn(SSMClient.prototype, 'send');

const PROPERTIES = {
  ServiceToken: 'arn',
  Name: '/newses/dev/secret',
  Type: 'SecureString',
  Length: '40',
};

const event = (
  RequestType: 'Create' | 'Update' | 'Delete',
  PhysicalResourceId = '/newses/dev/secret',
) =>
  ({
    RequestType,
    PhysicalResourceId,
    ResourceProperties: PROPERTIES,
  }) as unknown as CloudFormationCustomResourceEvent;

const sent = () => send.mock.calls.map(([command]) => command);

afterEach(() => {
  send.mockReset();
});

describe('generated parameter handler', () => {
  it('writes a random value of the length asked for on create', async () => {
    send.mockResolvedValue({} as never);
    await expect(handler(event('Create'))).resolves.toEqual({
      PhysicalResourceId: '/newses/dev/secret',
    });
    await handler(event('Create'));
    const [first, second] = sent() as PutParameterCommand[];
    expect(first).toBeInstanceOf(PutParameterCommand);
    expect(first?.input).toMatchObject({
      Name: '/newses/dev/secret',
      Type: 'SecureString',
      Tier: 'Standard',
    });
    expect(first?.input.Value).toMatch(/^[A-Za-z0-9]{40}$/);
    expect(second?.input.Value).not.toBe(first?.input.Value);
  });

  it('never writes it again on update', async () => {
    await expect(handler(event('Update'))).resolves.toEqual({
      PhysicalResourceId: '/newses/dev/secret',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('deletes it with the resource, even when it is already gone', async () => {
    send.mockResolvedValueOnce({} as never);
    await handler(event('Delete'));
    expect(sent()[0]).toBeInstanceOf(DeleteParameterCommand);
    expect((sent()[0] as DeleteParameterCommand).input).toEqual({ Name: '/newses/dev/secret' });

    send.mockRejectedValueOnce(new ParameterNotFound({ message: 'gone', $metadata: {} }));
    await expect(handler(event('Delete'))).resolves.toEqual({
      PhysicalResourceId: '/newses/dev/secret',
    });
    send.mockRejectedValueOnce(new Error('AccessDenied'));
    await expect(handler(event('Delete'))).rejects.toThrow('AccessDenied');
  });
});
