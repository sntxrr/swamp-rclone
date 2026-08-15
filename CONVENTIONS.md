# CONVENTIONS — Synology → Glacier Deep Archive

**Lead-owned. Builders read this, copy from it, and propose changes via the
lead — never edit it directly.** Single source of truth for the shared technical
contract in [`PRD.md`](./PRD.md). If the PRD and this file disagree, this file
wins for _implementation_ detail; the PRD wins for _scope_.

Derived from `../restic/CONVENTIONS.md`, whose structure and hard rules carry
over. Two architectural differences shape everything below:

1. **The binary runs on another host.** `swamp-restic` runs restic locally
   against a remote repository, so its canonical runner is a plain
   `Deno.Command`. Here the *data* is remote and the *credentials* are local, so
   every invocation crosses SSH into a container runtime. That puts a second
   host's `ps` output and a container's environment between the secret and its
   use, and §5–§6 exist almost entirely because of it.
2. **The destination cannot be read back.** restic can `check --read-data`.
   Glacier Deep Archive objects are not readable at all without a 12–48 hour
   restore, so verification splits into a cheap metadata rung and an
   asynchronous two-phase drill.

---

## 1. How a builder uses this doc

1. Pick one model row from [`PRD.md`](./PRD.md) §4.
2. Create your extension's **own directory**:
   `extensions/models/rclone-<domain>/`.
3. Copy the **canonical rclone runner (§5) byte-identical** — do not "improve"
   it per-model. It is kept `deno fmt`-clean so copying it verbatim and passing
   `swamp extension fmt --check` are compatible.
4. Fill in schemas and methods, obeying §3 (the safety rule) and §4 (CLI facts).
5. Copy the test template to `rclone_<domain>_test.ts`; mock the subprocess
   boundary, never the parser or the quoting.
6. Copy the manifest / README / LICENSE templates into the same dir.
7. Run the verification + publish sequence (§9).

**Layout — one isolated directory per extension (mandatory):**

```
extensions/models/rclone-<domain>/
  rclone_<domain>.ts        # export const model
  rclone_<domain>_test.ts   # unit tests (excluded from loading)
  manifest.yaml             # paths.base: manifest
  README.md                 # per-extension docs (additionalFiles)
  LICENSE.md                # MIT (additionalFiles)
```

**File ownership:** a builder touches **only files inside its own
`extensions/models/rclone-<domain>/` directory.** `CONVENTIONS.md`, `PRD.md` and
the root `README.md` are lead-owned.

---

## 2. Hard rules (non-negotiable)

- `import { z } from "npm:zod@4";` — **never** bare `"zod"`. The swamp-club
  scorer runs in a hermetic sandbox with no imports map.
- Static imports only; **no** dynamic `import()` (rejected at push).
- Deno-native only: `Deno.Command` + `fetch`. **No npm deps** beyond zod.
- **Never put a secret in `args`** — on *either* host. See §6; this rule has
  twice as many ways to break here as it does in the restic suite.
- **Never write a secret into a resource snapshot or a log line.** Credentials
  are `.meta({ sensitive: true })` and wired from a vault.
- **Never shell out through a shell locally.** Pass `Deno.Command` an argv
  array. The *remote* side is unavoidably a shell (§5.1) — which is exactly why
  every remote argument goes through `shQuote`.
- **This suite never deletes.** No method may invoke `sync`, `move`, `moveto`,
  `delete`, `deletefile`, `purge`, `rmdir`, `rmdirs` or `cleanup`.

---

## 3. THE SAFETY RULE — copy, never sync

**Every rclone invocation in this suite uses `copy`. `sync` is refused at the
runner. Without exception.**

`rclone sync` makes the destination match the source, which means **it deletes
destination objects that are not in the source**. The failure mode is not
theoretical and not gradual:

- A source path that fails to mount, or a share renamed on the NAS, presents to
  rclone as *an empty source*. `sync` then does exactly what it was asked and
  empties the destination.
- On Deep Archive that deletion is **unrecoverable** — there is no undelete, and
  versioning is not enabled on an archive bucket by default.
- And you are **still billed for the deleted data** for the remainder of its
  180-day minimum. A mistake that destroys the archive also keeps charging for
  it.

`copy` has none of these properties: it only ever adds and overwrites. The worst
a broken source can do under `copy` is transfer nothing.

**Assert this mechanically.** A test must fail if any code path builds an argv
whose subcommand is in the forbidden set, and the runner in §5 enforces it as
well. Belt and braces, because a `sync` that runs once against an empty source
is not something you get to fix afterwards.

**The related trap: `--immutable`.** `copy` overwrites a changed file by
default. On Deep Archive an overwrite deletes the old object — incurring its
180-day minimum charge — and writes a new one. For an archive of last resort
the correct default is to *refuse* and report, not to silently churn. The runner
injects `--immutable` on `copy` unless the caller explicitly opts out, and
opting out is what a `pack` re-upload does deliberately.

---

## 4. rclone and Deep Archive facts

Every item here was either verified against the pinned image or is a billing
rule that shapes the design. Do not take any of it from rclone's docs alone.

### 4.1 Exit codes

| Code | Meaning | Treat as |
| ---: | ------- | -------- |
| 0 | success | pass |
| 1 | syntax or usage error | genuine failure |
| 2 | error not otherwise categorised | genuine failure |
| 3 | directory not found | genuine failure — usually a bad mount |
| 4 | file not found | genuine failure |
| 5 | temporary error, retries exceeded | **inconclusive** |
| 6 | less serious errors | genuine failure |
| 7 | fatal error, no retry | genuine failure |
| 8 | transfer limit exceeded (`--max-transfer`) | **inconclusive** — expected under a cap |
| 9 | success, but no files transferred | pass, and *informative* |
| 10 | duration limit exceeded (`--max-duration`) | **inconclusive** |

Codes 5, 8 and 10 say nothing about whether the archive is healthy. Recording
them as a failed rung reports a working backup as broken — the same
`isInconclusive` distinction the restic suite draws for lock conflicts.

**Code 9 only appears if you ask for it.** Without `--error-on-no-transfer`, a
run that transfers nothing exits 0 and is indistinguishable from a run that
transferred everything. For an incremental archive that is the difference
between "already up to date" and "the source was empty and we uploaded
nothing" — so `push` passes the flag and treats 9 as a distinct, recorded
outcome rather than an error.

### 4.2 The storage class must be injected, not trusted

Uploading without `--s3-storage-class GLACIER_DEEP_ARCHIVE` silently writes at
S3 Standard rates — **23× the cost** — and nothing in rclone's output says so.
The mistake is invisible until a bill arrives a month later, and fixing it
afterwards means re-uploading (and paying the minimum-duration charge on
everything already written).

The runner sets the class in the remote config *and* injects the flag, and
refuses to run a `copy` if neither is present.

### 4.3 Deep Archive cannot be read

There is no `rclone check` against Deep Archive in any useful form: `check`
downloads both sides to compare, and the destination objects are not
retrievable. `--checksum` is no better — S3 returns an ETag, but for any
multipart upload (anything over `--s3-upload-cutoff`, i.e. every large file
here) the ETag is **not** an MD5 of the content, so comparing it is comparing
noise.

Therefore:

- `verify` uses `--size-only` and `lsjson`, comparing **inventory metadata**:
  object count and byte totals. That is all that is available, and the model
  must say so rather than implying it verified content.
- `restoreDrill` is the only rung that touches content, and it is the only rung
  that can prove anything about integrity.

### 4.4 Billing rules that shape the design

- **40 KB of overhead per object** — 8 KB billed at S3 Standard rates for the
  name and metadata, 32 KB billed at Deep Archive rates for the index. It is
  charged per object regardless of size, which is what makes small-file trees
  pathological and packing (PRD §4.1) worthwhile.
- **180-day minimum billable duration.** An object deleted or replaced before
  180 days is billed as though it had lived 180 days. This is why `--immutable`
  is the default and why churning sources are expensive.
- **`--no-traverse`** on incremental adds. Without it rclone lists the whole
  destination to decide what to send; on a multi-terabyte archive that is slow
  and costs LIST requests for no benefit when you are adding a handful of files.
  With it, rclone checks only the files it is about to transfer.
- **`--min-age`** keeps rclone from uploading files still being written. On a
  live NAS with Plex, ABB and Time Machine all writing, this is not optional.

---

## 5. Canonical rclone runner (copy byte-identical)

### 5.1 Why the remote side is a shell, and what that costs

`ssh host cmd arg1 arg2` does **not** preserve argv. OpenSSH joins the arguments
with spaces and hands the result to the remote user's login shell, which re-word-splits
and glob-expands it. Any argument containing a space, quote, `$`, `*` or `(`
is silently mangled or interpreted.

This is not hypothetical. A Synology volume routinely contains names like:

```
/volume1/Resilio Sync                       ← space
/volume1/live-set(final mix).wav    ← parentheses
```

A path with a space becomes two arguments; parentheses are a syntax error in
`sh`. And since these strings come from configuration, an unescaped remote
command line is a command-injection surface as well as a correctness bug.

**Therefore: every remote argument goes through `shQuote` before it is joined.**
There is no exception, including for arguments the builder believes are
constant, because "constant" arguments are exactly what later become
configurable.

### 5.2 The runner

```ts
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
}

/** Destination remote. `storageClass` is mandatory — see §4.2. */
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
 * ssh does not preserve argv (§5.1) — it joins arguments and lets the remote
 * login shell re-split them. Wrapping in single quotes makes every character
 * literal except `'` itself, which is closed, escaped and reopened.
 */
export function shQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * Build the docker env-file body that carries credentials to the remote.
 *
 * docker's --env-file is deliberately dumb: it splits on the first `=`, does
 * not process quotes, and cannot represent a newline in a value. A credential
 * containing a newline would silently truncate — and truncated credentials
 * fail as authentication errors, which read like the wrong key rather than a
 * corrupted one. So reject them here instead.
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
    RCLONE_CONFIG_DEST_ACCESS_KEY_ID: creds.accessKeyId,
    RCLONE_CONFIG_DEST_SECRET_ACCESS_KEY: creds.secretAccessKey,
  };
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
 *    to mount empties the destination, unrecoverably and still billed (§3).
 *  - Secrets never reach argv on EITHER host. They travel as an env-file
 *    delivered on the SSH stdin pipe (§6).
 *  - The storage class is injected. Without it the upload silently lands at S3
 *    Standard rates and nothing says so until the bill (§4.2).
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

  const argv = args.includes("--s3-storage-class")
    ? args
    : [...args, "--s3-storage-class", dest.storageClass];

  // The remote command line. Every word is quoted (§5.1) because ssh hands
  // this to a login shell, and volume1 contains paths with spaces and
  // parentheses.
  const remote = [
    transport.dockerBinary ?? "/usr/local/bin/docker",
    "run",
    "--rm",
    "--env-file",
    "/dev/stdin",
    "-v",
    `${transport.sourceMount}:/data:ro`,
    transport.image ?? "rclone/rclone:latest",
    ...argv,
  ].map(shQuote).join(" ");

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
```

### 5.3 The env file is a FIFO, because DSM will not open `/dev/stdin`

The obvious way to keep a credential out of argv is
`docker run --env-file /dev/stdin` with the env file written down the SSH pipe.
**On DSM that does not work**, and it fails in the most expensive way available:
docker exits 125 before rclone starts, which reads as "the share is
unreachable" rather than "the transport is broken".

```
$ echo K=v | ssh nas '/usr/local/bin/docker run --rm --env-file /dev/stdin ...'
docker: open /dev/stdin: permission denied.
```

It is not a docker problem and not a permissions problem in the usual sense.
Plain `cat /dev/stdin` fails the same way, while `cat` reading fd 0 directly
succeeds — and fd 0 is an ordinary pipe owned by the SSH user, mode
`lr-x------`, with no `hidepid` on `/proc`. Only *opening the path* is denied;
`/proc/self/fd/0` is refused identically.

So the remote shell creates a FIFO in a private 0700 directory and streams the
env file through it. The bytes live in a kernel buffer, so the credential still
never touches the NAS filesystem and still never appears in argv on either
host:

```sh
exec 3<&0                                     # see below — this line is load-bearing
D=$(mktemp -d "${TMPDIR:-/tmp}/rclone.XXXXXX") || exit 125
trap 'rm -rf "$D"' EXIT INT TERM
ENVF="$D/env"
mkfifo -m 600 "$ENVF" || exit 125
cat <&3 > "$ENVF" & CATPID=$!
<docker …  --env-file "$ENVF"  …>; rc=$?
kill "$CATPID" 2>/dev/null
exit $rc
```

Three details are not stylistic:

- **`exec 3<&0`, and `cat <&3`.** A backgrounded command in a POSIX shell has
  its stdin redirected from `/dev/null`. Without the saved descriptor the FIFO
  receives an **empty** env file, rclone runs with no credentials, and the
  failure surfaces as an authentication error rather than as a bug here.
- **`kill`, never `wait`.** If docker dies before opening the FIFO — a bad
  flag, a missing image — the writer is still blocked in `open()`. Waiting on
  it hangs the run until the six-hour timeout.
- **`rc=$?` then `exit $rc`.** Everything downstream classifies on the exit
  code (§4.1); a wrapper that returns its own status makes every failure
  unclassifiable.

`--env-file` is the one word in the docker argv that must **not** be
`shQuote`d, since it has to reach the shell as a live `"$ENVF"` expansion.
That exception is represented by a NUL-delimited sentinel so it can never
collide with a caller-supplied argument, and `buildRemoteCommand` refuses to
run if the sentinel does not appear exactly once.

---

## 6. Secrets — four places, not three

The restic suite has three. The SSH-plus-container transport adds a fourth, and
the two new ones are the easy ones to get wrong.

1. **Into the model** — `${{ vault.get(...) }}` in `globalArguments`, resolved
   at run time. Never a literal; `swamp vault create --config` persists what it
   is given verbatim, and `sensitive` governs logging, not what lands on disk.
2. **Into the local process** — the `env` option on `Deno.Command` with
   `clearEnv: true`. Note that the credentials do **not** go here: they go to
   the remote, so the local subprocess environment stays clean.
3. **Across the wire and into the container** — this is the new one. The obvious
   spelling is wrong:

   ```bash
   # WRONG. The secret is now in `ps` output on nas for the life of the
   # transfer, readable by every user on the box, and in `docker inspect`.
   ssh nas docker run -e AWS_SECRET_ACCESS_KEY=hunter2 rclone/rclone copy …
   ```

   `ps` on the *remote* host is a surface that does not exist at all in the
   restic suite, and it is easy to forget precisely because the local argv looks
   clean. Instead the credentials travel as a docker `--env-file` read from
   `/dev/stdin`, which is the SSH stdin pipe:

   ```bash
   ssh nas 'docker run --rm --env-file /dev/stdin …' < env
   ```

   The remote `ps` line then contains only `--env-file /dev/stdin`. The values
   still appear in `docker inspect` for the container's lifetime, which is a
   residual accepted deliberately: reading it requires docker socket access on
   nas, which is already root-equivalent, whereas reading `ps` requires
   nothing at all.

4. **Out of the snapshot** — mark secret-bearing fields
   `.meta({ sensitive: true })`, and prefer never writing them. Pass all
   captured stderr through `redactSecrets`: rclone echoes remote configuration
   into its error messages, including the access key ID.

A test must assert that no credential appears in any written resource, that
`runRclone` throws when a credential is passed in `args`, and that the remote
command line contains no credential material.

---

## 7. Gating the destructive-adjacent methods

There is no `unlock` analogue here, but `restoreRequest` **spends money** — a
standard-tier retrieval of a large sample costs real dollars, and a bulk
retrieval commits to a 48-hour wait. Gate it on a byte ceiling checked *before*
the request is issued, exactly as the restic suite gates its restore drill.

Per the rule inherited from the B2 suite: **a pre-flight check must never gate a
method on an acknowledgement passed as a method input.** Checks receive
`globalArgs` only — swamp does not pass method inputs to them — so a check
guarding a method on a per-run flag rejects `--input` before `execute` runs, and
its error message then instructs the operator to do the thing it just made
impossible. The only way through becomes arming the flag permanently on the
model definition, which is the opposite of what the check was for.

Put the gate in `execute`, which sees both the input and the global argument.
Assert with a test that no check declares `appliesTo` for a gated method.

---

## 8. Testing

- **Mock the subprocess boundary, never the parser and never the quoting.** Use
  `withMockedCommand` from `@swamp-club/swamp-testing` so real argv
  construction, `shQuote`, storage-class injection, env-file assembly and
  parsing all execute. A test that stubs `shQuote` tests nothing, and `shQuote`
  is the single most security-relevant function in the suite.
- **The test harness must validate schemas.** A recording-only `writeResource`
  stub makes every schema bug invisible. Mandatory, not advisory — proven in the
  B2 suite by a revert that stayed green.
- **Build fixtures from live output, not from rclone's docs.** In particular
  `lsjson` field presence varies by backend and by flag combination, and
  `--stats-one-line-date` changes the stderr shape that progress parsing sees.
- **Test the paths that actually exist on volume1.** `/volume1/Resilio Sync` and
  the parenthesised filenames in the volume root are real, and are the reason
  §5.1 exists. A fixture using only `/volume1/media` never exercises the bug.
- **Check the test-run exit status, not the reported count.** A suite that
  aborts at type-check reports zero failures and looks identical to a pass.
- **Mutation-test every guard.** Delete the forbidden-subcommand set, the
  storage-class injection, the argv secret scan, the newline rejection in
  `buildEnvFile`, and `shQuote` in turn; each deletion must fail the suite. A
  green suite proves nothing until a mutation is shown to break it.

---

## 9. Verification and publish sequence

1. `deno check` and `deno test` — **confirm the exit status.**
2. `swamp extension fmt --check`
3. `swamp extension quality` ≥ 14/15
4. **Live smoke against a real path, with `--dry-run`, before anything uploads.**
   A dry-run `copy` against one small share proves the transport, the quoting,
   the credentials and the storage class without spending a cent or writing an
   object that will bill for 180 days.
5. Adversarial Review Gate, written to `reviews/` —
   `export SWAMP_EXTENSION_REVIEW_DIR="$PWD/reviews"`, because the default temp
   path is one cleanup away from vanishing.
6. **Re-run `push --dry-run` immediately before publishing.** The gate binds to
   a content hash; a "gate clean" carried forward from before the last fix is
   stale and will be rejected.
7. **Pre-publish secret audit.** Extract every real bucket, host and share name
   from live output; grep the tracked tree **and** the exact shipped-file list.
   `example-` prefixing is not sanitisation when the remainder is the real name.
   A force-push does not purge GitHub — old commits stay fetchable by SHA — so
   an identifier that reaches a public repo is not retractable.

The single most reliable finding across the two preceding suites: **live
verification beat mocks every time.** Budget for it. Here that means a
`--dry-run` against nas before the first real byte moves, because the first
real byte is also the first byte you are committed to paying 180 days for.
