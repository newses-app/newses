import { describeArchiveReader } from './archive-reader-contract.ts';
import { MemoryArchive } from './fakes.ts';

// The fake reads the archive as the real readers do.
describeArchiveReader('MemoryArchive', () => {
  const archive = new MemoryArchive();
  return { reader: archive, writer: archive };
});
