import { spawn } from "node:child_process";

const DEFAULT_IDLE_EVICTION_MS = 2 * 60 * 1_000;
const EVICTION_TIMEOUT_MS = 15_000;

export const DEFAULT_CACHE_DIRECTORIES = [
  "/app/lean-project/.lake",
  "/opt/elan",
  "/usr/local/lib/node_modules/@openai/codex",
] as const;

// Perl core script (works with Debian's Essential perl-base package) that
// walks target directories in a single process and invokes Linux SYS_fadvise64
// (syscall 221 on x86_64) with POSIX_FADV_DONTNEED (4) on .olean/.ilean/binary
// files so the kernel releases clean page-cache pages from the container cgroup.
const PERL_FADVISE_DONTNEED_SCRIPT = [
  "sub drop {",
  "  my ($d) = @_;",
  "  opendir(my $dh, $d) or return;",
  "  while (defined(my $e = readdir($dh))) {",
  '    next if $e eq "." || $e eq "..";',
  '    my $p = "$d/$e";',
  "    next if -l $p;",
  "    if (-d _) { drop($p); }",
  '    elsif (-f _ && ($e =~ /\\.(?:olean|ilean|a|so)$/ || $e eq "lean" || $e eq "codex")) {',
  '      if (open(my $fh, "<", $p)) {',
  "        eval { syscall(221, fileno($fh), 0, 0, 4); };",
  "        close($fh);",
  "      }",
  "    }",
  "  }",
  "  closedir($dh);",
  "}",
  "drop($_) for @ARGV;",
].join(" ");

export type SubprocessKind = "lean" | "codex";

export interface RuntimeMemoryCoordinatorOptions {
  idleEvictionMs?: number;
  evictPageCache?: () => Promise<void>;
  collectGarbage?: () => void;
}

export function triggerGarbageCollection(): void {
  try {
    if (typeof globalThis.gc === "function") {
      globalThis.gc();
    }
  } catch {
    // Ignore if --expose-gc is not enabled.
  }
}

export async function evictLinuxPageCache(
  directories: readonly string[] = DEFAULT_CACHE_DIRECTORIES,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Promise<void> {
  if (platform !== "linux" || arch !== "x64" || directories.length === 0) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    const child = spawn("perl", ["-e", PERL_FADVISE_DONTNEED_SCRIPT, "--", ...directories], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
      finish();
    }, EVICTION_TIMEOUT_MS);
    timer.unref?.();

    child.once("error", finish);
    child.once("close", finish);
  });
}

export class RuntimeMemoryCoordinator {
  readonly #idleEvictionMs: number;
  readonly #evictPageCache: () => Promise<void>;
  readonly #collectGarbage: () => void;
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;
  #leanCacheWarm = false;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: RuntimeMemoryCoordinatorOptions = {}) {
    this.#idleEvictionMs = options.idleEvictionMs ?? DEFAULT_IDLE_EVICTION_MS;
    this.#evictPageCache = options.evictPageCache ?? (() => evictLinuxPageCache());
    this.#collectGarbage = options.collectGarbage ?? triggerGarbageCollection;
  }

  runExclusive<T>(kind: SubprocessKind, task: () => Promise<T>): Promise<T> {
    this.#clearIdleTimer();
    this.#pending += 1;

    const execution = this.#tail.then(async () => {
      this.#clearIdleTimer();
      if (kind === "codex" && this.#leanCacheWarm) {
        this.#leanCacheWarm = false;
        await this.#safeEvict();
      }
      this.#collectGarbage();

      try {
        return await task();
      } finally {
        if (kind === "lean") {
          this.#leanCacheWarm = true;
        }
        this.#collectGarbage();
      }
    });

    this.#tail = execution.then(
      () => undefined,
      () => undefined,
    );

    return execution.finally(() => {
      this.#pending -= 1;
      if (this.#pending === 0 && this.#leanCacheWarm && this.#idleEvictionMs > 0) {
        this.#scheduleIdleEviction();
      }
    });
  }

  dispose(): void {
    this.#clearIdleTimer();
  }

  #scheduleIdleEviction(): void {
    this.#clearIdleTimer();
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined;
      if (this.#pending > 0 || !this.#leanCacheWarm) return;
      this.#leanCacheWarm = false;
      void this.#safeEvict().finally(() => {
        this.#collectGarbage();
      });
    }, this.#idleEvictionMs);
    this.#idleTimer.unref?.();
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer !== undefined) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }
  }

  async #safeEvict(): Promise<void> {
    try {
      await this.#evictPageCache();
    } catch {
      // Cache eviction is best-effort and must never fail a proof job.
    }
  }
}
