import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';/**
 * Atomic file write: temp file in the same directory (same volume) +
 * rename. Readers never observe a half-written file; crash leaves the old
 * version intact.
 */
export function writeAtomic(filePath: string, contents: string): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, contents, 'utf8');
  try {
    renameSync(tmp, filePath);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    throw err;
  }
}

export class LockBusyError extends Error {
  constructor(readonly lockPath: string, readonly holderPid: number) {
    super(`lock busy at ${lockPath} (held by pid ${holderPid})`);
    this.name = 'LockBusyError';
  }
}

const STALE_LOCK_MS = 30_000;

/**
 * Single-writer lockfile for arena state mutations (architecture decision:
 * concurrency solved by lockfile, not a DB). O_EXCL create is atomic on
 * all platforms; locks older than STALE_LOCK_MS are stolen (crashed holder).
 */
export class FileLock {
  private heldPath?: string;

  constructor(private readonly lockPath: string) {}

  get isHeld(): boolean {
    return this.heldPath !== undefined;
  }

  acquire(): void {
    if (!existsSync(path.dirname(this.lockPath))) {
      mkdirSync(path.dirname(this.lockPath), { recursive: true });
    }
    // Steal stale locks (crashed process never released).
    if (existsSync(this.lockPath)) {
      const ageMs = Date.now() - statSync(this.lockPath).mtimeMs;
      if (ageMs > STALE_LOCK_MS) {
        try {
          unlinkSync(this.lockPath);
        } catch {
          /* someone else stole it first */
        }
      }
    }
    let fd: number;
    try {
      fd = openSync(this.lockPath, 'wx');
    } catch {
      // O_EXCL collision -> someone holds it
      throw new LockBusyError(this.lockPath, this.holderPid() ?? -1);
    }
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }), 'utf8');
    } finally {
      closeSync(fd);
    }
    this.heldPath = this.lockPath;
  }

  /**
   * Blocking variant used by state-mutation paths: polls until the lock is
   * free (stale locks are stolen inside acquire). Bounded by `timeoutMs`.
   */
  async waitForAcquire(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!existsSync(this.lockPath)) {
        try {
          this.acquire();
          return;
        } catch (err) {
          if (!(err instanceof LockBusyError)) throw err;
        }
      }
      if (Date.now() > deadline) {
        throw new LockBusyError(this.lockPath, this.holderPid() ?? -1);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  release(): void {
    if (this.heldPath === undefined) return;
    try {
      unlinkSync(this.lockPath);
    } catch {
      /* already gone */
    }
    this.heldPath = undefined;
  }

  /** Reads the current holder's pid when busy. */
  holderPid(): number | undefined {
    if (!existsSync(this.lockPath)) return undefined;
    try {
      return (JSON.parse(readFileSync(this.lockPath, 'utf8')) as { pid?: number }).pid;
    } catch {
      return undefined;
    }
  }
}

/** Runs `fn` while holding the arena-wide mutation lock (waits its turn). */
export async function withArenaLock<T>(arenaRoot: string, fn: () => Promise<T>): Promise<T> {
  const lock = new FileLock(path.join(arenaRoot, 'arena.lock'));
  await lock.waitForAcquire();
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
