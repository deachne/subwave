// Crash-durable file primitives for evidence that must survive a controller
// restart. Unlike util/atomic-file.ts, these helpers fsync file contents and
// the containing directory before resolving.

import { randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { basename, dirname } from 'node:path';

function assertSingleLinkRegularFile(
  target: Stats,
  path: string,
  operation: string,
): void {
  if (!target.isFile() || target.nlink !== 1) {
    throw new Error(
      `durable ${operation} target must be a one-link regular file: ${path}`,
    );
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    if (!(await handle.stat()).isDirectory()) {
      throw new Error(`durable directory path is not a directory: ${path}`);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function repairOwnedExclusivePublish(
  path: string,
  handle: FileHandle,
  target: Stats,
): Promise<Stats> {
  if (!target.isFile() || target.nlink !== 2) return target;
  const prefix = `${basename(path)}.`;
  const temporary = (await readdir(dirname(path))).filter((name) =>
    name.startsWith(prefix)
    && /^\d+\.[a-f0-9]{12}\.tmp$/.test(name.slice(prefix.length)));
  for (const name of temporary) {
    const candidatePath = `${dirname(path)}/${name}`;
    const candidate = await lstat(candidatePath);
    if (
      candidate.isFile()
      && candidate.dev === target.dev
      && candidate.ino === target.ino
    ) {
      await unlink(candidatePath);
      await syncDirectory(dirname(path));
      return handle.stat();
    }
  }
  return target;
}

export async function withDurableRegularFile<T>(
  path: string,
  fn: (handle: FileHandle, target: Stats) => Promise<T>,
  { repairExclusivePublication = false }: { repairExclusivePublication?: boolean } = {},
): Promise<T> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    let target = await handle.stat();
    if (repairExclusivePublication) {
      target = await repairOwnedExclusivePublish(path, handle, target);
    }
    assertSingleLinkRegularFile(target, path, 'read');
    return await fn(handle, target);
  } finally {
    await handle.close();
  }
}

export async function assertDurableDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    if (!(await handle.stat()).isDirectory()) {
      throw new Error(`durable directory path is not a directory: ${path}`);
    }
  } finally {
    await handle.close();
  }
}

export async function ensureDurableDirectory(path: string): Promise<void> {
  const missing: string[] = [];
  let cursor = path;
  for (;;) {
    try {
      if (!(await lstat(cursor)).isDirectory()) {
        throw new Error(`durable directory path is not a directory: ${cursor}`);
      }
      break;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      missing.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) throw err;
      cursor = parent;
    }
  }
  for (const directory of missing.reverse()) {
    try {
      await mkdir(directory);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (!(await lstat(directory)).isDirectory()) throw err;
    }
    // Persist each newly-created directory entry in its parent before using it.
    await syncDirectory(dirname(directory));
  }
  await syncDirectory(path);
}

export async function appendDurableFile(
  path: string,
  contents: string | Buffer,
): Promise<void> {
  await ensureDurableDirectory(dirname(path));
  const handle = await open(
    path,
    constants.O_APPEND
      | constants.O_CREAT
      | constants.O_RDWR
      | constants.O_NOFOLLOW
      | constants.O_NONBLOCK,
    0o666,
  );
  try {
    const target = await handle.stat();
    assertSingleLinkRegularFile(target, path, 'append');
    const originalSize = target.size;
    // One write call per JSONL record keeps concurrent append-mode handles from
    // interleaving fragments. Callers still serialize writes to preserve order.
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } catch (writeError) {
      try {
        await handle.truncate(originalSize);
        await handle.sync();
      } catch (rollbackError) {
        throw new AggregateError(
          [writeError, rollbackError],
          'durable append failed and its partial record could not be rolled back',
        );
      }
      throw writeError;
    }
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

export async function readDurableRegularFile(path: string): Promise<Buffer> {
  return withDurableRegularFile(
    path,
    (handle) => handle.readFile(),
    { repairExclusivePublication: true },
  );
}

export async function probeDurableAppendFile(path: string): Promise<void> {
  const dir = dirname(path);
  await ensureDurableDirectory(dir);
  const handle = await open(
    path,
    constants.O_APPEND
      | constants.O_CREAT
      | constants.O_WRONLY
      | constants.O_NOFOLLOW
      | constants.O_NONBLOCK,
    0o666,
  );
  try {
    assertSingleLinkRegularFile(await handle.stat(), path, 'append probe');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dir);
}

export async function writeDurableFileAtomic(
  path: string,
  contents: string | Buffer,
  { mode }: { mode?: number } = {},
): Promise<void> {
  const dir = dirname(path);
  await ensureDurableDirectory(dir);
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let published = false;
  try {
    const handle = await open(
      tmp,
      constants.O_CREAT
        | constants.O_EXCL
        | constants.O_WRONLY
        | constants.O_NOFOLLOW
        | constants.O_NONBLOCK,
      mode,
    );
    try {
      assertSingleLinkRegularFile(await handle.stat(), tmp, 'atomic write');
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
    published = true;
    await syncDirectory(dir);
  } finally {
    if (!published) await unlink(tmp).catch(() => undefined);
  }
}

export async function writeDurableFileExclusive(
  path: string,
  contents: string | Buffer,
): Promise<void> {
  const dir = dirname(path);
  await ensureDurableDirectory(dir);
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let linked = false;
  try {
    const handle = await open(
      tmp,
      constants.O_CREAT
        | constants.O_EXCL
        | constants.O_WRONLY
        | constants.O_NOFOLLOW
        | constants.O_NONBLOCK,
    );
    try {
      assertSingleLinkRegularFile(await handle.stat(), tmp, 'exclusive write');
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // link() publishes without replacement: an existing event can never be
    // silently overwritten by a colliding event ID.
    await link(tmp, path);
    linked = true;
    await syncDirectory(dir);
  } finally {
    await unlink(tmp).catch(() => undefined);
    if (linked) await syncDirectory(dir);
  }
}

export async function copyDurableFileAtomic(
  source: string,
  destination: string,
): Promise<void> {
  const dir = dirname(destination);
  await ensureDurableDirectory(dir);
  const tmp = `${destination}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let published = false;
  try {
    await withDurableRegularFile(source, async (sourceHandle, sourceStat) => {
      const sourceMode = sourceStat.mode & 0o777;
      const handle = await open(
        tmp,
        constants.O_CREAT
          | constants.O_EXCL
          | constants.O_WRONLY
          | constants.O_NOFOLLOW
          | constants.O_NONBLOCK,
        sourceMode | 0o200,
      );
      try {
        assertSingleLinkRegularFile(await handle.stat(), tmp, 'copy');
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let position = 0;
        for (;;) {
          const { bytesRead } = await sourceHandle.read(
            buffer,
            0,
            buffer.length,
            position,
          );
          if (bytesRead === 0) break;
          let written = 0;
          while (written < bytesRead) {
            const result = await handle.write(
              buffer,
              written,
              bytesRead - written,
              position + written,
            );
            written += result.bytesWritten;
          }
          position += bytesRead;
        }
        const after = await sourceHandle.stat();
        if (
          after.size !== sourceStat.size
          || after.mtimeMs !== sourceStat.mtimeMs
          || after.ctimeMs !== sourceStat.ctimeMs
        ) {
          throw new Error(`durable copy source changed while reading: ${source}`);
        }
        await handle.chmod(sourceMode);
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    await rename(tmp, destination);
    published = true;
    await syncDirectory(dir);
  } finally {
    if (!published) await unlink(tmp).catch(() => undefined);
  }
}

export async function removeDurableFile(path: string): Promise<void> {
  await unlink(path);
  await syncDirectory(dirname(path));
}

export async function truncateDurableFile(
  path: string,
  size: number,
): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    assertSingleLinkRegularFile(await handle.stat(), path, 'truncate');
    await handle.truncate(size);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

export async function probeDurableDirectory(path: string): Promise<void> {
  await ensureDurableDirectory(path);
  const probe = `${path}/.durability-probe-${process.pid}-${randomBytes(6).toString('hex')}`;
  await writeDurableFileAtomic(probe, 'ok\n');
  await removeDurableFile(probe);
}

export async function probeDurableExclusiveFile(path: string): Promise<void> {
  await ensureDurableDirectory(path);
  const probe = `${path}/.exclusive-probe-${process.pid}-${randomBytes(6).toString('hex')}`;
  await writeDurableFileExclusive(probe, 'ok\n');
  await removeDurableFile(probe);
}

export async function makeDurableFileReadOnly(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const target = await handle.stat();
    assertSingleLinkRegularFile(target, path, 'read-only');
    await handle.chmod(target.mode & ~0o222);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

export async function makeDurableDirectoryReadOnly(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const target = await handle.stat();
    if (!target.isDirectory()) {
      throw new Error(`durable read-only target is not a directory: ${path}`);
    }
    await handle.chmod(target.mode & ~0o222);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

export async function makeDurableDirectoryWritable(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const target = await handle.stat();
    if (!target.isDirectory()) {
      throw new Error(`durable writable target is not a directory: ${path}`);
    }
    await handle.chmod(target.mode | 0o700);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

export async function syncDurableDirectory(path: string): Promise<void> {
  await syncDirectory(path);
}
