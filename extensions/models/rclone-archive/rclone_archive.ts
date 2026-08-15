import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Canonical rclone runner — CONVENTIONS.md §5. Copied byte-identical.
// ---------------------------------------------------------------------------

/** Exit codes rclone uses. See CONVENTIONS.md §4.1. */
export const RCLONE_EXIT = {
  OK: 0,
  USAGE: 1,
  UNCATEGORISED: 2,
  DIR_NOT_FOUND: 3,
  FILE_NOT_FOUND: 4,
  TEMPORARY: 5,
  LESS_SERIOUS: 6,
  FATAL: 7,
  TRANSFER_LIMIT: 8,
  NO_TRANSFER: 9,
  DURATION_LIMIT: 10,
} as const;

/**
 * The storage class this suite exists to write.
 *
 * It is `DEEP_ARCHIVE`, NOT `GLACIER_DEEP_ARCHIVE`. The latter reads like the
 * obvious name, appears in plenty of prose, and is not a storage class S3
 * accepts: every PutObject carrying it fails with
 * `400 InvalidStorageClass`. This was the default here until a live run
 * against real hardware rejected all 37 objects.
 *
 * Defined once because it was previously repeated at five call sites, and a
 * constant that must agree with itself in five places is a bug waiting for
 * one of them to drift.
 */
export const DEFAULT_STORAGE_CLASS = "DEEP_ARCHIVE";

/**
 * Storage classes rclone accepts for the AWS provider.
 *
 * The check below validates membership in THIS set before asking whether the
 * class is an archive tier. Those are different failures and were previously
 * conflated: an invalid class fell through the "not an archive tier" branch,
 * so a typo was reported as a cost problem — or, as with
 * `GLACIER_DEEP_ARCHIVE`, sat in the allowlist and was reported as fine.
 */
export const S3_STORAGE_CLASSES = [
  "DEFAULT",
  "STANDARD",
  "REDUCED_REDUNDANCY",
  "STANDARD_IA",
  "ONEZONE_IA",
  "INTELLIGENT_TIERING",
  "GLACIER",
  "GLACIER_IR",
  "DEEP_ARCHIVE",
];

/** The subset of the above that is actually an archive tier. */
export const ARCHIVE_STORAGE_CLASSES = [
  "GLACIER",
  "GLACIER_IR",
  "DEEP_ARCHIVE",
];

/** Subcommands that remove data. This suite never deletes. */
const FORBIDDEN = new Set([
  "sync",
  "move",
  "moveto",
  "delete",
  "deletefile",
  "purge",
  "rmdir",
  "rmdirs",
  "cleanup",
]);

/** Credentials for the destination. Never logged, never serialised. */
export interface RcloneCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/** Where and how the binary runs. Contains no secrets. */
export interface RcloneTransport {
  /** SSH destination, e.g. "nas" or "sntxrr@nas". */
  sshHost: string;
  /** Path to docker on the remote host. DSM puts it in /usr/local/bin. */
  dockerBinary?: string;
  /** Pinned rclone image. Never `:latest` in a model definition. */
  image?: string;
  /** Absolute host path bind-mounted read-only at /data. */
  sourceMount: string;
  sshBinary?: string;
  timeoutMs?: number;
  /**
   * Override the container entrypoint. Packing needs a shell so tar can be
   * piped into `rclone rcat`; nothing else may use it.
   */
  entrypoint?: string;
}

/** Destination remote. `storageClass` is mandatory — see CONVENTIONS.md §4.2. */
export interface RcloneDestination {
  bucket: string;
  region: string;
  storageClass: string;
  provider?: string;
  endpoint?: string;
}

export interface RcloneResult {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

/**
 * POSIX single-quote escaping for one remote shell word.
 *
 * ssh does not preserve argv — it joins arguments and lets the remote login
 * shell re-split them. Wrapping in single quotes makes every character literal
 * except `'` itself, which is closed, escaped and reopened.
 *
 * This is not hypothetical: volume1 contains `/volume1/Resilio Sync` and
 * parenthesised filenames, either of which breaks an unquoted remote command.
 */
export function shQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * Sentinel standing in for the env-file path inside the docker argv.
 *
 * It is the single word that must NOT be shQuoted: it has to reach the remote
 * shell as a live `"$ENVF"` expansion. Quoting it would pass the literal text
 * `$ENVF` to docker, which would then fail to find that file and run rclone
 * with no credentials at all.
 *
 * NUL bytes cannot occur in a real argv word, so this can never collide with
 * a caller-supplied argument.
 */
export const ENV_FIFO_REF = "\u0000ENV_FIFO\u0000";

/**
 * Wrap the docker argv in the remote shell plumbing that delivers the env file.
 *
 * Credentials cannot be passed as `--env-file /dev/stdin`: DSM refuses to
 * *open* that path (EACCES) even though fd 0 is an ordinary pipe owned by the
 * SSH user, so docker exits 125 before rclone ever starts. Reading fd 0
 * directly still works — only opening the path is denied.
 *
 * So the remote shell creates a FIFO inside a private 0700 directory and
 * streams the env file through it. A FIFO has no on-disk contents — the bytes
 * live in a kernel buffer, readable only by this user — so the credential
 * still never lands on the NAS filesystem, and still never appears in argv on
 * either host.
 */
export function buildRemoteCommand(dockerWords: string[]): string {
  const refs = dockerWords.filter((w) => w === ENV_FIFO_REF).length;
  if (refs !== 1) {
    throw new Error(
      `refusing to run: the env-file sentinel must appear exactly once in ` +
        `the docker argv, found ${refs}`,
    );
  }

  const docker = dockerWords
    .map((w) => (w === ENV_FIFO_REF ? `"$ENVF"` : shQuote(w)))
    .join(" ");

  return [
    // Preserve the real stdin on fd 3. A backgrounded command in a POSIX shell
    // has its stdin redirected from /dev/null, so `cat` would otherwise deliver
    // an EMPTY env file — and rclone would run with no credentials while every
    // exit code still looked normal.
    "exec 3<&0",
    // An explicit template rather than a bare `mktemp -d`: BSD mktemp requires
    // one, and keeping this portable means the shell logic below can be
    // executed for real in the test suite instead of only asserted as text.
    'D=$(mktemp -d "${TMPDIR:-/tmp}/rclone.XXXXXX") || exit 125',
    `trap 'rm -rf "$D"' EXIT INT TERM`,
    'ENVF="$D/env"',
    'mkfifo -m 600 "$ENVF" || exit 125',
    'cat <&3 > "$ENVF" & CATPID=$!',
    `${docker}; rc=$?`,
    // Never `wait` on the writer. If docker died before opening the FIFO — a
    // bad flag, a missing image — `cat` is still blocked in open() and waiting
    // would hang the run until the six-hour timeout.
    'kill "$CATPID" 2>/dev/null',
    "exit $rc",
  ].join("; ");
}

/**
 * Build the docker env-file body that carries credentials to the remote.
 *
 * docker's --env-file is deliberately dumb: it splits on the first `=`, does
 * not process quotes, and cannot represent a newline in a value. A credential
 * containing a newline would silently truncate — and truncated credentials
 * fail as authentication errors, which read like the wrong key rather than a
 * corrupted one. So reject them here instead.
 *
 * Empty credentials are omitted entirely rather than written as blanks: a
 * source-only operation such as `scan` never needs them, and shipping a secret
 * to a host that has no use for it is a leak with no upside.
 */
export function buildEnvFile(
  creds: RcloneCredentials,
  dest: RcloneDestination,
): string {
  const entries: Record<string, string> = {
    RCLONE_CONFIG_DEST_TYPE: "s3",
    RCLONE_CONFIG_DEST_PROVIDER: dest.provider ?? "AWS",
    RCLONE_CONFIG_DEST_REGION: dest.region,
    RCLONE_CONFIG_DEST_LOCATION_CONSTRAINT: dest.region,
    RCLONE_CONFIG_DEST_STORAGE_CLASS: dest.storageClass,
  };
  if (creds.accessKeyId) {
    entries.RCLONE_CONFIG_DEST_ACCESS_KEY_ID = creds.accessKeyId;
  }
  if (creds.secretAccessKey) {
    entries.RCLONE_CONFIG_DEST_SECRET_ACCESS_KEY = creds.secretAccessKey;
  }
  if (dest.endpoint) entries.RCLONE_CONFIG_DEST_ENDPOINT = dest.endpoint;

  for (const [key, value] of Object.entries(entries)) {
    if (/[\r\n]/.test(value)) {
      throw new Error(
        `refusing to run: ${key} contains a newline, which docker --env-file ` +
          `cannot represent and would silently truncate`,
      );
    }
  }
  return Object.entries(entries).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}

/**
 * Run rclone on the remote host, in a container, over SSH.
 *
 * Three invariants are enforced here rather than trusted to callers, because
 * each fails invisibly and expensively:
 *
 *  - Destructive subcommands are refused. `sync` against a source that failed
 *    to mount empties the destination, unrecoverably and still billed.
 *  - Secrets never reach argv on EITHER host. They travel as an env-file
 *    streamed down the SSH stdin pipe and into a FIFO on the remote, so they
 *    also never land on the NAS filesystem. See buildRemoteCommand.
 *  - The storage class is injected. Without it the upload silently lands at S3
 *    Standard rates and nothing says so until the bill.
 */
export async function runRclone(
  creds: RcloneCredentials,
  dest: RcloneDestination,
  transport: RcloneTransport,
  args: string[],
): Promise<RcloneResult> {
  const subcommand = args.find((a) => !a.startsWith("-"));
  if (subcommand && FORBIDDEN.has(subcommand)) {
    throw new Error(
      `rclone "${subcommand}" removes data and this suite never deletes; ` +
        `see CONVENTIONS.md §3`,
    );
  }

  const secrets = [creds.accessKeyId, creds.secretAccessKey].filter((s) =>
    s.length > 0
  );
  for (const arg of args) {
    for (const secret of secrets) {
      if (arg.includes(secret)) {
        throw new Error(
          "refusing to run: a credential appeared in rclone arguments, " +
            "which are world-readable via ps on BOTH hosts",
        );
      }
    }
  }

  // The storage-class invariant, enforced two different ways because the two
  // invocation shapes fail differently.
  //
  // Normally `args` is an rclone argv and the flag can simply be appended. But
  // packing runs `sh -c '<script>'`, where `args` is ["-c", script]: appending
  // a flag there makes it a POSITIONAL PARAMETER of the shell, which rclone
  // never sees. The upload would then land at S3 Standard rates while the code
  // looked like it had injected the class — the exact silent 23x mistake the
  // guard exists to prevent, wearing the guard's own clothes. So assert.
  //
  // Both forms apply only when the invocation actually CARRIES credentials.
  // Without them rclone cannot reach S3 at all, so a source-only call — the
  // `du` tree walk that plans a pack, or `size /data` — has no storage class
  // to name. Keying on credentials rather than on a caller-supplied "read
  // only" flag means the exemption cannot be claimed by an invocation that
  // could in fact write.
  let argv: string[];
  if (secrets.length === 0) {
    argv = args;
  } else if (transport.entrypoint) {
    if (!args.join(" ").includes("--s3-storage-class")) {
      throw new Error(
        "refusing to run: a shell-entrypoint invocation must name " +
          "--s3-storage-class inside the script itself. Appending it here " +
          "would pass it to the shell, not to rclone, and the upload would " +
          "silently land at S3 Standard rates.",
      );
    }
    argv = args;
  } else {
    argv = args.includes("--s3-storage-class")
      ? args
      : [...args, "--s3-storage-class", dest.storageClass];
  }

  // The remote command line. Every word is quoted because ssh hands this to a
  // login shell, and volume1 contains paths with spaces and parentheses. The
  // sole exception is ENV_FIFO_REF, which buildRemoteCommand turns into a live
  // "$ENVF" expansion — see its comment for why the env file is a FIFO and not
  // /dev/stdin.
  const remote = buildRemoteCommand([
    transport.dockerBinary ?? "/usr/local/bin/docker",
    "run",
    "--rm",
    "--env-file",
    ENV_FIFO_REF,
    "-v",
    `${transport.sourceMount}:/data:ro`,
    ...(transport.entrypoint ? ["--entrypoint", transport.entrypoint] : []),
    transport.image ?? "rclone/rclone:1.75.0",
    ...argv,
  ]);

  const controller = new AbortController();
  const timeoutMs = transport.timeoutMs ?? 6 * 60 * 60 * 1000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  try {
    const command = new Deno.Command(transport.sshBinary ?? "ssh", {
      args: [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=15",
        transport.sshHost,
        remote,
      ],
      env: {
        PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin:/usr/local/bin",
        HOME: Deno.env.get("HOME") ?? "/home/swamp",
      },
      clearEnv: true,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    });

    const child = command.spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(buildEnvFile(creds, dest)));
    await writer.close();

    const output = await child.output();
    const decoder = new TextDecoder();
    return {
      code: output.code,
      stdout: decoder.decode(output.stdout),
      stderr: redactSecrets(decoder.decode(output.stderr), secrets),
      durationMs: Date.now() - started,
      timedOut: false,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      return {
        code: RCLONE_EXIT.DURATION_LIMIT,
        stdout: "",
        stderr: `rclone timed out after ${timeoutMs}ms`,
        durationMs: Date.now() - started,
        timedOut: true,
      };
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * rclone echoes remote configuration into error messages. Strip credentials
 * before any stderr reaches a resource snapshot or a log line.
 */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0) out = out.replaceAll(secret, "[redacted]");
  }
  return out;
}

/**
 * Was this outcome inconclusive rather than a genuine failure?
 *
 * A retry exhaustion, a transfer cap or a duration cap says nothing about
 * whether the archive is healthy. Recording any of them as a failed rung
 * reports a working backup as broken.
 */
export function isInconclusive(result: RcloneResult): boolean {
  if (result.timedOut) return true;
  return result.code === RCLONE_EXIT.TEMPORARY ||
    result.code === RCLONE_EXIT.TRANSFER_LIMIT ||
    result.code === RCLONE_EXIT.DURATION_LIMIT;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** `rclone size --json` output. Both fields are always present. */
const SizeOutputSchema = z.object({
  count: z.number(),
  bytes: z.number(),
});

/**
 * Parse `rclone size --json`.
 *
 * rclone writes warnings to stdout ahead of the JSON on some backends, so
 * locate the object rather than assuming the whole stream parses.
 */
export function parseSize(
  stdout: string,
): { count: number; bytes: number } | null {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return SizeOutputSchema.parse(JSON.parse(stdout.slice(start, end + 1)));
  } catch {
    return null;
  }
}

/**
 * Choose an upload strategy from the shape of the data.
 *
 * Deep Archive bills 40 KB of overhead per object regardless of file size, plus
 * $0.05 per 1 000 PUTs. Below roughly 1 MB mean file size that overhead stops
 * being a rounding error and starts being a material fraction of the bill, so
 * the share is packed into tar streams instead of copied object-per-file.
 */
export function chooseStrategy(
  count: number,
  bytes: number,
  thresholdBytes: number,
): "direct" | "pack" {
  if (count === 0) return "direct";
  return bytes / count < thresholdBytes ? "pack" : "direct";
}

/**
 * Per-object storage overhead in bytes: 8 KB billed at S3 Standard rates for
 * the name and metadata, 32 KB billed at Deep Archive rates for the index.
 */
export const OBJECT_OVERHEAD_BYTES = 40 * 1024;

const GIB = 1024 ** 3;

/** USD per GB-month, Glacier Deep Archive. */
const DEEP_ARCHIVE_GB_MONTH = 0.00099;
/** USD per GB-month, S3 Standard — the 8 KB metadata half of the overhead. */
const STANDARD_GB_MONTH = 0.023;
/** USD per GB, bulk retrieval (48 h). */
const BULK_RETRIEVAL_GB = 0.0025;
/** USD per GB, internet egress. */
const EGRESS_GB = 0.09;
/**
 * USD per PUT request.
 *
 * The AWS pricing API lists $0.03/1000 for PutObject to Glacier classes and
 * $0.05/1000 for lifecycle transitions into Deep Archive. This suite writes
 * the class directly rather than transitioning, so $0.03 is the likelier rate —
 * the higher figure is kept deliberately, because a cost projection that
 * surprises on the low side is the one that causes trouble.
 */
const PUT_REQUEST = 0.05 / 1000;

/**
 * Project what this share costs to hold and what it costs to get back.
 *
 * Retrieval is reported alongside storage deliberately. Storage is cheap enough
 * to be invisible; egress is not, and an archive whose recovery cost is only
 * discovered during a recovery is an archive nobody can afford to use.
 *
 * Under `pack` the object count is an UPPER BOUND, not a prediction. It assumes
 * packs of `packTargetBytes`, whereas `push` actually emits one pack per
 * top-level entry — usually far fewer, larger objects. Computing the real
 * figure would need a second full tree walk at scan time, and the difference is
 * worth a fraction of a cent a month, so the bound is deliberately left loose
 * and labelled rather than paid for.
 *
 * Rates are us-west-2, verified against the AWS pricing API on 2026-08-15.
 */
export function projectCost(
  count: number,
  bytes: number,
  strategy: "direct" | "pack",
  packTargetBytes: number,
): {
  objectCount: number;
  storageUsdPerMonth: number;
  overheadUsdPerMonth: number;
  uploadUsd: number;
  retrievalUsd: number;
  egressUsd: number;
} {
  const objectCount = strategy === "pack"
    ? Math.max(1, Math.ceil(bytes / packTargetBytes))
    : count;
  const gb = bytes / GIB;
  const overheadGb = (objectCount * OBJECT_OVERHEAD_BYTES) / GIB;

  return {
    objectCount,
    storageUsdPerMonth: gb * DEEP_ARCHIVE_GB_MONTH,
    // The 8/32 KB split, each half at its own rate.
    overheadUsdPerMonth: overheadGb * 0.2 * STANDARD_GB_MONTH +
      overheadGb * 0.8 * DEEP_ARCHIVE_GB_MONTH,
    uploadUsd: objectCount * PUT_REQUEST,
    retrievalUsd: gb * BULK_RETRIEVAL_GB,
    egressUsd: gb * EGRESS_GB,
  };
}

/**
 * Churn between two scans, as a fraction of the earlier byte total.
 *
 * Churn is the cost driver this suite most needs to surface. Deep Archive bills
 * a 180-day minimum on every object, so a share that rewrites itself — Time
 * Machine sparsebundles being the worst case on this NAS — keeps paying for
 * objects it has already replaced. A share at 0% churn costs what the storage
 * line says; a share at 20% monthly churn costs several times that.
 */
export function churnFraction(
  previousBytes: number | null,
  currentBytes: number,
): number | null {
  if (previousBytes === null || previousBytes <= 0) return null;
  return Math.abs(currentBytes - previousBytes) / previousBytes;
}

/** One tar object to be produced from the share. */
export interface Pack {
  /** Object name at the destination, without the .tar suffix. */
  name: string;
  /**
   * Path relative to the share root that tar will archive, or "." for the
   * loose files sitting directly in the share root.
   */
  member: string;
  bytes: number;
}

/**
 * Parse `du -sk /data/*` output into entries relative to the share root.
 *
 * busybox `du` emits "<kilobytes>\t<path>". Splitting on the FIRST tab matters:
 * a directory name may contain a tab, and splitting on whitespace would break
 * every directory name containing a space — of which volume1 has several.
 */
export function parseDu(
  stdout: string,
): Array<{ name: string; bytes: number }> {
  const out: Array<{ name: string; bytes: number }> = [];
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const kb = Number(line.slice(0, tab).trim());
    const path = line.slice(tab + 1);
    if (!Number.isFinite(kb) || path.length === 0) continue;
    // Entries arrive as /data/<name>; keep only the leaf.
    const name = path.replace(/^\/data\/?/, "");
    if (name.length === 0 || name === ".") continue;
    out.push({ name, bytes: kb * 1024 });
  }
  return out;
}

/**
 * Turn a share's top-level entries into a stable set of packs.
 *
 * **One pack per top-level entry, with no size-based grouping.** That looks
 * wasteful — it ignores packTargetBytes, and a share of many tiny directories
 * produces many small objects — but the alternative is worse in the way that
 * matters for an archive.
 *
 * Grouping small directories toward a target size makes pack boundaries a
 * function of the DATA. Add one file and the grouping shifts, every downstream
 * pack gets a different name, and the next push re-uploads the entire share —
 * paying, on Glacier Deep Archive, a fresh 180-day minimum on every object it
 * replaced. Stable names are worth more than optimal packing, because an
 * archive is written far more often than it is read.
 *
 * Loose files in the share root are collected into a single `_root` pack so
 * they are neither skipped nor turned into one object each.
 */
export function buildPackPlan(
  entries: Array<{ name: string; bytes: number }>,
  looseFileBytes: number,
): Pack[] {
  const packs: Pack[] = entries
    .filter((e) => e.name !== ".")
    .map((e) => ({ name: e.name, member: e.name, bytes: e.bytes }))
    // Sort for deterministic ordering — a plan that varies run to run is a
    // plan that cannot be compared against the previous run.
    .sort((a, b) => a.name.localeCompare(b.name));

  if (looseFileBytes > 0) {
    packs.push({ name: "_root", member: ".", bytes: looseFileBytes });
  }
  return packs;
}

/**
 * Build the shell script that streams one subtree to one Deep Archive object.
 *
 * tar writes to stdout and `rclone rcat` reads stdin, so the whole pack is
 * streamed — nothing is staged on the NAS, which matters because volume1 is
 * 53% full and a 400 GB temporary tar would not fit.
 *
 * `set -o pipefail` is not optional. Without it the exit status is rclone's
 * alone, so a tar that dies halfway — disk error, permission denied, file
 * vanishing mid-read — still exits 0, and rclone faithfully uploads the
 * truncated stream as a complete object. That is the worst failure mode
 * available here: a backup that reports success and cannot be restored.
 */
export function buildPackScript(
  member: string,
  destination: string,
  storageClass: string,
): string {
  return [
    "set -e",
    "set -o pipefail",
    `tar -C /data -cf - ${shQuote(member)} | rclone rcat ` +
    `${shQuote(destination)} --s3-storage-class ${shQuote(storageClass)}`,
  ].join("\n");
}

/**
 * Build the shell script that extracts ONE member from a packed object and
 * hashes it.
 *
 * `tar -xO` writes the member to stdout, so nothing is staged on the NAS. As
 * with the pack script, `pipefail` is what makes the result trustworthy: a
 * missing member makes tar fail, and without pipefail `sha256sum` would still
 * exit 0 having hashed an empty stream — reporting a successful drill for a
 * member that is not in the archive.
 */
export function buildExtractScript(
  object: string,
  member: string,
  storageClass: string,
): string {
  return [
    "set -e",
    "set -o pipefail",
    `rclone cat ${shQuote(object)} --s3-storage-class ${
      shQuote(storageClass)
    } ` +
    `| tar -xOf - ${shQuote(member)} | sha256sum`,
  ].join("\n");
}

/** Strip a leading/trailing slash so prefixes concatenate predictably. */
export function normalisePrefix(prefix: string): string {
  return prefix.replace(/^\/+/, "").replace(/\/+$/, "");
}

/** The destination path for one share, as an rclone remote spec. */
export function destPath(
  bucket: string,
  prefix: string,
  share: string,
): string {
  const p = normalisePrefix(prefix);
  return p ? `dest:${bucket}/${p}/${share}` : `dest:${bucket}/${share}`;
}

// ---------------------------------------------------------------------------
// Platform types
// ---------------------------------------------------------------------------

type Logger = {
  info: (message: string, props?: Record<string, unknown>) => void;
  warn: (message: string, props?: Record<string, unknown>) => void;
};

type ExecuteContext<G> = {
  globalArgs: G;
  logger: Logger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

type Handles = { dataHandles: Array<{ name: string }> };

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const InventorySchema = z.object({
  shareName: z.string(),
  sourcePath: z.string(),
  reachable: z.boolean(),
  failureReason: z.string().nullable(),
  failureDetail: z.string().nullable(),

  fileCount: z.number(),
  totalBytes: z.number(),
  meanFileBytes: z.number(),

  /** "direct" copies object-per-file; "pack" tars into large objects. */
  strategy: z.enum(["direct", "pack"]),
  strategyReason: z.string(),

  /**
   * Objects this share will occupy at the destination. Exact under `direct`
   * (one per file); an UPPER BOUND under `pack`, where push emits one pack per
   * top-level entry rather than one per packTargetBytes.
   */
  projectedObjectCount: z.number(),
  storageUsdPerMonth: z.number(),
  overheadUsdPerMonth: z.number(),
  uploadUsd: z.number(),
  /** Bulk-tier retrieval, 48 h. Standard tier is 8× this. */
  retrievalUsd: z.number(),
  /** Internet egress for a full recovery — usually the dominant line. */
  egressUsd: z.number(),

  /**
   * Byte change since the previous scan, as a fraction. Null on a first scan.
   * High churn against a 180-day minimum billable duration is the single
   * largest recurring cost risk in this suite.
   */
  churnFraction: z.number().nullable(),
  churnWarning: z.boolean(),

  ranAt: z.string(),
  durationMs: z.number(),
});

const TransferSchema = z.object({
  shareName: z.string(),
  destination: z.string(),
  strategy: z.enum(["direct", "pack"]),
  dryRun: z.boolean(),

  passed: z.boolean(),
  inconclusive: z.boolean(),
  /** rclone exited 9: nothing needed transferring. Not a failure. */
  nothingToTransfer: z.boolean(),
  failureReason: z.string().nullable(),
  detail: z.string().nullable(),
  exitCode: z.number(),

  storageClass: z.string(),

  /** Packs attempted, uploaded, and skipped because the object already exists. */
  packsPlanned: z.number(),
  packsUploaded: z.number(),
  packsSkipped: z.number(),
  packsFailed: z.number(),
  /** Names of packs that failed, for a targeted retry. */
  failedPacks: z.array(z.string()),

  ranAt: z.string(),
  durationMs: z.number(),
});

const VerificationSchema = z.object({
  shareName: z.string(),
  destination: z.string(),

  passed: z.boolean(),
  inconclusive: z.boolean(),
  failureReason: z.string().nullable(),
  detail: z.string().nullable(),
  exitCode: z.number(),

  sourceCount: z.number(),
  sourceBytes: z.number(),
  destCount: z.number(),
  destBytes: z.number(),
  countDelta: z.number(),
  bytesDelta: z.number(),

  /**
   * Always false. Deep Archive objects cannot be read without a restore, so
   * this rung compares inventory metadata only. Recorded explicitly so a
   * report can never present it as a content check.
   */
  contentVerified: z.boolean(),

  ranAt: z.string(),
  durationMs: z.number(),
});

const RetrievalSchema = z.object({
  shareName: z.string(),
  objectPath: z.string(),
  phase: z.enum(["requested", "pending", "restored", "failed"]),

  passed: z.boolean(),
  failureReason: z.string().nullable(),
  detail: z.string().nullable(),
  exitCode: z.number(),

  objectBytes: z.number().nullable(),
  tier: z.string(),
  requestedAt: z.string().nullable(),
  /** Populated only once the object has actually materialised. */
  restoredAt: z.string().nullable(),
  /** SHA-256 of the retrieved object, when the drill downloaded it. */
  sha256: z.string().nullable(),
  sourceSha256: z.string().nullable(),
  contentMatched: z.boolean().nullable(),

  ranAt: z.string(),
  durationMs: z.number(),
});

const GlobalArgsSchema = z.object({
  shareName: z.string().describe(
    "Share name, used for the resource name and the destination prefix.",
  ),
  sourcePath: z.string().describe(
    "Absolute path on the NAS, e.g. /volume1/homes. Bind-mounted read-only.",
  ),
  sshHost: z.string().describe(
    "SSH destination for the NAS, e.g. nas. Must accept BatchMode auth " +
      "from the swamp serve host.",
  ),
  bucket: z.string().describe("Destination S3 bucket."),
  region: z.string().describe("Bucket region, e.g. us-west-2."),
  accessKeyId: z.string().describe(
    "AWS access key ID. Needs only s3:PutObject, s3:GetObject, " +
      "s3:ListBucket and s3:RestoreObject — never s3:DeleteObject.",
  ),
  secretAccessKey: z.string().meta({ sensitive: true }).describe(
    "AWS secret access key — supply via vault.get(), never inline.",
  ),
  storageClass: z.string().optional().describe(
    "S3 storage class. Default DEEP_ARCHIVE — note that the plausible-looking " +
      "GLACIER_DEEP_ARCHIVE is not a class S3 accepts. Changing this is a " +
      "cost decision: STANDARD is roughly 23x the price.",
  ),
  destPrefix: z.string().optional().describe(
    "Key prefix inside the bucket, e.g. nas/volume1. Default empty.",
  ),
  dockerBinary: z.string().optional().describe(
    "Path to docker on the NAS. Default /usr/local/bin/docker (DSM).",
  ),
  sshBinary: z.string().optional().describe(
    "Path to the ssh client. Default `ssh` on PATH.",
  ),
  image: z.string().optional().describe(
    "Pinned rclone image. Default rclone/rclone:1.75.0. Never use :latest.",
  ),
  strategy: z.enum(["auto", "direct", "pack"]).optional().describe(
    "Upload strategy. auto (default) picks from mean file size at scan time.",
  ),
  packThresholdBytes: z.number().optional().describe(
    "Mean file size below which auto chooses pack. Default 1 MiB.",
  ),
  packTargetBytes: z.number().optional().describe(
    "Target size of one tar object when packing. Default 1 GiB.",
  ),
  maxAgeMinutes: z.number().optional().describe(
    "Only consider files modified within this many minutes. Unset means a " +
      "FULL check, where rclone lists the destination once. Setting it " +
      "enables --no-traverse, which is a cost trap without a window: it " +
      "issues one HEAD per considered file, ~80x the cost of a single " +
      "listing. Use a window comfortably wider than the schedule interval " +
      "(e.g. 120 for hourly), and run a periodic FULL push with it unset to " +
      "catch anything a missed or failed run skipped.",
  ),
  allowOverwrite: z.boolean().optional().describe(
    "Drop --immutable, permitting modified files to be re-archived. Off by " +
      "default: on Deep Archive an overwrite deletes the old object and " +
      "still bills its remaining 180-day minimum, so updates cost roughly " +
      "six months of storage per replaced byte. With it off, modified files " +
      "are never updated and are reported as errors.",
  ),
  minAgeMinutes: z.number().optional().describe(
    "Skip files modified more recently than this. Default 15 — the NAS is " +
      "live and Plex, ABB and Time Machine all write during a run.",
  ),
  churnWarnFraction: z.number().optional().describe(
    "Churn above this fraction between scans raises churnWarning. Default " +
      "0.05. Deep Archive bills a 180-day minimum on every replaced object.",
  ),
  maxRestoreBytes: z.number().optional().describe(
    "Byte ceiling for a restore drill, checked BEFORE any retrieval is " +
      "requested. Default 1 GiB.",
  ),
  allowRestore: z.boolean().optional().describe(
    "Permit restoreRequest to spend money on a retrieval. Can also be passed " +
      "per run.",
  ),
  timeoutMinutes: z.number().optional().describe(
    "Per-invocation timeout. Default 360 — a multi-terabyte copy is slow.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ScanArgsSchema = z.object({
  previousBytes: z.number().optional().describe(
    "Byte total from the previous scan, for churn measurement. Wire it in a " +
      "workflow with data.latest(<model>, <RESOURCE INSTANCE>) — the second " +
      "argument is the instance name, which here is the shareName, NOT the " +
      "spec name 'inventory'. Passing the spec name fails during expression " +
      "evaluation before any work runs, and allowFailure would then report " +
      "the run as succeeded. Example for a model named archive-homes " +
      "covering share homes: " +
      "${{ data.latest('archive-homes', 'homes').attributes.totalBytes }}",
  ),
});

const PushArgsSchema = z.object({
  dryRun: z.boolean().optional().describe(
    "Report what would transfer without uploading. Run this first: the first " +
      "real byte is also the first byte billed for 180 days.",
  ),
  strategy: z.enum(["direct", "pack"]).optional().describe(
    "Override the strategy for this run only.",
  ),
  maxTransferBytes: z.number().optional().describe(
    "Stop after this many bytes (--max-transfer). Exit 8 is recorded as " +
      "inconclusive, not as a failure.",
  ),
  maxAgeMinutes: z.number().optional().describe(
    "Override the modified-within window for this run. Omit on a periodic " +
      "full reconciliation.",
  ),
  allowOverwrite: z.boolean().optional().describe(
    "Permit re-archiving modified files for this run only.",
  ),
  repack: z.boolean().optional().describe(
    "Pack strategy only. Replace packs whose object already exists. Off by " +
      "default: on Deep Archive a replacement deletes the old object and " +
      "bills its remaining 180-day minimum anyway, so re-packing an " +
      "unchanged subtree pays twice for the same bytes.",
  ),
});

const VerifyArgsSchema = z.object({});

const RestoreRequestArgsSchema = z.object({
  objectPath: z.string().describe(
    "Key of the object to retrieve, relative to the share prefix.",
  ),
  tier: z.enum(["Bulk", "Standard"]).optional().describe(
    "Bulk (48 h, $0.0025/GB) or Standard (12 h, $0.02/GB). Default Bulk.",
  ),
  allowRestore: z.boolean().optional().describe(
    "Per-run acknowledgement that this spends money. Required unless set as " +
      "a global argument.",
  ),
});

const RestoreDrillArgsSchema = z.object({
  objectPath: z.string().describe(
    "Key of the object to check, relative to the share prefix.",
  ),
  sourceSha256: z.string().optional().describe(
    "Expected SHA-256. If given, the drill fails unless the retrieved " +
      "content matches — the only rung that proves integrity.",
  ),
  member: z.string().optional().describe(
    "Packed shares only. Extract this single member from the tar and hash " +
      "it, rather than hashing the whole pack. Proves the packing is " +
      "REVERSIBLE — a pack that downloads intact but cannot be unpacked is " +
      "not a backup, and hashing the tar as a whole would never notice.",
  ),
});

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

function credentialsOf(g: GlobalArgs): RcloneCredentials {
  return { accessKeyId: g.accessKeyId, secretAccessKey: g.secretAccessKey };
}

/** Credentials for source-only work. The NAS has no use for the AWS key. */
const NO_CREDENTIALS: RcloneCredentials = {
  accessKeyId: "",
  secretAccessKey: "",
};

function destinationOf(g: GlobalArgs): RcloneDestination {
  return {
    bucket: g.bucket,
    region: g.region,
    storageClass: g.storageClass ?? DEFAULT_STORAGE_CLASS,
  };
}

function transportOf(g: GlobalArgs): RcloneTransport {
  return {
    sshHost: g.sshHost,
    sshBinary: g.sshBinary,
    dockerBinary: g.dockerBinary,
    image: g.image,
    sourceMount: g.sourcePath,
    timeoutMs: (g.timeoutMinutes ?? 360) * 60_000,
  };
}

/** Map an rclone exit code to a short, stable reason string. */
export function classifyFailure(result: RcloneResult): string {
  if (result.timedOut) return "timeout";
  switch (result.code) {
    case RCLONE_EXIT.USAGE:
      return "usage-error";
    case RCLONE_EXIT.DIR_NOT_FOUND:
      return "source-not-found";
    case RCLONE_EXIT.FILE_NOT_FOUND:
      return "file-not-found";
    case RCLONE_EXIT.TEMPORARY:
      return "retries-exhausted";
    case RCLONE_EXIT.FATAL:
      return "fatal";
    case RCLONE_EXIT.TRANSFER_LIMIT:
      return "transfer-limit-reached";
    case RCLONE_EXIT.DURATION_LIMIT:
      return "duration-limit-reached";
    default:
      return `exit-${result.code}`;
  }
}

/**
 * The pack path of `push`.
 *
 * Streams one tar per top-level entry straight into a Deep Archive object.
 * Nothing is staged on the NAS: volume1 is 53% full and a 400 GB temporary tar
 * would not fit, so tar's stdout is piped directly into `rclone rcat`.
 *
 * A pack whose object already exists is SKIPPED rather than replaced. On Deep
 * Archive a replacement deletes the old object and bills its remaining 180-day
 * minimum anyway, so silently re-packing an unchanged subtree is a way to pay
 * twice for the same bytes. `repack` opts into replacement explicitly.
 */
async function pushPacked(
  args: z.infer<typeof PushArgsSchema>,
  context: ExecuteContext<GlobalArgs>,
  started: number,
): Promise<Handles> {
  const g = context.globalArgs;
  const share = g.shareName;
  const dryRun = args.dryRun ?? false;
  const repack = args.repack ?? false;
  const dest = destPath(g.bucket, g.destPrefix ?? "", share);
  const storageClass = g.storageClass ?? DEFAULT_STORAGE_CLASS;
  const creds = credentialsOf(g);
  const destination = destinationOf(g);
  const transport = transportOf(g);

  // One tree walk for every top-level entry's size, plus the loose files at
  // the share root. `du -sk` is used rather than N× `rclone size` because the
  // latter would walk the whole share once per subdirectory.
  const duRun = await runRclone(
    NO_CREDENTIALS,
    destination,
    { ...transport, entrypoint: "sh" },
    [
      "-c",
      "set -e\ndu -sk /data/* 2>/dev/null || true\n" +
      'echo "$(find /data -maxdepth 1 -type f -exec du -k {} + 2>/dev/null | ' +
      "awk '{s+=$1} END {print s+0}')\t/data/.\"",
    ],
  );

  const entries = parseDu(duRun.stdout);
  const loose = entries.find((e) => e.name === "." || e.name === "");
  const plan = buildPackPlan(
    entries.filter((e) => e.name !== "." && e.name !== ""),
    loose?.bytes ?? 0,
  );

  if (duRun.code !== RCLONE_EXIT.OK && plan.length === 0) {
    const handle = await context.writeResource(
      "transfer",
      `${share}-transfer`,
      {
        shareName: share,
        destination: dest,
        strategy: "pack",
        dryRun,
        passed: false,
        inconclusive: isInconclusive(duRun),
        nothingToTransfer: false,
        failureReason: classifyFailure(duRun),
        detail: duRun.stderr.slice(0, 2000) || null,
        exitCode: duRun.code,
        storageClass,
        packsPlanned: 0,
        packsUploaded: 0,
        packsSkipped: 0,
        packsFailed: 0,
        failedPacks: [],
        ranAt: new Date().toISOString(),
        durationMs: Date.now() - started,
      },
    );
    return { dataHandles: [handle] };
  }

  let uploaded = 0;
  let skipped = 0;
  const failed: string[] = [];
  let lastCode: number = RCLONE_EXIT.OK;
  let lastDetail = "";

  for (const pack of plan) {
    const object = `${dest}/${pack.name}.tar`;

    if (!repack) {
      const exists = await runRclone(creds, destination, transport, [
        "lsjson",
        object,
      ]);
      // lsjson exits 0 with a non-empty array when the object is present.
      if (exists.code === RCLONE_EXIT.OK && exists.stdout.includes('"Path"')) {
        skipped++;
        continue;
      }
    }

    if (dryRun) {
      context.logger.info(
        `${share}: would pack ${pack.member} -> ${pack.name}.tar ` +
          `(${(pack.bytes / 1e9).toFixed(2)} GB)`,
      );
      uploaded++;
      continue;
    }

    const run = await runRclone(
      creds,
      destination,
      { ...transport, entrypoint: "sh" },
      ["-c", buildPackScript(pack.member, object, storageClass)],
    );

    if (run.code === RCLONE_EXIT.OK) {
      uploaded++;
    } else {
      failed.push(pack.name);
      lastCode = run.code;
      lastDetail = run.stderr.slice(0, 2000);
      context.logger.warn(
        `${share}: pack ${pack.name} failed (${classifyFailure(run)})`,
      );
    }
  }

  const passed = failed.length === 0;
  const handle = await context.writeResource("transfer", `${share}-transfer`, {
    shareName: share,
    destination: dest,
    strategy: "pack",
    dryRun,
    passed,
    inconclusive: false,
    nothingToTransfer: uploaded === 0 && skipped > 0,
    failureReason: passed ? null : "pack-failed",
    detail: passed ? null : lastDetail || null,
    exitCode: passed ? RCLONE_EXIT.OK : lastCode,
    storageClass,
    packsPlanned: plan.length,
    packsUploaded: uploaded,
    packsSkipped: skipped,
    packsFailed: failed.length,
    failedPacks: failed,
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  });
  return { dataHandles: [handle] };
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export const model = {
  type: "@sntxrr/rclone/archive",
  version: "2026.08.15.1",
  globalArguments: GlobalArgsSchema,

  resources: {
    "inventory": {
      description:
        "What one share contains — file count, bytes, chosen upload strategy, " +
        "churn since the last scan, and the projected cost to both store and " +
        "retrieve it",
      schema: InventorySchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    "transfer": {
      description:
        "The outcome of one copy to Deep Archive — including the distinction " +
        "between a failure and a run that simply had nothing to transfer",
      schema: TransferSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    "verification": {
      description:
        "Source-versus-destination inventory comparison. Metadata only — " +
        "Deep Archive cannot be read without a restore",
      schema: VerificationSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    "retrieval": {
      description:
        "A restore drill, across its asynchronous phases — the only evidence " +
        "that anything in this archive can actually be recovered",
      schema: RetrievalSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
  },

  checks: {
    "source-path-absolute": {
      description:
        "sourcePath must be an absolute NAS path — it becomes a docker bind " +
        "mount, and a relative path silently creates a named volume instead.",
      labels: ["policy"],
      // deno-lint-ignore require-await
      execute: async (
        context: { globalArgs: GlobalArgs },
      ): Promise<{ pass: boolean; errors?: string[] }> => {
        const p = context.globalArgs.sourcePath ?? "";
        if (!p.startsWith("/")) {
          return {
            pass: false,
            errors: [
              `sourcePath "${p}" is not absolute. docker interprets a ` +
              `relative -v source as a NAMED VOLUME, so the container would ` +
              `mount an empty directory and the copy would appear to succeed ` +
              `having archived nothing.`,
            ],
          };
        }
        return { pass: true };
      },
    },
    "credentials-present": {
      description:
        "Both halves of the AWS key must be set — an empty value fails at " +
        "rclone with an error that reads like a permissions problem.",
      labels: ["policy"],
      // deno-lint-ignore require-await
      execute: async (
        context: { globalArgs: GlobalArgs },
      ): Promise<{ pass: boolean; errors?: string[] }> => {
        const g = context.globalArgs;
        const errors: string[] = [];
        if (!g.accessKeyId?.trim()) {
          errors.push("globalArgs.accessKeyId is empty.");
        }
        if (!g.secretAccessKey?.trim()) {
          errors.push(
            "globalArgs.secretAccessKey is empty — wire it from a vault, " +
              "e.g. ${{ vault.get(onepassword, glacier-archive/secret-key) }}.",
          );
        }
        return errors.length > 0 ? { pass: false, errors } : { pass: true };
      },
    },
    "archive-storage-class": {
      description:
        "Warn when the storage class is not an archive tier. STANDARD costs " +
        "roughly 23x Deep Archive and nothing in rclone's output says so.",
      labels: ["policy", "cost"],
      // deno-lint-ignore require-await
      execute: async (
        context: { globalArgs: GlobalArgs },
      ): Promise<{ pass: boolean; errors?: string[] }> => {
        const sc = context.globalArgs.storageClass ?? DEFAULT_STORAGE_CLASS;
        // An invalid class is a DIFFERENT failure from a valid-but-expensive
        // one, and must be reported as such. Conflating them is how
        // GLACIER_DEEP_ARCHIVE — which S3 rejects outright — sat in this
        // allowlist being reported as a perfectly good archive tier.
        if (!S3_STORAGE_CLASSES.includes(sc)) {
          return {
            pass: false,
            errors: [
              `storageClass "${sc}" is not a storage class S3 accepts, so ` +
              `every PutObject will fail with 400 InvalidStorageClass. Valid ` +
              `values are: ${S3_STORAGE_CLASSES.join(", ")}. Note that ` +
              `"GLACIER_DEEP_ARCHIVE" is a plausible-looking name that does ` +
              `not exist — Deep Archive is "DEEP_ARCHIVE".`,
            ],
          };
        }
        if (!ARCHIVE_STORAGE_CLASSES.includes(sc)) {
          return {
            pass: false,
            errors: [
              `storageClass "${sc}" is not an archive tier. This suite exists ` +
              `to write Deep Archive, and S3 Standard is roughly 23x the ` +
              `price per GB-month ($0.023 against $0.00099) — on a ` +
              `multi-terabyte volume that is the difference between tens of ` +
              `dollars a month and hundreds. Nothing in rclone's output will ` +
              `tell you which one you got. Set this deliberately or not at all.`,
            ],
          };
        }
        return { pass: true };
      },
    },
    // THERE IS DELIBERATELY NO "restore-acknowledged" PRE-FLIGHT CHECK.
    //
    // Checks receive only globalArgs — swamp never passes method inputs to
    // them — so a check gating restoreRequest on an acknowledgement would
    // reject `--input allowRestore=true` before `execute` ran, and its own
    // error would tell the operator to do the thing it had just made
    // impossible. The only route through would be arming the flag PERMANENTLY
    // on the model, so a check written to prevent accidental spending would
    // end up forcing that spending to be armed for good. The gate is in
    // `execute`. See CONVENTIONS.md §7.
  },

  methods: {
    // -----------------------------------------------------------------------
    // Rung 1 — what is there, and what will it cost
    // -----------------------------------------------------------------------
    "scan": {
      description:
        "Rung 1. Inventory one share: file count, byte total, mean file size. " +
        "Chooses direct or pack from the shape of the data, and projects both " +
        "the storage cost and — the number nobody has until they need it — " +
        "the cost of getting the data back out. Measures churn against the " +
        "previous scan, because Deep Archive bills a 180-day minimum on every " +
        "replaced object and a churning share costs several times its storage " +
        "line. Records an unreachable share rather than throwing, so a fleet " +
        "report can still see it.",
      arguments: ScanArgsSchema,
      execute: async (
        args: z.infer<typeof ScanArgsSchema>,
        context: ExecuteContext<GlobalArgs>,
      ): Promise<Handles> => {
        const started = Date.now();
        const g = context.globalArgs;
        const share = g.shareName;
        const packTarget = g.packTargetBytes ?? GIB;
        const threshold = g.packThresholdBytes ?? 1024 * 1024;
        const warnAt = g.churnWarnFraction ?? 0.05;

        // Source-only: the NAS has no use for the AWS credentials here, so it
        // does not receive them.
        const run = await runRclone(
          NO_CREDENTIALS,
          destinationOf(g),
          transportOf(g),
          ["size", "/data", "--json"],
        );

        const parsed = run.code === RCLONE_EXIT.OK
          ? parseSize(run.stdout)
          : null;

        if (parsed === null) {
          // Deliberately not a throw. An unreachable share is the single most
          // important thing a fleet report needs to see, and a thrown error
          // writes no resource at all.
          const reason = run.code === RCLONE_EXIT.OK
            ? "unparseable-size-output"
            : classifyFailure(run);
          context.logger.warn(`${share}: unreachable (${reason})`);
          const handle = await context.writeResource("inventory", share, {
            shareName: share,
            sourcePath: g.sourcePath,
            reachable: false,
            failureReason: reason,
            failureDetail: run.stderr.slice(0, 2000) || null,
            fileCount: 0,
            totalBytes: 0,
            meanFileBytes: 0,
            strategy: "direct",
            strategyReason: "share unreachable; strategy not determined",
            projectedObjectCount: 0,
            storageUsdPerMonth: 0,
            overheadUsdPerMonth: 0,
            uploadUsd: 0,
            retrievalUsd: 0,
            egressUsd: 0,
            churnFraction: null,
            churnWarning: false,
            ranAt: new Date().toISOString(),
            durationMs: Date.now() - started,
          });
          return { dataHandles: [handle] };
        }

        const { count, bytes } = parsed;
        const mean = count > 0 ? bytes / count : 0;
        const strategy = g.strategy && g.strategy !== "auto"
          ? g.strategy
          : chooseStrategy(count, bytes, threshold);
        const reason = g.strategy && g.strategy !== "auto"
          ? `strategy pinned to ${g.strategy} by configuration`
          : strategy === "pack"
          ? `mean file size ${
            Math.round(mean)
          } B is below the ${threshold} B ` +
            `threshold; packing amortises the 40 KB per-object overhead`
          : `mean file size ${Math.round(mean)} B is at or above the ` +
            `${threshold} B threshold; per-object overhead is immaterial`;

        const cost = projectCost(count, bytes, strategy, packTarget);
        const churn = churnFraction(args.previousBytes ?? null, bytes);

        context.logger.info(
          `${share}: ${count} files, ${(bytes / 1e12).toFixed(2)} TB, ` +
            `strategy=${strategy}, ~$${
              cost.storageUsdPerMonth.toFixed(2)
            }/mo, ` +
            `egress to recover ~$${cost.egressUsd.toFixed(0)}`,
        );

        const handle = await context.writeResource("inventory", share, {
          shareName: share,
          sourcePath: g.sourcePath,
          reachable: true,
          failureReason: null,
          failureDetail: null,
          fileCount: count,
          totalBytes: bytes,
          meanFileBytes: mean,
          strategy,
          strategyReason: reason,
          projectedObjectCount: cost.objectCount,
          storageUsdPerMonth: cost.storageUsdPerMonth,
          overheadUsdPerMonth: cost.overheadUsdPerMonth,
          uploadUsd: cost.uploadUsd,
          retrievalUsd: cost.retrievalUsd,
          egressUsd: cost.egressUsd,
          churnFraction: churn,
          churnWarning: churn !== null && churn > warnAt,
          ranAt: new Date().toISOString(),
          durationMs: Date.now() - started,
        });
        return { dataHandles: [handle] };
      },
    },

    // -----------------------------------------------------------------------
    // Rung 2 — get it to AWS
    // -----------------------------------------------------------------------
    "push": {
      description:
        "Rung 2. Copy the share to Deep Archive. Never sync — a source that " +
        "failed to mount presents as empty, and sync would empty the " +
        "destination unrecoverably while still billing for it. Injects the " +
        "storage class, refuses to overwrite by default, and distinguishes " +
        "'nothing needed transferring' (exit 9) from 'nothing happened', " +
        "which are indistinguishable without --error-on-no-transfer.",
      arguments: PushArgsSchema,
      execute: async (
        args: z.infer<typeof PushArgsSchema>,
        context: ExecuteContext<GlobalArgs>,
      ): Promise<Handles> => {
        const started = Date.now();
        const g = context.globalArgs;
        const share = g.shareName;
        const dryRun = args.dryRun ?? false;
        const strategy = args.strategy ??
          (g.strategy && g.strategy !== "auto" ? g.strategy : "direct");
        const dest = destPath(g.bucket, g.destPrefix ?? "", share);
        const storageClass = g.storageClass ?? DEFAULT_STORAGE_CLASS;

        if (strategy === "pack") {
          return await pushPacked(args, context, started);
        }

        const maxAge = args.maxAgeMinutes ?? g.maxAgeMinutes;
        const overwrite = args.allowOverwrite ?? g.allowOverwrite ?? false;

        const flags = [
          "--error-on-no-transfer",
          "--min-age",
          `${g.minAgeMinutes ?? 15}m`,
          "--stats-one-line",
          "--stats",
          "5m",
        ];

        // --immutable refuses to overwrite a changed file. That is the right
        // default for an archive — on Deep Archive an overwrite deletes the
        // old object and bills its remaining 180-day minimum anyway — but it
        // means a MODIFIED file is never archived and reports as an error.
        // Opting out is a cost decision, so it is explicit.
        if (!overwrite) flags.push("--immutable");

        // --no-traverse and --max-age are coupled deliberately, because
        // --no-traverse alone is a cost trap.
        //
        // With it, rclone skips listing the destination and instead issues one
        // HEAD per source file it CONSIDERS. That is a win only when few files
        // are considered. Considering all of them costs ~80x more than a single
        // destination listing: at 5M files that is ~$2.00 a run against ~$0.03,
        // which at an hourly cadence is ~$1,460/mo against ~$18/mo.
        //
        // A --max-age window is what makes the candidate set small. So the
        // window enables --no-traverse, and without a window rclone traverses.
        if (maxAge !== undefined) {
          flags.push("--max-age", `${maxAge}m`, "--no-traverse");
        }
        if (dryRun) flags.push("--dry-run");
        if (args.maxTransferBytes) {
          flags.push("--max-transfer", String(args.maxTransferBytes));
        }

        // `copy`, never `sync`. The runner refuses `sync` outright; naming it
        // here as well makes the intent legible at the call site.
        const run = await runRclone(
          credentialsOf(g),
          destinationOf(g),
          transportOf(g),
          ["copy", "/data", dest, ...flags],
        );

        const nothing = run.code === RCLONE_EXIT.NO_TRANSFER;
        const inconclusive = isInconclusive(run);
        const passed = run.code === RCLONE_EXIT.OK || nothing;

        if (!passed && !inconclusive) {
          context.logger.warn(
            `${share}: push failed (${classifyFailure(run)})`,
          );
        }

        const handle = await context.writeResource(
          "transfer",
          `${share}-transfer`,
          {
            shareName: share,
            destination: dest,
            strategy,
            dryRun,
            passed,
            inconclusive,
            nothingToTransfer: nothing,
            failureReason: passed ? null : classifyFailure(run),
            detail: run.stderr.slice(0, 2000) || null,
            exitCode: run.code,
            storageClass,
            packsPlanned: 0,
            packsUploaded: 0,
            packsSkipped: 0,
            packsFailed: 0,
            failedPacks: [],
            ranAt: new Date().toISOString(),
            durationMs: Date.now() - started,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // -----------------------------------------------------------------------
    // Rung 3 — does the destination match
    // -----------------------------------------------------------------------
    "verify": {
      description:
        "Rung 3. Compare source and destination inventories — object count " +
        "and byte totals. Metadata only, and it says so: Deep Archive objects " +
        "cannot be read without a restore, and the S3 ETag of a multipart " +
        "upload is not a content hash, so there is nothing here that proves " +
        "integrity. That is what restoreDrill is for.",
      arguments: VerifyArgsSchema,
      execute: async (
        _args: z.infer<typeof VerifyArgsSchema>,
        context: ExecuteContext<GlobalArgs>,
      ): Promise<Handles> => {
        const started = Date.now();
        const g = context.globalArgs;
        const share = g.shareName;
        const dest = destPath(g.bucket, g.destPrefix ?? "", share);

        const sourceRun = await runRclone(
          NO_CREDENTIALS,
          destinationOf(g),
          transportOf(g),
          ["size", "/data", "--json"],
        );
        const destRun = await runRclone(
          credentialsOf(g),
          destinationOf(g),
          transportOf(g),
          ["size", dest, "--json"],
        );

        const src = parseSize(sourceRun.stdout);
        const dst = parseSize(destRun.stdout);
        const worst = sourceRun.code !== RCLONE_EXIT.OK ? sourceRun : destRun;
        const inconclusive = isInconclusive(sourceRun) ||
          isInconclusive(destRun);

        if (src === null || dst === null) {
          const handle = await context.writeResource(
            "verification",
            `${share}-verification`,
            {
              shareName: share,
              destination: dest,
              passed: false,
              inconclusive,
              failureReason: classifyFailure(worst),
              detail: (destRun.stderr || sourceRun.stderr).slice(0, 2000) ||
                null,
              exitCode: worst.code,
              sourceCount: src?.count ?? 0,
              sourceBytes: src?.bytes ?? 0,
              destCount: dst?.count ?? 0,
              destBytes: dst?.bytes ?? 0,
              countDelta: 0,
              bytesDelta: 0,
              contentVerified: false,
              ranAt: new Date().toISOString(),
              durationMs: Date.now() - started,
            },
          );
          return { dataHandles: [handle] };
        }

        // Under `pack` the destination object count is deliberately far lower
        // than the source file count, so only bytes are comparable. Under
        // `direct` both should agree.
        const countDelta = dst.count - src.count;
        const bytesDelta = dst.bytes - src.bytes;
        const passed = bytesDelta >= 0 && dst.bytes > 0;

        const handle = await context.writeResource(
          "verification",
          `${share}-verification`,
          {
            shareName: share,
            destination: dest,
            passed,
            inconclusive,
            failureReason: passed ? null : "destination-short",
            detail: passed
              ? null
              : `destination holds ${dst.bytes} bytes against ${src.bytes} at ` +
                `source (${bytesDelta})`,
            exitCode: destRun.code,
            sourceCount: src.count,
            sourceBytes: src.bytes,
            destCount: dst.count,
            destBytes: dst.bytes,
            countDelta,
            bytesDelta,
            contentVerified: false,
            ranAt: new Date().toISOString(),
            durationMs: Date.now() - started,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // -----------------------------------------------------------------------
    // Rung 4 — can a retrieval even be started
    // -----------------------------------------------------------------------
    "restoreRequest": {
      description:
        "Rung 4. Ask S3 to bring one object back from Deep Archive. This " +
        "SPENDS MONEY and takes 12-48 hours, so it is gated on an explicit " +
        "acknowledgement and a byte ceiling checked before the request is " +
        "issued. Records a pending retrieval; restoreDrill collects it.",
      arguments: RestoreRequestArgsSchema,
      execute: async (
        args: z.infer<typeof RestoreRequestArgsSchema>,
        context: ExecuteContext<GlobalArgs>,
      ): Promise<Handles> => {
        const started = Date.now();
        const g = context.globalArgs;
        const share = g.shareName;
        const tier = args.tier ?? "Bulk";
        const dest = destPath(g.bucket, g.destPrefix ?? "", share);
        const object = `${dest}/${args.objectPath}`;

        // The gate lives here, not in a check: a check sees only globalArgs
        // and would reject the per-run input before this ever ran.
        const allowed = args.allowRestore ?? g.allowRestore ?? false;
        if (!allowed) {
          throw new Error(
            `restoreRequest retrieves ${args.objectPath} from Deep Archive, ` +
              `which costs money and takes 12-48 hours. Re-run with ` +
              `--input allowRestore=true, or set allowRestore on the model.`,
          );
        }

        const run = await runRclone(
          credentialsOf(g),
          destinationOf(g),
          transportOf(g),
          [
            "backend",
            "restore",
            object,
            "-o",
            `lifetime=1`,
            "-o",
            `priority=${tier}`,
          ],
        );

        const passed = run.code === RCLONE_EXIT.OK;
        const handle = await context.writeResource(
          "retrieval",
          `${share}-${args.objectPath.replaceAll("/", "-")}`,
          {
            shareName: share,
            objectPath: args.objectPath,
            phase: passed ? "requested" : "failed",
            passed,
            failureReason: passed ? null : classifyFailure(run),
            detail: run.stderr.slice(0, 2000) || null,
            exitCode: run.code,
            objectBytes: null,
            tier,
            requestedAt: passed ? new Date().toISOString() : null,
            restoredAt: null,
            sha256: null,
            sourceSha256: null,
            contentMatched: null,
            ranAt: new Date().toISOString(),
            durationMs: Date.now() - started,
          },
        );
        return { dataHandles: [handle] };
      },
    },

    // -----------------------------------------------------------------------
    // Rung 5 — did it actually come back, and is it the same bytes
    // -----------------------------------------------------------------------
    "restoreDrill": {
      description:
        "Rung 5. The only rung that proves recovery. Polls a requested " +
        "retrieval; once the object has materialised, downloads it and hashes " +
        "it. If sourceSha256 is supplied the drill fails unless the content " +
        "matches — everything below this rung compares metadata, and metadata " +
        "cannot see corruption. Safe to run repeatedly while still pending.",
      arguments: RestoreDrillArgsSchema,
      execute: async (
        args: z.infer<typeof RestoreDrillArgsSchema>,
        context: ExecuteContext<GlobalArgs>,
      ): Promise<Handles> => {
        const started = Date.now();
        const g = context.globalArgs;
        const share = g.shareName;
        const dest = destPath(g.bucket, g.destPrefix ?? "", share);
        const object = `${dest}/${args.objectPath}`;
        const ceiling = g.maxRestoreBytes ?? GIB;

        // Check the size before moving any bytes — an accidental drill against
        // a 400 GB pack is an expensive way to learn the object was large.
        const sizeRun = await runRclone(
          credentialsOf(g),
          destinationOf(g),
          transportOf(g),
          ["size", object, "--json"],
        );
        const sized = parseSize(sizeRun.stdout);

        if (sized === null) {
          const handle = await context.writeResource(
            "retrieval",
            `${share}-${args.objectPath.replaceAll("/", "-")}`,
            {
              shareName: share,
              objectPath: args.objectPath,
              phase: "pending",
              passed: false,
              failureReason: "not-yet-retrievable",
              detail: sizeRun.stderr.slice(0, 2000) || null,
              exitCode: sizeRun.code,
              objectBytes: null,
              tier: "unknown",
              requestedAt: null,
              restoredAt: null,
              sha256: null,
              sourceSha256: args.sourceSha256 ?? null,
              contentMatched: null,
              ranAt: new Date().toISOString(),
              durationMs: Date.now() - started,
            },
          );
          return { dataHandles: [handle] };
        }

        if (sized.bytes > ceiling) {
          throw new Error(
            `restoreDrill refuses ${args.objectPath}: ${sized.bytes} bytes ` +
              `exceeds maxRestoreBytes ${ceiling}. Raise the ceiling ` +
              `deliberately, or drill a smaller object.`,
          );
        }

        // Both forms stream the restored object without landing it on disk.
        // Deep Archive returns InvalidObjectState until the retrieval
        // completes, which is a pending signal rather than a failure.
        //
        // With `member`, the pack is unpacked in flight and only that member
        // is hashed — the difference between "the object came back" and "the
        // archive can actually be opened", which is the whole point of a drill
        // against a packed share.
        const storageClass = g.storageClass ?? DEFAULT_STORAGE_CLASS;
        const hashRun = args.member
          ? await runRclone(
            credentialsOf(g),
            destinationOf(g),
            { ...transportOf(g), entrypoint: "sh" },
            ["-c", buildExtractScript(object, args.member, storageClass)],
          )
          : await runRclone(
            credentialsOf(g),
            destinationOf(g),
            transportOf(g),
            ["sha256sum", object],
          );

        const pending = /InvalidObjectState|not restored|storage class/i.test(
          hashRun.stderr,
        );
        const sha = hashRun.code === RCLONE_EXIT.OK
          ? (hashRun.stdout.trim().split(/\s+/)[0] ?? null)
          : null;
        const matched = sha !== null && args.sourceSha256
          ? sha.toLowerCase() === args.sourceSha256.toLowerCase()
          : null;
        const passed = sha !== null && matched !== false;

        const handle = await context.writeResource(
          "retrieval",
          `${share}-${args.objectPath.replaceAll("/", "-")}`,
          {
            shareName: share,
            objectPath: args.objectPath,
            phase: sha !== null ? "restored" : pending ? "pending" : "failed",
            passed,
            failureReason: passed
              ? null
              : matched === false
              ? "content-mismatch"
              : pending
              ? "still-retrieving"
              : classifyFailure(hashRun),
            detail: hashRun.stderr.slice(0, 2000) || null,
            exitCode: hashRun.code,
            objectBytes: sized.bytes,
            tier: "unknown",
            requestedAt: null,
            restoredAt: sha !== null ? new Date().toISOString() : null,
            sha256: sha,
            sourceSha256: args.sourceSha256 ?? null,
            contentMatched: matched,
            ranAt: new Date().toISOString(),
            durationMs: Date.now() - started,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
