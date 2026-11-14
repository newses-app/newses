import { describe, expect, it, vi } from 'vitest';
import {
  digestOf,
  joinImage,
  type PublishImage,
  type Run,
  signatureTag,
  tagImage,
  VERIFY_ATTEMPTS,
  VERIFY_DELAY_MS,
} from './image-registry.ts';

const REPOSITORY = 'public.ecr.aws/newses/newses';

/**
 * ECR Public, buildx, and cosign as the commands see them: tags pointing at manifests by digest.
 * `verifyFailures` makes that many verifications fail; `unlisted` tags are left out of listings,
 * as a registry that has not caught up would.
 */
class FakeRegistry {
  readonly tags = new Map<string, string>();
  readonly manifests = new Map<string, string>();
  readonly deleted: string[] = [];
  readonly signed: string[] = [];
  verifyFailures = 0;
  readonly unlisted = new Set<string>();
  refuseDeletes = false;

  /** Pushes an image leg by digest alone, as the image legs do. */
  leg(arch: string) {
    return this.#put(JSON.stringify({ schemaVersion: 2, arch }));
  }

  /** A published image: a multi-arch index of `legs` under `tags`, signed. */
  image(legs: string[], ...tags: string[]) {
    const digest = this.#put(JSON.stringify({ manifests: legs.map((digest) => ({ digest })) }));
    for (const tag of tags) this.tags.set(tag, digest);
    this.tags.set(signatureTag(digest), this.#put(`signature of ${digest}`));
    return digest;
  }

  #put(raw: string) {
    const digest = digestOf(raw);
    this.manifests.set(digest, raw);
    return digest;
  }

  #resolve(reference: string) {
    const at = reference.indexOf('@');
    const digest =
      at === -1 ? this.tags.get(reference.slice(REPOSITORY.length + 1)) : reference.slice(at + 1);
    if (!digest || !this.manifests.has(digest)) throw new Error(`No image ${reference}`);
    return digest;
  }

  readonly run: Run = (command, args) => {
    const line = [command, ...args].join(' ');
    if (line.startsWith('aws ecr-public --region us-east-1 --output json ')) {
      const [operation, , name, , ...ids] = args.slice(5);
      expect(name).toBe('newses');
      if (operation === 'describe-image-tags') {
        return JSON.stringify({
          imageTagDetails: [...this.tags]
            .filter(([tag]) => !this.unlisted.has(tag))
            .map(([imageTag, imageDigest]) => ({
              imageTag,
              imageDetail: { imageDigest },
            })),
        });
      }
      if (operation === 'batch-delete-image') return JSON.stringify(this.#delete(ids));
    }
    if (line.startsWith('docker buildx imagetools inspect --raw ')) {
      return this.manifests.get(this.#resolve(args.at(-1) ?? '')) ?? '';
    }
    if (line.startsWith('docker buildx imagetools create ')) return this.#create(args.slice(3));
    if (command === 'cosign' && args[0] === 'sign') {
      const digest = this.#resolve(args.at(-1) ?? '');
      this.signed.push(digest);
      this.tags.set(signatureTag(digest), this.#put(`signature of ${digest}`));
      return '';
    }
    if (command === 'cosign' && args[0] === 'verify') {
      const digest = this.#resolve(args.at(-1) ?? '');
      if (this.verifyFailures > 0 || !this.tags.has(signatureTag(digest))) {
        this.verifyFailures--;
        throw new Error(`${line} failed`);
      }
      return '';
    }
    throw new Error(`Unexpected command: ${line}`);
  };

  #create(args: string[]) {
    const dryRun = args[0] === '--dry-run';
    const tags: string[] = [];
    const sources: string[] = [];
    for (let i = dryRun ? 1 : 0; i < args.length; i++) {
      if (args[i] === '-t') tags.push(args[++i] ?? '');
      else sources.push(args[i] ?? '');
    }
    const [only] = sources;
    const raw =
      sources.length === 1 && only && this.manifests.get(this.#resolve(only))?.includes('manifests')
        ? (this.manifests.get(this.#resolve(only)) ?? '')
        : JSON.stringify({ manifests: sources.map((s) => ({ digest: this.#resolve(s) })) });
    if (dryRun) return `${raw}\n`;
    const digest = this.#put(raw);
    for (const tag of tags) this.tags.set(tag.slice(REPOSITORY.length + 1), digest);
    return '';
  }

  #delete(ids: string[]) {
    const failures: { failureCode: string; failureReason: string }[] = [];
    for (const id of ids) {
      const [kind, value = ''] = id.split('=');
      const found = kind === 'imageTag' ? this.tags.delete(value) : this.manifests.delete(value);
      if (found && this.refuseDeletes) {
        failures.push({
          failureCode: 'ImageReferencedByManifestList',
          failureReason: `${id} in use`,
        });
      } else if (found) this.deleted.push(id);
      else failures.push({ failureCode: 'ImageNotFound', failureReason: `${id} not found` });
    }
    return { imageIds: [], failures };
  }
}

function setup(version: string, prepare?: (registry: FakeRegistry) => void) {
  const registry = new FakeRegistry();
  prepare?.(registry);
  const legs = [registry.leg('amd64'), registry.leg('arm64')];
  const log: string[] = [];
  const wait = vi.fn(() => Promise.resolve());
  const options = (dryRun = false): PublishImage => ({
    run: registry.run,
    repository: REPOSITORY,
    version,
    key: 'awskms:///alias/newses-image-signing',
    legs,
    dryRun,
    log: (line) => void log.push(line),
    wait,
  });
  return { registry, legs, log, wait, options };
}

describe('joinImage', () => {
  it("joins the legs under the version's tag, signs the image once, and verifies it", async () => {
    const { registry, legs, options } = setup('1.2.0');
    const image = await joinImage(options());
    const digest = registry.tags.get('1.2.0') ?? '';
    expect(image).toBe(`${REPOSITORY}@${digest}`);
    expect(JSON.parse(registry.manifests.get(digest) ?? '')).toEqual({
      manifests: legs.map((leg) => ({ digest: leg })),
    });
    expect(registry.signed).toEqual([digest]);

    // A retried publish finds the image and its signature, and only verifies.
    await expect(joinImage(options())).resolves.toBe(image);
    expect(registry.signed).toEqual([digest]);
  });

  it('gives the reference a dry run would have, pushing and signing nothing', async () => {
    const dry = setup('1.2.0');
    const image = await joinImage(dry.options(true));
    expect(dry.registry.tags.has('1.2.0')).toBe(false);
    expect(dry.registry.signed).toEqual([]);
    expect(dry.log).toEqual([
      `Dry run: would join ${REPOSITORY}:1.2.0@${image.split('@')[1] ?? ''}`,
      `Dry run: would sign ${image}`,
    ]);
    await expect(joinImage(setup('1.2.0').options())).resolves.toBe(image);
  });

  it('refuses a version tag that holds other images', async () => {
    const { options } = setup('1.2.0', (registry) => {
      registry.image([registry.leg('old')], '1.2.0');
    });
    await expect(joinImage(options())).rejects.toThrow(/already holds other images/);
  });

  it('refuses a join the version tag did not land on', async () => {
    const { options } = setup('1.2.0', (registry) => {
      registry.unlisted.add('1.2.0');
    });
    await expect(joinImage(options())).rejects.toThrow(/is not on sha256:/);
  });

  it('verifies again while the registry does not show the signature yet, then gives up', async () => {
    const slow = setup('1.2.0', (registry) => {
      registry.verifyFailures = 2;
    });
    await joinImage(slow.options());
    expect(slow.wait.mock.calls).toEqual([[VERIFY_DELAY_MS], [VERIFY_DELAY_MS]]);

    const broken = setup('1.2.0', (registry) => {
      registry.verifyFailures = VERIFY_ATTEMPTS;
    });
    await expect(joinImage(broken.options())).rejects.toThrow(/cosign verify/);
    expect(broken.wait).toHaveBeenCalledTimes(VERIFY_ATTEMPTS - 1);
  });
});

describe('tagImage', () => {
  it("moves a release's floating tags to its image", async () => {
    const { registry, log, options } = setup('1.2.0', (r) => {
      r.image([r.leg('older')], '1.1.0', '1.1', '1', 'latest');
    });
    const image = await joinImage(options());
    log.length = 0;
    tagImage(options());
    const digest = image.split('@')[1];
    for (const tag of ['1.2.0', '1.2', '1', 'latest']) expect(registry.tags.get(tag)).toBe(digest);
    expect(registry.tags.get('1.1')).not.toBe(digest);
    expect(log).toEqual([`Tagged ${image}: 1.2.0, 1.2, 1, latest`]);
    expect(registry.deleted).toEqual([]);
  });

  it('moves next to a prerelease and deletes the one it supersedes, keeping shared images', async () => {
    let previous = '';
    let shared = '';
    let own = '';
    const { registry, log, options } = setup('1.3.0-rc.2', (r) => {
      shared = r.leg('arm64');
      own = r.leg('amd64-rc1');
      previous = r.image([own, shared], '1.3.0-rc.1', 'next');
    });
    // The new image shares the arm64 leg with the prerelease it supersedes.
    const image = await joinImage({ ...options(), legs: [registry.leg('amd64'), shared] });
    tagImage({ ...options(), legs: [registry.leg('amd64'), shared] });
    expect(registry.tags.get('next')).toBe(image.split('@')[1]);
    expect(registry.deleted).toEqual([
      'imageTag=1.3.0-rc.1',
      `imageTag=${signatureTag(previous)}`,
      `imageDigest=${previous}`,
      `imageDigest=${own}`,
    ]);
    expect(registry.manifests.has(shared)).toBe(true);
    expect(log.at(-1)).toBe('Deleted 1.3.0-rc.1');
  });

  it('keeps a superseded image another tag still points at', async () => {
    let previous = '';
    const { registry, options } = setup('1.3.0-rc.2', (r) => {
      previous = r.image([r.leg('rc1')], '1.3.0-rc.1', '1.2.9');
    });
    await joinImage(options());
    tagImage(options());
    expect(registry.deleted).toEqual(['imageTag=1.3.0-rc.1']);
    expect(registry.manifests.has(previous)).toBe(true);
  });

  it('needs the image joined first', () => {
    const { options } = setup('1.2.0');
    expect(() => {
      tagImage(options());
    }).toThrow('public.ecr.aws/newses/newses:1.2.0 does not exist; join it first');
  });

  it("gives the plan on a dry run, deleting the legs' images, which nothing tags", () => {
    const { registry, legs, log, options } = setup('1.3.0-rc.2', (r) => {
      r.image([r.leg('rc1')], '1.3.0-rc.1');
    });
    tagImage(options(true));
    expect(log).toEqual([
      `Dry run: would tag ${REPOSITORY} with next`,
      'Dry run: would delete 1.3.0-rc.1',
      "Dry run: deleted the image legs' images",
    ]);
    expect(registry.deleted).toEqual(legs.map((leg) => `imageDigest=${leg}`));
    expect(registry.tags.has('1.3.0-rc.1')).toBe(true);
  });

  it('fails when a tag did not move, or a delete is refused', async () => {
    const stuck = setup('1.2.0');
    await joinImage(stuck.options());
    for (const tag of ['1.2', '1', 'latest']) stuck.registry.unlisted.add(tag);
    expect(() => {
      tagImage(stuck.options());
    }).toThrow(/^Not on sha256:\w+: 1\.2, 1, latest$/);

    const refused = setup('1.3.0-rc.2', (r) => {
      r.image([r.leg('rc1')], '1.3.0-rc.1');
    });
    await joinImage(refused.options());
    refused.registry.refuseDeletes = true;
    expect(() => {
      tagImage(refused.options());
    }).toThrow(/^Cannot delete: imageTag=1\.3\.0-rc\.1 in use/);
  });
});
