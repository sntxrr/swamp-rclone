import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import { z } from "npm:zod@4";
import {
  ARCHIVE_STORAGE_CLASSES,
  buildDuScript,
  buildEnvFile,
  buildExtractScript,
  buildPackPlan,
  buildPackScript,
  buildRcloneInvocation,
  buildRemoteCommand,
  buildRestoreArgs,
  chooseStrategy,
  churnFraction,
  classifyFailure,
  DEFAULT_STORAGE_CLASS,
  destPath,
  ENV_FIFO_REF,
  escapeFilterPattern,
  excludeFlags,
  isInconclusive,
  isRestoreAlreadyInProgress,
  model,
  NEVER_ARCHIVE,
  normalisePrefix,
  OBJECT_OVERHEAD_BYTES,
  PACK_PART_BUDGET,
  parseDu,
  parseRestoreStatus,
  parseSize,
  planPackUpload,
  projectCost,
  RCLONE_EXIT,
  type RcloneResult,
  redactSecrets,
  ROOT_PACK_MEMBER,
  runRclone,
  S3_DEFAULT_CHUNK_BYTES,
  S3_MAX_UPLOAD_PARTS,
  S3_STORAGE_CLASSES,
  shQuote,
} from "./rclone_archive.ts";

const CREDS = {
  accessKeyId: "AKIATESTKEYIDEXAMPLE",
  secretAccessKey: "test-secret-access-key-not-a-real-one",
};

const DEST = {
  bucket: "example-archive-bucket",
  region: "us-west-2",
  storageClass: "DEEP_ARCHIVE",
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * A fake `ssh`. Tests exercise the REAL subprocess boundary — shQuote, the
 * remote command line, storage-class injection, env-file assembly on the stdin
 * pipe, exit codes and parsing all execute for real.
 *
 * The fake records argv and stdin to files so a test can assert on exactly
 * what would have crossed the wire. Stubbing shQuote would test nothing, and
 * shQuote is the most security-relevant function in the suite.
 */
async function fakeSsh(
  script: string,
): Promise<
  {
    path: string;
    argv: () => string[];
    stdin: () => string;
    cleanup: () => void;
  }
> {
  const dir = await Deno.makeTempDir({ prefix: "rclone-test-" });
  const path = `${dir}/ssh`;
  const argvFile = `${dir}/argv`;
  const stdinFile = `${dir}/stdin`;
  // clearEnv means the fake cannot receive paths through the environment, so
  // they are baked into the script text.
  await Deno.writeTextFile(
    path,
    `#!/bin/sh
: > ${argvFile}
for a in "$@"; do printf '%s\\n' "$a" >> ${argvFile}; done
cat > ${stdinFile}
${script}
`,
  );
  await Deno.chmod(path, 0o755);
  return {
    path,
    argv: () => {
      const raw = Deno.readTextFileSync(argvFile);
      return raw.length > 0 ? raw.replace(/\n$/, "").split("\n") : [];
    },
    stdin: () => Deno.readTextFileSync(stdinFile),
    cleanup: () => Deno.removeSync(dir, { recursive: true }),
  };
}

interface Written {
  spec: string;
  instance: string;
  data: Record<string, unknown>;
}

/**
 * An ExecuteContext whose writeResource VALIDATES against the real resource
 * schema. A recording-only stub makes every schema bug invisible — this is
 * mandatory per CONVENTIONS.md §8, not advisory.
 */
function testContext(globalArgs: Record<string, unknown>) {
  const written: Written[] = [];
  const logs: string[] = [];
  return {
    written,
    logs,
    context: {
      globalArgs: globalArgs as never,
      logger: {
        info: (m: string) => logs.push(m),
        warn: (m: string) => logs.push(m),
      },
      writeResource: (
        spec: string,
        instance: string,
        data: Record<string, unknown>,
      ) => {
        const resource =
          (model.resources as Record<string, { schema: z.ZodType }>)[spec];
        if (!resource) throw new Error(`unknown resource spec "${spec}"`);
        resource.schema.parse(data);
        written.push({ spec, instance, data });
        return Promise.resolve({ name: `${spec}/${instance}` });
      },
    },
  };
}

function baseArgs(sshBinary: string, extra: Record<string, unknown> = {}) {
  return {
    shareName: "homes",
    sourcePath: "/volume1/homes",
    sshHost: "nas.example.invalid",
    sshBinary,
    bucket: DEST.bucket,
    region: DEST.region,
    accessKeyId: CREDS.accessKeyId,
    secretAccessKey: CREDS.secretAccessKey,
    ...extra,
  };
}

function result(over: Partial<RcloneResult> = {}): RcloneResult {
  return {
    code: 0,
    stdout: "",
    stderr: "",
    durationMs: 1,
    timedOut: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// shQuote — these shapes all occur on a real Synology volume
// ---------------------------------------------------------------------------

Deno.test("shQuote survives a path containing a space", () => {
  assertEquals(shQuote("/volume1/Resilio Sync"), `'/volume1/Resilio Sync'`);
});

Deno.test("shQuote survives parentheses, which are sh syntax errors bare", () => {
  assertEquals(
    shQuote("/volume1/live-set(final mix).wav"),
    `'/volume1/live-set(final mix).wav'`,
  );
});

Deno.test("shQuote closes, escapes and reopens an embedded single quote", () => {
  assertEquals(shQuote("/volume1/don's files"), `'/volume1/don'\\''s files'`);
});

Deno.test("shQuote neutralises command substitution", () => {
  const quoted = shQuote("/volume1/$(touch /tmp/pwned)");
  assertEquals(quoted, `'/volume1/$(touch /tmp/pwned)'`);
  assert(!quoted.includes("`"));
});

Deno.test("a source path with a space reaches the remote as ONE word", async () => {
  const ssh = await fakeSsh(`echo '{"count":1,"bytes":2}'`);
  try {
    await runRclone(CREDS, DEST, {
      sshHost: "nas.example.invalid",
      sshBinary: ssh.path,
      sourceMount: "/volume1/Resilio Sync",
    }, ["size", "/data", "--json"]);
    const remote = ssh.argv().at(-1) ?? "";
    // The bind mount must appear as a single quoted word. Unquoted, `sh` on
    // the far side would split it and docker would see two arguments.
    assertStringIncludes(remote, `'/volume1/Resilio Sync:/data:ro'`);
  } finally {
    ssh.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The safety rule — copy, never sync
// ---------------------------------------------------------------------------

for (
  const sub of [
    "sync",
    "move",
    "moveto",
    "delete",
    "deletefile",
    "purge",
    "rmdir",
    "rmdirs",
    "cleanup",
  ]
) {
  Deno.test(`runRclone refuses "${sub}" — this suite never deletes`, async () => {
    await assertRejects(
      () =>
        runRclone(CREDS, DEST, {
          sshHost: "nas.example.invalid",
          sshBinary: "/bin/false",
          sourceMount: "/volume1/homes",
        }, [sub, "/data", "dest:bucket/x"]),
      Error,
      "never deletes",
    );
  });
}

Deno.test("runRclone permits copy", async () => {
  const ssh = await fakeSsh("exit 0");
  try {
    const r = await runRclone(CREDS, DEST, {
      sshHost: "nas.example.invalid",
      sshBinary: ssh.path,
      sourceMount: "/volume1/homes",
    }, ["copy", "/data", "dest:bucket/x"]);
    assertEquals(r.code, 0);
  } finally {
    ssh.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Storage class injection — forgetting it costs 23x, silently
// ---------------------------------------------------------------------------

Deno.test("the storage class is injected when absent", async () => {
  const ssh = await fakeSsh("exit 0");
  try {
    await runRclone(CREDS, DEST, {
      sshHost: "nas.example.invalid",
      sshBinary: ssh.path,
      sourceMount: "/volume1/homes",
    }, ["copy", "/data", "dest:bucket/x"]);
    const remote = ssh.argv().at(-1) ?? "";
    assertStringIncludes(remote, `'--s3-storage-class' 'DEEP_ARCHIVE'`);
  } finally {
    ssh.cleanup();
  }
});

Deno.test("an explicit storage class is not duplicated", async () => {
  const ssh = await fakeSsh("exit 0");
  try {
    await runRclone(CREDS, DEST, {
      sshHost: "nas.example.invalid",
      sshBinary: ssh.path,
      sourceMount: "/volume1/homes",
    }, ["copy", "/data", "dest:bucket/x", "--s3-storage-class", "GLACIER"]);
    const remote = ssh.argv().at(-1) ?? "";
    assertEquals(remote.split("--s3-storage-class").length - 1, 1);
  } finally {
    ssh.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

Deno.test("runRclone throws if a credential appears in args", async () => {
  await assertRejects(
    () =>
      runRclone(CREDS, DEST, {
        sshHost: "nas.example.invalid",
        sshBinary: "/bin/false",
        sourceMount: "/volume1/homes",
      }, ["copy", "/data", `dest:x?key=${CREDS.secretAccessKey}`]),
    Error,
    "world-readable via ps",
  );
});

Deno.test("no credential reaches the remote command line", async () => {
  const ssh = await fakeSsh("exit 0");
  try {
    await runRclone(CREDS, DEST, {
      sshHost: "nas.example.invalid",
      sshBinary: ssh.path,
      sourceMount: "/volume1/homes",
    }, ["copy", "/data", "dest:bucket/x"]);
    const joined = ssh.argv().join(" ");
    assert(!joined.includes(CREDS.secretAccessKey));
    assert(!joined.includes(CREDS.accessKeyId));
    // ...but it does reach the container, via the stdin env-file.
    assertStringIncludes(ssh.stdin(), CREDS.secretAccessKey);
    assertStringIncludes(ssh.argv().at(-1) ?? "", `'--env-file' "$ENVF"`);
  } finally {
    ssh.cleanup();
  }
});

Deno.test("buildEnvFile rejects a newline that docker would truncate", () => {
  let threw = false;
  try {
    buildEnvFile({ accessKeyId: "id", secretAccessKey: "a\nb" }, DEST);
  } catch (e) {
    threw = true;
    assertStringIncludes(String(e), "silently truncate");
  }
  assert(threw, "a newline in a credential must be rejected, not truncated");
});

Deno.test("buildEnvFile omits empty credentials entirely", () => {
  const body = buildEnvFile({ accessKeyId: "", secretAccessKey: "" }, DEST);
  assert(!body.includes("ACCESS_KEY_ID"));
  assert(!body.includes("SECRET_ACCESS_KEY"));
  assertStringIncludes(body, "RCLONE_CONFIG_DEST_STORAGE_CLASS=DEEP_ARCHIVE");
});

Deno.test("a source-only scan ships no credentials to the NAS", async () => {
  const ssh = await fakeSsh(`echo '{"count":10,"bytes":1000}'`);
  const { written, context } = testContext(baseArgs(ssh.path));
  try {
    await model.methods.scan.execute({}, context);
    assert(!ssh.stdin().includes(CREDS.secretAccessKey));
    assert(!ssh.stdin().includes(CREDS.accessKeyId));
    assertEquals(written.length, 1);
  } finally {
    ssh.cleanup();
  }
});

Deno.test("redactSecrets strips credentials from echoed stderr", () => {
  const text = `Failed to create file system: key ${CREDS.secretAccessKey} bad`;
  const out = redactSecrets(text, [CREDS.secretAccessKey]);
  assert(!out.includes(CREDS.secretAccessKey));
  assertStringIncludes(out, "[redacted]");
});

Deno.test("no credential appears in any written resource", async () => {
  const ssh = await fakeSsh(`echo '{"count":10,"bytes":10000000000}'`);
  const { written, context } = testContext(baseArgs(ssh.path));
  try {
    await model.methods.scan.execute({}, context);
    const dump = JSON.stringify(written);
    assert(!dump.includes(CREDS.secretAccessKey));
    assert(!dump.includes(CREDS.accessKeyId));
  } finally {
    ssh.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Parsing and classification
// ---------------------------------------------------------------------------

Deno.test("parseSize reads rclone size --json", () => {
  assertEquals(parseSize(`{"count":42,"bytes":123}`), {
    count: 42,
    bytes: 123,
  });
});

Deno.test("parseSize tolerates a warning printed ahead of the JSON", () => {
  const out = `NOTICE: config file not found\n{"count":7,"bytes":99}\n`;
  assertEquals(parseSize(out), { count: 7, bytes: 99 });
});

Deno.test("parseSize returns null rather than throwing on junk", () => {
  assertEquals(parseSize("not json at all"), null);
  assertEquals(parseSize(""), null);
});

Deno.test("retry, transfer and duration limits are inconclusive, not failures", () => {
  assert(isInconclusive(result({ code: RCLONE_EXIT.TEMPORARY })));
  assert(isInconclusive(result({ code: RCLONE_EXIT.TRANSFER_LIMIT })));
  assert(isInconclusive(result({ code: RCLONE_EXIT.DURATION_LIMIT })));
  assert(isInconclusive(result({ timedOut: true })));
});

Deno.test("genuine errors are not inconclusive", () => {
  assert(!isInconclusive(result({ code: RCLONE_EXIT.FATAL })));
  assert(!isInconclusive(result({ code: RCLONE_EXIT.DIR_NOT_FOUND })));
  assert(!isInconclusive(result({ code: RCLONE_EXIT.OK })));
});

Deno.test("classifyFailure names the codes that matter", () => {
  assertEquals(
    classifyFailure(result({ code: RCLONE_EXIT.DIR_NOT_FOUND })),
    "source-not-found",
  );
  assertEquals(
    classifyFailure(result({ code: RCLONE_EXIT.TEMPORARY })),
    "retries-exhausted",
  );
  assertEquals(classifyFailure(result({ timedOut: true })), "timeout");
});

// ---------------------------------------------------------------------------
// Cost and strategy
// ---------------------------------------------------------------------------

Deno.test("small mean file size chooses pack", () => {
  // 500k files averaging 200 KB.
  assertEquals(
    chooseStrategy(500_000, 500_000 * 200 * 1024, 1024 * 1024),
    "pack",
  );
});

Deno.test("large mean file size chooses direct", () => {
  // media-library: ~30k files averaging >100 MB.
  assertEquals(chooseStrategy(30_000, 3.76e12, 1024 * 1024), "direct");
});

Deno.test("an empty share does not divide by zero", () => {
  assertEquals(chooseStrategy(0, 0, 1024 * 1024), "direct");
});

Deno.test("packing collapses object count, and with it the overhead", () => {
  const bytes = 2.7e12; // homes
  const direct = projectCost(4_000_000, bytes, "direct", 1024 ** 3);
  const packed = projectCost(4_000_000, bytes, "pack", 1024 ** 3);
  assertEquals(direct.objectCount, 4_000_000);
  assert(packed.objectCount < 3000, "1 GiB packs over 2.7 TB");
  assert(
    packed.overheadUsdPerMonth < direct.overheadUsdPerMonth / 100,
    "packing must remove most of the per-object overhead",
  );
  assert(packed.uploadUsd < direct.uploadUsd);
});

Deno.test("egress dominates retrieval, which is the point of reporting it", () => {
  const c = projectCost(1000, 3.2e12, "direct", 1024 ** 3);
  assert(c.egressUsd > c.retrievalUsd * 10);
  assert(c.egressUsd > c.storageUsdPerMonth * 50);
});

Deno.test("the per-object overhead constant is the documented 40 KB", () => {
  assertEquals(OBJECT_OVERHEAD_BYTES, 40 * 1024);
});

Deno.test("churn is null on a first scan and a fraction thereafter", () => {
  assertEquals(churnFraction(null, 100), null);
  assertEquals(churnFraction(0, 100), null);
  assertEquals(churnFraction(100, 120), 0.2);
  assertEquals(churnFraction(100, 80), 0.2);
});

Deno.test("destPath builds a remote spec with and without a prefix", () => {
  assertEquals(destPath("b", "", "homes"), "dest:b/homes");
  assertEquals(
    destPath("b", "nas/volume1", "homes"),
    "dest:b/nas/volume1/homes",
  );
  assertEquals(destPath("b", "/nas/", "homes"), "dest:b/nas/homes");
  assertEquals(normalisePrefix("//a/b//"), "a/b");
});

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

Deno.test("scan records an unreachable share instead of throwing", async () => {
  const ssh = await fakeSsh("exit 3");
  const { written, context } = testContext(baseArgs(ssh.path));
  try {
    await model.methods.scan.execute({}, context);
    assertEquals(written.length, 1);
    assertEquals(written[0].data.reachable, false);
    assertEquals(written[0].data.failureReason, "source-not-found");
  } finally {
    ssh.cleanup();
  }
});

Deno.test("scan projects cost and raises a churn warning", async () => {
  const ssh = await fakeSsh(`echo '{"count":157000,"bytes":1260000000000}'`);
  const { written, context } = testContext(
    baseArgs(ssh.path, { shareName: "mac-backups" }),
  );
  try {
    // sparsebundle bands: high churn against a 180-day minimum.
    await model.methods.scan.execute(
      { previousBytes: 1_000_000_000_000 },
      context,
    );
    const d = written[0].data as Record<string, number | boolean>;
    assertEquals(d.churnWarning, true);
    assert((d.storageUsdPerMonth as number) > 1);
    assert((d.egressUsd as number) > (d.retrievalUsd as number));
  } finally {
    ssh.cleanup();
  }
});

Deno.test("push records exit 9 as nothing-to-transfer, not as a failure", async () => {
  const ssh = await fakeSsh("exit 9");
  // strategy pinned: this asserts the DIRECT copy path, and must not depend on
  // what an auto measurement would have chosen.
  const { written, context } = testContext(
    baseArgs(ssh.path, { strategy: "direct" }),
  );
  try {
    await model.methods.push.execute({}, context);
    const d = written[0].data as Record<string, unknown>;
    assertEquals(d.nothingToTransfer, true);
    assertEquals(d.passed, true);
    assertEquals(d.failureReason, null);
  } finally {
    ssh.cleanup();
  }
});

Deno.test("push asks for exit 9 — without the flag it cannot tell", async () => {
  const ssh = await fakeSsh("exit 0");
  const { context } = testContext(
    baseArgs(ssh.path, { strategy: "direct" }),
  );
  try {
    await model.methods.push.execute({}, context);
    assertStringIncludes(ssh.argv().at(-1) ?? "", "--error-on-no-transfer");
  } finally {
    ssh.cleanup();
  }
});

Deno.test("push copies and never syncs", async () => {
  const ssh = await fakeSsh("exit 0");
  const { context } = testContext(
    baseArgs(ssh.path, { strategy: "direct" }),
  );
  try {
    await model.methods.push.execute({}, context);
    const remote = ssh.argv().at(-1) ?? "";
    assertStringIncludes(remote, "'copy'");
    assert(!remote.includes("'sync'"));
    assertStringIncludes(remote, "'--immutable'");
  } finally {
    ssh.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

Deno.test("parseDu splits on the first tab, not on whitespace", () => {
  // volume1 really does contain directory names with spaces.
  const out = parseDu("12\t/data/Resilio Sync\n4096\t/data/homes\n");
  assertEquals(out, [
    { name: "Resilio Sync", bytes: 12 * 1024 },
    { name: "homes", bytes: 4096 * 1024 },
  ]);
});

Deno.test("parseDu ignores lines that are not du output", () => {
  assertEquals(parseDu("du: cannot read\n\nrubbish\n"), []);
});

Deno.test("a pack plan is one pack per top-level entry, sorted", () => {
  const plan = buildPackPlan(
    [
      { name: "zeta", bytes: 3 },
      { name: "alpha", bytes: 1 },
      { name: "mid", bytes: 2 },
    ],
    0,
  );
  assertEquals(plan.map((p) => p.name), ["alpha", "mid", "zeta"]);
  assertEquals(plan.map((p) => p.member), ["alpha", "mid", "zeta"]);
});

Deno.test("pack boundaries do NOT shift when a directory grows", () => {
  // The whole point of refusing size-based grouping: an archive whose object
  // names move when data changes re-uploads everything and pays a fresh
  // 180-day minimum on each replaced object.
  const before = buildPackPlan(
    [{ name: "a", bytes: 10 }, { name: "b", bytes: 10 }, {
      name: "c",
      bytes: 10,
    }],
    0,
  );
  const after = buildPackPlan(
    [
      { name: "a", bytes: 10 },
      { name: "b", bytes: 900_000_000_000 },
      { name: "c", bytes: 10 },
    ],
    0,
  );
  assertEquals(before.map((p) => p.name), after.map((p) => p.name));
});

Deno.test("loose files in the share root become a single _root pack", () => {
  const plan = buildPackPlan([{ name: "homes", bytes: 5 }], 1234);
  assertEquals(plan.length, 2);
  const root = plan.find((p) => p.name === "_root");
  assert(root, "_root pack must exist when loose files are present");
  assertEquals(root?.member, ".");
});

Deno.test("no _root pack is created when the share root has no loose files", () => {
  assertEquals(buildPackPlan([{ name: "homes", bytes: 5 }], 0).length, 1);
});

Deno.test("parseDu KEEPS '.', or the _root pack is unreachable", () => {
  // Regression. The sizing script reports the loose-file total as `/data/.`;
  // parseDu used to map that to "." and then drop it by its own guard, so
  // looseFileBytes was permanently 0 and buildPackPlan never emitted _root.
  // The loose files were still archived — but one S3 object EACH, which is
  // precisely the per-object overhead the pack strategy exists to avoid.
  const out = parseDu("500\t/data/docs/\n2\t/data/.\n");
  const loose = out.find((e) => e.name === ".");
  assert(loose, "the loose-file total must survive parseDu");
  assertEquals(loose?.bytes, 2 * 1024);
});

Deno.test("parseDu strips the trailing slash the directory glob produces", () => {
  // The script globs `/data/*/` to get directories ONLY, so du echoes a
  // trailing slash. Left on, the name fails to match NEVER_ARCHIVE and lands
  // in the object name as `homes/.tar`.
  assertEquals(parseDu("4096\t/data/homes/\n"), [
    { name: "homes", bytes: 4096 * 1024 },
  ]);
  assertEquals(parseDu("12\t/data/Resilio Sync/\n")[0].name, "Resilio Sync");
});

Deno.test("the sizing script globs directories only, never bare /data/*", () => {
  // With the bare glob a loose root file is reported as its own entry, becomes
  // its own single-file pack, AND is counted again inside _root.
  const script = buildDuScript();
  assertStringIncludes(script, "for d in /data/*/; do");
  assertEquals(script.includes("du -skb /data/* "), false);
});

Deno.test("the sizing script subtracts every NEVER_ARCHIVE name", () => {
  // du has no exclude in busybox, so the only way sizing can agree with what
  // tar streams is to measure the entry and subtract the excluded subtrees.
  const script = buildDuScript();
  for (const name of NEVER_ARCHIVE) {
    assertStringIncludes(script, `-name '${name}'`);
  }
  // -prune, or find descends into an excluded tree and double-counts nested
  // copies of the same directory name.
  assertStringIncludes(script, "-type d -prune");
  // Never let a subtraction drive the estimate negative.
  assertStringIncludes(script, '[ "$n" -lt 0 ] && n=0');
});

Deno.test("the loose-file total rounds UP, so small files still get a _root pack", () => {
  // `du -skb` reports 0 for anything under 1024 bytes. A 0 here means no
  // _root pack, and a share root of nothing but small files loses them.
  const script = buildDuScript();
  assertStringIncludes(script, "k=int((s+1023)/1024); if (k<1) k=1");
});

Deno.test("the _root pack does NOT tar the whole share", () => {
  // The expensive bug. `tar -cf - .` archives every directory that already has
  // a pack of its own, so _root.tar is a second full copy of the share: it
  // either succeeds and stores the share twice at Deep Archive's 180-day
  // minimum, or — because _root is sized from the loose-file total — picks
  // chunks for a few KiB and dies at part 10 000 having moved terabytes.
  const script = buildPackScript(
    ROOT_PACK_MEMBER,
    "dest:b/x/_root.tar",
    "DEEP_ARCHIVE",
    smallUpload(),
  );
  assertStringIncludes(script, "--no-recursion");
  assertStringIncludes(script, "./*");
  assertEquals(script.includes("-cf - '.'"), false);
  // The cd is not interchangeable with -C: -C positions tar, but the glob is
  // expanded by the SHELL, so with -C alone `./*` expands in the wrong place
  // and tar reports "./*: No such file or directory".
  assertStringIncludes(script, "cd /data && tar");
});

Deno.test("a normal pack still tars its member, not the share root", () => {
  const script = buildPackScript(
    "homes",
    "dest:b/x/homes.tar",
    "DEEP_ARCHIVE",
    smallUpload(),
  );
  assertStringIncludes(script, "tar -C /data ");
  assertStringIncludes(script, "-cf - 'homes'");
  assertEquals(script.includes("--no-recursion"), false);
});

/** A streamable plan for a small pack, for tests that do not care about size. */
function smallUpload() {
  const plan = planPackUpload(1024);
  if (!plan.streamable) throw new Error("fixture should be streamable");
  return plan;
}

Deno.test("the recycle bin and @eaDir are excluded, unanchored so they match at any depth", () => {
  const flags = excludeFlags();
  assertEquals(flags, [
    "--exclude",
    "#recycle/**",
    "--exclude",
    "@eaDir/**",
  ]);
  // Unanchored on purpose: a nested recycle bin is exactly as unwanted as a
  // top-level one. This is the opposite of buildRestoreArgs, where a loose
  // filter would retrieve and bill for every same-named object in the share.
  // For @eaDir it is not defence but necessity — DSM writes one beside every
  // indexed directory, so an anchored filter would match none of them.
  for (const f of flags.filter((_, i) => i % 2 === 1)) {
    assertEquals(f.startsWith("/"), false);
  }
});

Deno.test("a recycle bin never becomes its own pack", () => {
  // Without this the share's deleted files are tarred into an object of their
  // own and billed for Deep Archive's 180-day minimum.
  const plan = buildPackPlan(
    [
      { name: "#recycle", bytes: 236_522_059_000 },
      { name: "sntxrr.sparsebundle", bytes: 955_334_650_000 },
    ],
    0,
  );
  assertEquals(plan.map((p) => p.name), ["sntxrr.sparsebundle"]);
});

Deno.test("the pack script excludes the recycle bin from the tar itself", () => {
  const script = buildPackScript(
    "homes",
    "dest:b/x/homes.tar",
    "DEEP_ARCHIVE",
    smallUpload(),
  );
  assertStringIncludes(script, "--exclude '#recycle'");
  assertStringIncludes(script, "--exclude '@eaDir'");
  // Unlike the rclone filters these carry no `/**` — tar matches a bare name
  // at any depth, and `@eaDir/**` would match nothing.
  assertEquals(script.includes("'@eaDir/**'"), false);
  // Before the member, or tar treats it as a file to add rather than a filter.
  assertEquals(script.indexOf("--exclude") < script.indexOf("-cf -"), true);
  // The flag itself is not quoted — the operator copies this command by hand.
  assertEquals(script.includes("'--exclude'"), false);
});

Deno.test("the pack script sets pipefail — without it a broken tar uploads truncated", () => {
  const script = buildPackScript(
    "homes",
    "dest:b/x/homes.tar",
    "DEEP_ARCHIVE",
    smallUpload(),
  );
  assertStringIncludes(script, "set -o pipefail");
  // Without pipefail the exit status is rclone's alone, so a tar that dies
  // halfway still exits 0 and the truncated stream is stored as complete.
  assertStringIncludes(script, "tar -C /data");
  assertStringIncludes(script, "rclone rcat");
  assertStringIncludes(script, "--s3-storage-class");
});

Deno.test("the pack script quotes a member name containing a space", () => {
  const script = buildPackScript(
    "Resilio Sync",
    "dest:b/x/a.tar",
    "GLACIER",
    smallUpload(),
  );
  assertStringIncludes(script, `'Resilio Sync'`);
});

Deno.test("the pack script names a chunk size — a streamed tar never auto-scales", () => {
  // rclone only grows the chunk size for a file whose size it knows. A pack
  // arrives on stdin, so without an explicit --s3-chunk-size it uses 5 MiB and
  // dies at 10 000 parts = 48 GiB.
  const script = buildPackScript(
    "homes",
    "dest:b/x/homes.tar",
    "DEEP_ARCHIVE",
    smallUpload(),
  );
  assertStringIncludes(script, "--s3-chunk-size");
  assertStringIncludes(script, "--s3-upload-concurrency");
});

Deno.test("a pack inside the default chunk's reach is left at rclone's default", () => {
  // The part budget, not the 10 000-part limit, sets where scaling begins:
  // 8 000 x 5 MiB = 39.06 GiB.
  const plan = planPackUpload(30 * 1024 ** 3);
  assertEquals(plan.streamable, true);
  if (plan.streamable) assertEquals(plan.chunkBytes, S3_DEFAULT_CHUNK_BYTES);
});

Deno.test("a pack just past the default chunk's reach scales up", () => {
  const justOver = planPackUpload(40 * 1024 ** 3);
  assertEquals(justOver.streamable, true);
  if (justOver.streamable) {
    assertEquals(justOver.chunkBytes > S3_DEFAULT_CHUNK_BYTES, true);
  }
});

Deno.test("the 912 GiB Time Machine sparsebundle gets a chunk size that fits in 10 000 parts", () => {
  // The regression this guard exists for. At the default 5 MiB chunk this pack
  // needs 186 778 parts and dies ~48 GiB in.
  const bytes = 912 * 1024 ** 3;
  const plan = planPackUpload(bytes);
  assertEquals(plan.streamable, true);
  if (!plan.streamable) return;
  assertEquals(Math.ceil(bytes / plan.chunkBytes) <= S3_MAX_UPLOAD_PARTS, true);
  // And with 20% of the part budget still unspent, for tar's overhead.
  assertEquals(Math.ceil(bytes / plan.chunkBytes) <= PACK_PART_BUDGET, true);
});

Deno.test("concurrency is spent before a pack is refused", () => {
  // A 2 TiB pack needs a 256 MiB chunk. Four in flight is 1 GiB, which fits a
  // 1 GiB budget exactly; a 300 MiB budget must buy the pack by dropping to
  // one in-flight chunk rather than refusing it.
  const bytes = 2 * 1024 ** 4;
  const tight = planPackUpload(bytes, 300 * 1024 * 1024);
  assertEquals(tight.streamable, true);
  if (tight.streamable) assertEquals(tight.uploadConcurrency, 1);
});

Deno.test("a pack whose single chunk exceeds the memory budget is refused at plan time", () => {
  // Refused BEFORE any bytes move — the alternative is discovering it at part
  // 10 000, terabytes into a multipart upload that can never complete.
  const plan = planPackUpload(4 * 1024 ** 4, 64 * 1024 * 1024);
  assertEquals(plan.streamable, false);
  if (!plan.streamable) assertStringIncludes(plan.reason, "memory budget");
});

Deno.test("a pack above S3's 5 TiB single-object limit is refused whatever the budget", () => {
  const plan = planPackUpload(6 * 1024 ** 4, 1024 ** 4);
  assertEquals(plan.streamable, false);
  if (!plan.streamable) assertStringIncludes(plan.reason, "5 TiB");
});

Deno.test("a shell-entrypoint write without the storage class is refused", async () => {
  // Appending the flag here would make it a positional parameter of `sh`,
  // which rclone never sees — the silent 23x mistake wearing the guard's
  // own clothes.
  await assertRejects(
    () =>
      runRclone(CREDS, DEST, {
        sshHost: "nas.example.invalid",
        sshBinary: "/bin/false",
        sourceMount: "/volume1/homes",
        entrypoint: "sh",
      }, ["-c", "tar -cf - . | rclone rcat dest:b/x.tar"]),
    Error,
    "--s3-storage-class",
  );
});

Deno.test("a shell-entrypoint write without --s3-no-check-bucket is refused", async () => {
  // rclone otherwise tries to CREATE the bucket, and the archive's IAM user
  // deliberately cannot. That is not theoretical: the entire pack strategy
  // failed 403 AccessDenied on CreateBucket the first time it ran against S3,
  // while the direct copy path never triggered it. Refusing at plan time beats
  // discovering it partway through a multi-terabyte tar stream.
  await assertRejects(
    () =>
      runRclone(CREDS, DEST, {
        sshHost: "nas.example.invalid",
        sshBinary: "/bin/false",
        sourceMount: "/volume1/homes",
        entrypoint: "sh",
      }, [
        "-c",
        "tar -cf - . | rclone rcat dest:b/x.tar --s3-storage-class DEEP_ARCHIVE",
      ]),
    Error,
    "--s3-no-check-bucket",
  );
});

Deno.test("an ordinary argv invocation gets --s3-no-check-bucket injected", () => {
  const { remote } = buildRcloneInvocation(
    SEED_CREDS,
    SEED_DEST,
    SEED_TRANSPORT,
    ["copy", "/data", "dest:example-bucket/x"],
  );
  assertStringIncludes(remote, "--s3-no-check-bucket");
});

Deno.test("the pack script names --s3-no-check-bucket inside the script", () => {
  // Inside, not appended: appended it would be a positional parameter of `sh`.
  const script = buildPackScript(
    "member",
    "dest:example-bucket/x/member.tar",
    "DEEP_ARCHIVE",
    smallUpload(),
  );
  assertStringIncludes(script, "--s3-no-check-bucket");
});

Deno.test("a source-only shell invocation needs no storage class", async () => {
  // No credentials means rclone cannot reach S3 at all, so there is no class
  // to name. The exemption keys on credentials, not on a caller's assertion.
  const ssh = await fakeSsh(`echo '4\t/data/homes'`);
  try {
    const r = await runRclone(
      { accessKeyId: "", secretAccessKey: "" },
      DEST,
      {
        sshHost: "nas.example.invalid",
        sshBinary: ssh.path,
        sourceMount: "/volume1/homes",
        entrypoint: "sh",
      },
      ["-c", "du -sk /data/*"],
    );
    assertEquals(r.code, 0);
  } finally {
    ssh.cleanup();
  }
});

Deno.test("push in pack mode skips packs whose object already exists", async () => {
  // du lists one entry; lsjson then reports the object present.
  const ssh = await fakeSsh(
    `case "$*" in
  *"du -sk"*) echo '4\t/data/homes'; echo '0\t/data/.' ;;
  *lsjson*) echo '[{"Path":"homes.tar","Size":1}]' ;;
  *) exit 0 ;;
esac`,
  );
  const { written, context } = testContext(
    baseArgs(ssh.path, { strategy: "pack" }),
  );
  try {
    await model.methods.push.execute({}, context);
    const d = written[0].data as Record<string, unknown>;
    assertEquals(d.strategy, "pack");
    assertEquals(d.packsPlanned, 1);
    assertEquals(d.packsSkipped, 1);
    assertEquals(d.packsUploaded, 0);
    assertEquals(d.passed, true);
  } finally {
    ssh.cleanup();
  }
});

Deno.test("push in pack mode uploads a pack that does not yet exist", async () => {
  const ssh = await fakeSsh(
    `case "$*" in
  *"du -sk"*) echo '4\t/data/homes'; echo '0\t/data/.' ;;
  *lsjson*) echo '[]' ;;
  *) exit 0 ;;
esac`,
  );
  const { written, context } = testContext(
    baseArgs(ssh.path, { strategy: "pack" }),
  );
  try {
    await model.methods.push.execute({}, context);
    const d = written[0].data as Record<string, unknown>;
    assertEquals(d.packsUploaded, 1);
    assertEquals(d.packsSkipped, 0);
    assertEquals(d.passed, true);
  } finally {
    ssh.cleanup();
  }
});

Deno.test("push in pack mode records which packs failed, not just that one did", async () => {
  const ssh = await fakeSsh(
    `case "$*" in
  *"du -sk"*) echo '4\t/data/homes'; echo '0\t/data/.' ;;
  *lsjson*) echo '[]' ;;
  *) echo "tar: read error" >&2; exit 2 ;;
esac`,
  );
  const { written, context } = testContext(
    baseArgs(ssh.path, { strategy: "pack" }),
  );
  try {
    await model.methods.push.execute({}, context);
    const d = written[0].data as Record<string, unknown>;
    assertEquals(d.passed, false);
    assertEquals(d.packsFailed, 1);
    assertEquals(d.failedPacks, ["homes"]);
    assertEquals(d.failureReason, "pack-failed");
  } finally {
    ssh.cleanup();
  }
});

Deno.test("push in pack dry-run mode uploads nothing", async () => {
  const ssh = await fakeSsh(
    `case "$*" in
  *"du -sk"*) echo '4\t/data/homes'; echo '0\t/data/.' ;;
  *lsjson*) echo '[]' ;;
  *rcat*) echo "SHOULD NOT RUN" >&2; exit 1 ;;
  *) exit 0 ;;
esac`,
  );
  const { written, context } = testContext(
    baseArgs(ssh.path, { strategy: "pack" }),
  );
  try {
    await model.methods.push.execute({ dryRun: true }, context);
    const d = written[0].data as Record<string, unknown>;
    assertEquals(d.dryRun, true);
    assertEquals(d.passed, true);
  } finally {
    ssh.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Cadence: --no-traverse is a cost trap without a window
// ---------------------------------------------------------------------------

Deno.test("a full push traverses rather than HEADing every file", async () => {
  // Without a window, --no-traverse would issue one HEAD per source file —
  // ~80x the cost of one destination listing, and ~$1,460/mo at hourly
  // against ~$18/mo. So no window means no --no-traverse.
  const ssh = await fakeSsh("exit 0");
  const { context } = testContext(baseArgs(ssh.path));
  try {
    await model.methods.push.execute({}, context);
    const remote = ssh.argv().at(-1) ?? "";
    assert(
      !remote.includes("--no-traverse"),
      "--no-traverse must not appear without a --max-age window",
    );
    assert(!remote.includes("--max-age"));
  } finally {
    ssh.cleanup();
  }
});

Deno.test("a windowed push enables --no-traverse, and only then", async () => {
  const ssh = await fakeSsh("exit 0");
  const { context } = testContext(
    baseArgs(ssh.path, { strategy: "direct" }),
  );
  try {
    await model.methods.push.execute({ maxAgeMinutes: 120 }, context);
    const remote = ssh.argv().at(-1) ?? "";
    assertStringIncludes(remote, "'--max-age' '120m'");
    assertStringIncludes(remote, "--no-traverse");
  } finally {
    ssh.cleanup();
  }
});

Deno.test("the window can be set on the model, not just per run", async () => {
  const ssh = await fakeSsh("exit 0");
  const { context } = testContext(
    baseArgs(ssh.path, { maxAgeMinutes: 90, strategy: "direct" }),
  );
  try {
    await model.methods.push.execute({}, context);
    assertStringIncludes(ssh.argv().at(-1) ?? "", "'--max-age' '90m'");
  } finally {
    ssh.cleanup();
  }
});

Deno.test("--immutable is on by default and removable only deliberately", async () => {
  const ssh = await fakeSsh("exit 0");
  const { context } = testContext(
    baseArgs(ssh.path, { strategy: "direct" }),
  );
  try {
    await model.methods.push.execute({}, context);
    assertStringIncludes(ssh.argv().at(-1) ?? "", "--immutable");

    await model.methods.push.execute({ allowOverwrite: true }, context);
    assert(
      !(ssh.argv().at(-1) ?? "").includes("--immutable"),
      "allowOverwrite must drop --immutable",
    );
  } finally {
    ssh.cleanup();
  }
});

Deno.test("push marks a transfer cap inconclusive rather than failed", async () => {
  const ssh = await fakeSsh("exit 8");
  const { written, context } = testContext(baseArgs(ssh.path));
  try {
    await model.methods.push.execute({ maxTransferBytes: 1024 }, context);
    const d = written[0].data as Record<string, unknown>;
    assertEquals(d.inconclusive, true);
    assertEquals(d.passed, false);
  } finally {
    ssh.cleanup();
  }
});

Deno.test("verify never claims to have checked content", async () => {
  const ssh = await fakeSsh(`echo '{"count":10,"bytes":1000}'`);
  const { written, context } = testContext(baseArgs(ssh.path));
  try {
    await model.methods.verify.execute({}, context);
    assertEquals(written[0].data.contentVerified, false);
    assertEquals(written[0].data.passed, true);
  } finally {
    ssh.cleanup();
  }
});

Deno.test("verify fails when the destination is short", async () => {
  // Source reports 1000 bytes, destination 10 — the second call wins.
  const ssh = await fakeSsh(
    `if grep -q "dest:" ${"$"}{0}.unused 2>/dev/null; then :; fi
if [ -f /tmp/.rclone-test-seen ]; then echo '{"count":1,"bytes":10}'; rm -f /tmp/.rclone-test-seen; else touch /tmp/.rclone-test-seen; echo '{"count":10,"bytes":1000}'; fi`,
  );
  const { written, context } = testContext(baseArgs(ssh.path));
  try {
    await model.methods.verify.execute({}, context);
    const d = written[0].data as Record<string, unknown>;
    assertEquals(d.passed, false);
    assertEquals(d.failureReason, "destination-short");
  } finally {
    try {
      Deno.removeSync("/tmp/.rclone-test-seen");
    } catch { /* already consumed */ }
    ssh.cleanup();
  }
});

Deno.test("restoreRequest refuses to spend money without acknowledgement", async () => {
  const ssh = await fakeSsh("exit 0");
  const { context } = testContext(baseArgs(ssh.path));
  try {
    await assertRejects(
      () =>
        model.methods.restoreRequest.execute(
          { objectPath: "a/b.tar" },
          context,
        ),
      Error,
      "allowRestore=true",
    );
  } finally {
    ssh.cleanup();
  }
});

Deno.test("restoreRequest proceeds with a per-run acknowledgement", async () => {
  // rclone reports the per-object outcome in JSON on stdout; a bare `exit 0`
  // means it restored NOTHING, which is a failure — see the next test.
  const ssh = await fakeSsh(
    `echo '[{ "Status": "OK", "Remote": "b.tar" }]'`,
  );
  const { written, context } = testContext(baseArgs(ssh.path));
  try {
    await model.methods.restoreRequest.execute(
      { objectPath: "a/b.tar", allowRestore: true },
      context,
    );
    assertEquals(written[0].data.phase, "requested");
    assertEquals(written[0].data.tier, "Bulk");
    assertEquals(written[0].data.passed, true);
  } finally {
    ssh.cleanup();
  }
});

Deno.test("a clean exit that restored NOTHING is recorded as a failure", async () => {
  // The shape of a typo'd objectPath: rclone exits 0 having matched nothing.
  // Recorded as success, this surfaces as a drill that cannot pass, hours later.
  const ssh = await fakeSsh("exit 0");
  const { written, context } = testContext(baseArgs(ssh.path));
  try {
    await model.methods.restoreRequest.execute(
      { objectPath: "a/typo.tar", allowRestore: true },
      context,
    );
    assertEquals(written[0].data.phase, "failed");
    assertEquals(written[0].data.passed, false);
    assertEquals(written[0].data.failureReason, "no-object-matched");
    assertStringIncludes(
      String(written[0].data.detail),
      "path is almost certainly wrong",
    );
  } finally {
    ssh.cleanup();
  }
});

Deno.test("re-requesting an in-flight restore is idempotent, not a failure", async () => {
  const ssh = await fakeSsh(
    `echo '[{ "Status": "operation error S3: RestoreObject, api error RestoreAlreadyInProgress: Object restore is already in progress", "Remote": "b.tar" }]'`,
  );
  const { written, context } = testContext(baseArgs(ssh.path));
  try {
    await model.methods.restoreRequest.execute(
      { objectPath: "a/b.tar", allowRestore: true },
      context,
    );
    assertEquals(written[0].data.passed, true);
    assertEquals(written[0].data.phase, "requested");
  } finally {
    ssh.cleanup();
  }
});

Deno.test("a rejected per-object restore fails despite rclone exiting 0", async () => {
  const ssh = await fakeSsh(
    `echo '[{ "Status": "operation error S3: RestoreObject, api error AccessDenied", "Remote": "b.tar" }]'`,
  );
  const { written, context } = testContext(baseArgs(ssh.path));
  try {
    await model.methods.restoreRequest.execute(
      { objectPath: "a/b.tar", allowRestore: true },
      context,
    );
    assertEquals(written[0].data.passed, false);
    assertEquals(written[0].data.failureReason, "restore-rejected");
    assertStringIncludes(String(written[0].data.detail), "AccessDenied");
  } finally {
    ssh.cleanup();
  }
});

Deno.test("restoreDrill reports a still-retrieving object as pending", async () => {
  const ssh = await fakeSsh(
    `echo "InvalidObjectState: the object is in Deep Archive" >&2; exit 2`,
  );
  const { written, context } = testContext(baseArgs(ssh.path));
  try {
    await model.methods.restoreDrill.execute(
      { objectPath: "a/b.tar" },
      context,
    );
    assertEquals(written[0].data.phase, "pending");
    assertEquals(written[0].data.passed, false);
  } finally {
    ssh.cleanup();
  }
});

Deno.test("the extract script sets pipefail — a missing member must not hash empty", () => {
  const s = buildExtractScript(
    "dest:b/x/homes.tar",
    "homes/don/notes.txt",
    "GLACIER",
  );
  assertStringIncludes(s, "set -o pipefail");
  // Without pipefail, tar failing on a missing member still lets sha256sum
  // exit 0 having hashed nothing — a green drill for absent data.
  assertStringIncludes(s, "tar -xOf -");
  assertStringIncludes(s, "sha256sum");
  assertStringIncludes(s, `'homes/don/notes.txt'`);
});

Deno.test("restoreDrill on a pack extracts one member, proving it unpacks", async () => {
  const ssh = await fakeSsh(
    `case "$*" in
  *"size"*) echo '{"count":1,"bytes":100}' ;;
  *) echo "deadbeef  -" ;;
esac`,
  );
  const { written, context } = testContext(baseArgs(ssh.path));
  try {
    await model.methods.restoreDrill.execute(
      {
        objectPath: "homes.tar",
        member: "homes/don/notes.txt",
        sourceSha256: "deadbeef",
      },
      context,
    );
    const d = written[0].data as Record<string, unknown>;
    assertEquals(d.phase, "restored");
    assertEquals(d.contentMatched, true);
    assertEquals(d.passed, true);
    // The extraction must actually have gone through tar, not hashed the pack.
    assertStringIncludes(ssh.argv().at(-1) ?? "", "tar -xOf -");
  } finally {
    ssh.cleanup();
  }
});

Deno.test("restoreDrill fails loudly on a content mismatch", async () => {
  const ssh = await fakeSsh(
    `case "$*" in
  *"size"*) echo '{"count":1,"bytes":100}' ;;
  *) echo "0000000  -" ;;
esac`,
  );
  const { written, context } = testContext(baseArgs(ssh.path));
  try {
    await model.methods.restoreDrill.execute(
      { objectPath: "a.tar", sourceSha256: "deadbeef" },
      context,
    );
    const d = written[0].data as Record<string, unknown>;
    assertEquals(d.contentMatched, false);
    assertEquals(d.passed, false);
    assertEquals(d.failureReason, "content-mismatch");
  } finally {
    ssh.cleanup();
  }
});

Deno.test("restoreDrill on an unpacked object hashes with hashsum, and DOWNLOADS", async () => {
  // Two failures this pins down, both found on the first live retrieval:
  //
  // rclone has dedicated md5sum and sha1sum commands but NO sha256sum, so the
  // symmetrical spelling exits 2 with `unknown command`. Nothing in the suite
  // caught it because no test asserted what the direct path actually runs.
  //
  // And --download is the difference between a drill and a formality: without
  // it rclone asks the remote for the hash, S3 does not serve SHA-256, and no
  // byte ever leaves Glacier.
  const ssh = await fakeSsh(
    `case "$*" in
  *"size"*) echo '{"count":1,"bytes":100}' ;;
  *) echo "abc123  x" ;;
esac`,
  );
  const { context } = testContext(baseArgs(ssh.path));
  try {
    await model.methods.restoreDrill.execute(
      { objectPath: "a/sample.bin", sourceSha256: "abc123" },
      context,
    );
    const remote = ssh.argv().at(-1) ?? "";
    // Every word is shQuoted, so assert on the quoted form the shell sees.
    assertStringIncludes(remote, "'hashsum' 'sha256'");
    assertStringIncludes(remote, "'--download'");
    assert(!remote.includes("sha256sum"));
  } finally {
    ssh.cleanup();
  }
});

Deno.test("restoreDrill refuses an object above the byte ceiling", async () => {
  const ssh = await fakeSsh(`echo '{"count":1,"bytes":9999999999999}'`);
  const { context } = testContext(
    baseArgs(ssh.path, { maxRestoreBytes: 1024 }),
  );
  try {
    await assertRejects(
      () =>
        model.methods.restoreDrill.execute({ objectPath: "big.tar" }, context),
      Error,
      "exceeds maxRestoreBytes",
    );
  } finally {
    ssh.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Model shape
// ---------------------------------------------------------------------------

Deno.test("there is no pre-flight check gating a per-run acknowledgement", () => {
  // A check sees only globalArgs, so gating restoreRequest in a check would
  // reject --input allowRestore=true before execute ever ran. CONVENTIONS §7.
  for (const [name, check] of Object.entries(model.checks)) {
    const applies = (check as { appliesTo?: string[] }).appliesTo;
    assert(
      applies === undefined,
      `check "${name}" declares appliesTo; the gate belongs in execute`,
    );
  }
});

Deno.test("the archive-storage-class check rejects a non-archive tier", async () => {
  const bad = await model.checks["archive-storage-class"].execute({
    globalArgs: { storageClass: "STANDARD" } as never,
  });
  assertEquals(bad.pass, false);
  // The message must quantify the mistake, not merely name it — "wrong tier"
  // is ignorable, "23x the price" is not. It must quantify it in RATES rather
  // than in one deployment's bill: this extension is published, and a figure
  // derived from the author's own volume is both a disclosure and meaningless
  // to everyone else who installs it.
  assertStringIncludes(bad.errors?.[0] ?? "", "not an archive tier");
  assertStringIncludes(bad.errors?.[0] ?? "", "23x");
  assertStringIncludes(bad.errors?.[0] ?? "", "0.00099");
  assert(!/\b13\.79\b/.test(bad.errors?.[0] ?? ""), "no volume-specific size");

  const good = await model.checks["archive-storage-class"].execute({
    globalArgs: {} as never,
  });
  assertEquals(good.pass, true);
});

Deno.test("a relative sourcePath is rejected — docker would mount a named volume", async () => {
  const r = await model.checks["source-path-absolute"].execute({
    globalArgs: { sourcePath: "volume1/homes" } as never,
  });
  assertEquals(r.pass, false);
  assertStringIncludes(r.errors?.[0] ?? "", "NAMED VOLUME");
});

Deno.test("every resource spec has a schema and the methods write only those", () => {
  const specs = new Set(Object.keys(model.resources));
  assertEquals(specs.has("inventory"), true);
  assertEquals(specs.has("transfer"), true);
  assertEquals(specs.has("verification"), true);
  assertEquals(specs.has("retrieval"), true);
  assertEquals(Object.keys(model.methods).length, 5);
});

Deno.test("each spec writes a DISTINCT instance name", async () => {
  // data.latest(model, name) resolves by resource INSTANCE name, not by spec.
  // If scan, push and verify all wrote instance "homes", a workflow could not
  // say which resource it meant — and the failure would be an expression
  // evaluation error a few milliseconds in, which allowFailure would then
  // report as a successful run.
  const ssh = await fakeSsh(`echo '{"count":5,"bytes":5000}'`);
  const { written, context } = testContext(baseArgs(ssh.path));
  try {
    await model.methods.scan.execute({}, context);
    await model.methods.push.execute({}, context);
    await model.methods.verify.execute({}, context);
    const names = written.map((w) => w.instance);
    assertEquals(names.length, new Set(names).size, `collided: ${names}`);
    assertEquals(names, ["homes", "homes-transfer", "homes-verification"]);
  } finally {
    ssh.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The env-file FIFO — DSM refuses to open /dev/stdin, so the env file is
// streamed through a FIFO instead. See buildRemoteCommand.
// ---------------------------------------------------------------------------

Deno.test("the env-file path is the ONE word left unquoted, so it expands", () => {
  const remote = buildRemoteCommand([
    "/usr/local/bin/docker",
    "run",
    "--env-file",
    ENV_FIFO_REF,
    "rclone/rclone:1.75.0",
  ]);
  // Unquoted so the shell expands it...
  assertStringIncludes(remote, `'--env-file' "$ENVF"`);
  // ...and never as a literal, which docker would try to open as a filename.
  assert(
    !remote.includes(`'$ENVF'`),
    "a quoted $ENVF would reach docker as a literal filename",
  );
  // Everything else still goes through shQuote.
  assertStringIncludes(remote, `'rclone/rclone:1.75.0'`);
});

Deno.test("the sentinel must appear exactly once", () => {
  for (
    const words of [
      ["/usr/local/bin/docker", "run", "img"],
      ["/usr/local/bin/docker", ENV_FIFO_REF, ENV_FIFO_REF, "img"],
    ]
  ) {
    let threw = false;
    try {
      buildRemoteCommand(words);
    } catch (e) {
      threw = true;
      assertStringIncludes(String(e), "exactly once");
    }
    assert(threw, `expected a throw for ${words.length} words`);
  }
});

Deno.test("the real stdin is preserved on fd 3", () => {
  const remote = buildRemoteCommand(["docker", "--env-file", ENV_FIFO_REF]);
  // A backgrounded command in a POSIX shell reads stdin from /dev/null. If the
  // writer is not explicitly pointed at the saved fd, the env file arrives
  // EMPTY and rclone runs with no credentials while exit codes look healthy.
  assertStringIncludes(remote, "exec 3<&0");
  assertStringIncludes(remote, 'cat <&3 > "$ENVF"');
});

Deno.test("the writer is killed, never waited on", () => {
  const remote = buildRemoteCommand(["docker", "--env-file", ENV_FIFO_REF]);
  // If docker dies before opening the FIFO, the writer is still blocked in
  // open(). Waiting on it would hang the run until the six-hour timeout.
  assert(
    !/\bwait\b/.test(remote),
    "waiting on the FIFO writer deadlocks when docker fails early",
  );
  assertStringIncludes(remote, 'kill "$CATPID"');
});

Deno.test("the FIFO is private and removed on every exit path", () => {
  const remote = buildRemoteCommand(["docker", "--env-file", ENV_FIFO_REF]);
  assertStringIncludes(remote, "mkfifo -m 600");
  assertStringIncludes(remote, `trap 'rm -rf "$D"' EXIT INT TERM`);
});

Deno.test("the remote shell really delivers the env file, and propagates the exit code", async () => {
  const dir = await Deno.makeTempDir({ prefix: "rclone-fifo-" });
  try {
    const docker = `${dir}/docker`;
    const seen = `${dir}/seen`;
    // A stand-in for docker that copies out whatever --env-file pointed at,
    // then exits non-zero so exit-code propagation is proven too.
    await Deno.writeTextFile(
      docker,
      `#!/bin/sh
while [ $# -gt 0 ]; do
  if [ "$1" = "--env-file" ]; then shift; cat "$1" > ${seen}; fi
  shift
done
exit 7
`,
    );
    await Deno.chmod(docker, 0o755);

    const remote = buildRemoteCommand([
      docker,
      "run",
      "--env-file",
      ENV_FIFO_REF,
      "rclone/rclone:1.75.0",
    ]);

    const child = new Deno.Command("/bin/sh", {
      args: ["-c", remote],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(
      new TextEncoder().encode("RCLONE_CONFIG_DEST_SECRET_ACCESS_KEY=s3cr3t\n"),
    );
    await writer.close();
    const output = await child.output();

    assertEquals(output.code, 7, "docker's exit code must survive the wrapper");
    assertEquals(
      await Deno.readTextFile(seen),
      "RCLONE_CONFIG_DEST_SECRET_ACCESS_KEY=s3cr3t\n",
      "the env file must arrive intact through the FIFO",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("docker failing before it opens the FIFO does not hang", async () => {
  const dir = await Deno.makeTempDir({ prefix: "rclone-fifo-" });
  try {
    const docker = `${dir}/docker`;
    // Never reads --env-file at all — the writer stays blocked in open().
    await Deno.writeTextFile(docker, "#!/bin/sh\nexit 125\n");
    await Deno.chmod(docker, 0o755);

    const remote = buildRemoteCommand([docker, "--env-file", ENV_FIFO_REF]);
    const child = new Deno.Command("/bin/sh", {
      args: ["-c", remote],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode("K=v\n"));
    await writer.close();

    const output = await Promise.race([
      child.output(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("deadlocked")), 15_000)
      ),
    ]);
    assertEquals(output.code, 125);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// The storage class must be one S3 actually accepts.
//
// GLACIER_DEEP_ARCHIVE was the default here, and sat in the check's own
// allowlist, until a live run rejected all 37 objects with 400
// InvalidStorageClass. The guard reported it as a valid archive tier because
// it only ever compared against a hand-written list.
// ---------------------------------------------------------------------------

Deno.test("the default storage class is one S3 accepts", () => {
  assertEquals(DEFAULT_STORAGE_CLASS, "DEEP_ARCHIVE");
  assert(
    S3_STORAGE_CLASSES.includes(DEFAULT_STORAGE_CLASS),
    "the default must be a real S3 storage class",
  );
  assert(
    ARCHIVE_STORAGE_CLASSES.includes(DEFAULT_STORAGE_CLASS),
    "the default must be an archive tier",
  );
});

Deno.test("GLACIER_DEEP_ARCHIVE is not a storage class and must be refused", async () => {
  const r = await model.checks["archive-storage-class"].execute({
    globalArgs: { storageClass: "GLACIER_DEEP_ARCHIVE" } as never,
  });
  assertEquals(r.pass, false);
  // It must fail as INVALID, not as "not an archive tier" — the whole bug was
  // that the two were conflated.
  assertStringIncludes(String(r.errors), "InvalidStorageClass");
  assertStringIncludes(String(r.errors), "does not exist");
});

Deno.test("every archive class is also a valid S3 class", () => {
  for (const c of ARCHIVE_STORAGE_CLASSES) {
    assert(S3_STORAGE_CLASSES.includes(c), `${c} is not a valid S3 class`);
  }
});

Deno.test("a valid but non-archive class still fails, on cost grounds", async () => {
  const r = await model.checks["archive-storage-class"].execute({
    globalArgs: { storageClass: "STANDARD" } as never,
  });
  assertEquals(r.pass, false);
  assertStringIncludes(String(r.errors), "23x");
});

// ---------------------------------------------------------------------------
// restoreRequest — all three of these were found by attempting a real drill,
// and all three are invisible to the exit code.
// ---------------------------------------------------------------------------

Deno.test("restore roots at the parent directory, not the object", () => {
  const argv = buildRestoreArgs("dest:b/nas/share", "a/b/kick.wav", "Standard");
  // Handed the object path directly, rclone fails "is a file not a directory".
  assert(!argv.includes("dest:b/nas/share/a/b/kick.wav"));
  assertStringIncludes(argv.join(" "), "dest:b/nas/share/a/b");
  assertStringIncludes(argv.join(" "), "--include /kick.wav");
});

Deno.test("the include is anchored, or it restores every matching name in the share", () => {
  const argv = buildRestoreArgs(
    "dest:b/share",
    "deep/nested/chords.mid",
    "Bulk",
  );
  const include = argv[argv.indexOf("--include") + 1];
  // Unanchored, this matches chords.mid at ANY depth — and every object it
  // matches is retrieved and billed.
  assertEquals(include, "/chords.mid");
});

Deno.test("an object at the share root still restores", () => {
  const argv = buildRestoreArgs("dest:b/share", "top.txt", "Bulk");
  assertEquals(argv[2], "dest:b/share");
  assertEquals(argv[argv.indexOf("--include") + 1], "/top.txt");
});

Deno.test("a directory objectPath is refused rather than restoring everything", () => {
  let threw = false;
  try {
    buildRestoreArgs("dest:b/share", "some/dir/", "Bulk");
  } catch (e) {
    threw = true;
    assertStringIncludes(String(e), "every retrieved byte is billed");
  }
  assert(threw, "a trailing slash must not silently restore a whole directory");
});

Deno.test("glob metacharacters in a filename are escaped, not interpreted", () => {
  assertEquals(escapeFilterPattern("take[1].wav"), "take\\[1\\].wav");
  assertEquals(escapeFilterPattern("mix{a,b}.wav"), "mix\\{a,b\\}.wav");
  assertEquals(escapeFilterPattern("stem*.wav"), "stem\\*.wav");
  // Parentheses are NOT rclone filter operators and must be left alone —
  // over-escaping would stop a real filename from matching at all.
  assertEquals(escapeFilterPattern("take(final).wav"), "take(final).wav");
});

Deno.test("a per-object failure is read from the JSON, since rclone exits 0", () => {
  const out = `[
{ "Status": "operation error S3: RestoreObject, api error RestoreAlreadyInProgress: Object restore is already in progress", "Remote": "kick.wav" }
]`;
  const rows = parseRestoreStatus(out);
  assertEquals(rows.length, 1);
  assert(isRestoreAlreadyInProgress(rows[0].status));
});

Deno.test("a genuine per-object error is not mistaken for the in-progress case", () => {
  const rows = parseRestoreStatus(
    `[{ "Status": "operation error S3: RestoreObject, api error AccessDenied", "Remote": "x" }]`,
  );
  assertEquals(rows.length, 1);
  assert(!isRestoreAlreadyInProgress(rows[0].status));
  assert(rows[0].status !== "OK");
});

Deno.test("a filter that matched nothing parses as zero rows, not as success", () => {
  // rclone exits 0 here, so the empty array IS the failure signal.
  assertEquals(parseRestoreStatus("[]").length, 0);
  assertEquals(parseRestoreStatus("").length, 0);
  assertEquals(parseRestoreStatus("not json at all").length, 0);
});

Deno.test("leading notices before the JSON do not defeat the parser", () => {
  const out =
    `2026/08/15 23:11:57 NOTICE: Config file not found - using defaults
[
{ "Status": "OK", "Remote": "kick.wav" }
]`;
  const rows = parseRestoreStatus(out);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].status, "OK");
});

// ---------------------------------------------------------------------------
// The seed command (SETUP §7.3)
// ---------------------------------------------------------------------------
//
// The seed is started by pasting a command into a shell on the NAS, so the
// command this emits IS the archive's storage-class guarantee for the largest
// transfer the suite ever performs. These pin the properties that make it safe
// to print and safe to paste.

const SEED_CREDS = {
  accessKeyId: "AKIAEXAMPLEEXAMPLE00",
  secretAccessKey: "s3cr3t-example-value-not-real-0000000000",
};
const SEED_DEST = {
  bucket: "example-bucket",
  region: "us-west-2",
  storageClass: "DEEP_ARCHIVE",
};
const SEED_TRANSPORT = {
  sshHost: "nas",
  sourceMount: "/volume1/example-share",
};

Deno.test("the emitted command names the storage class", () => {
  const { remote } = buildRcloneInvocation(
    SEED_CREDS,
    SEED_DEST,
    SEED_TRANSPORT,
    ["copy", "/data", "dest:example-bucket/x"],
  );
  assertStringIncludes(remote, "--s3-storage-class");
  assertStringIncludes(remote, "DEEP_ARCHIVE");
});

Deno.test("the emitted command carries no credential, so it is safe to log", () => {
  const { remote, secrets } = buildRcloneInvocation(
    SEED_CREDS,
    SEED_DEST,
    SEED_TRANSPORT,
    ["copy", "/data", "dest:example-bucket/x"],
  );
  assert(!remote.includes(SEED_CREDS.accessKeyId));
  assert(!remote.includes(SEED_CREDS.secretAccessKey));
  // They reach the container through the FIFO, which appears only as $ENVF.
  assertStringIncludes(remote, "--env-file");
  assertEquals(secrets.length, 2);
});

Deno.test("a credential in argv is refused rather than printed", () => {
  // Refusing is what makes the line above a guarantee instead of a hope: there
  // is no argv that both reaches S3 and contains a secret to leak.
  assertThrows(() =>
    buildRcloneInvocation(SEED_CREDS, SEED_DEST, SEED_TRANSPORT, [
      "copy",
      "/data",
      `dest:${SEED_CREDS.secretAccessKey}`,
    ])
  );
});

Deno.test("stripping --dry-run yields the command that really transfers", () => {
  // The emitter filters the REAL argv rather than rebuilding it, so the printed
  // command can differ from the executed one in exactly one flag and no other.
  const argv = ["copy", "/data", "dest:example-bucket/x", "--dry-run"];
  const dry = buildRcloneInvocation(
    SEED_CREDS,
    SEED_DEST,
    SEED_TRANSPORT,
    argv,
  ).remote;
  const real = buildRcloneInvocation(
    SEED_CREDS,
    SEED_DEST,
    SEED_TRANSPORT,
    argv.filter((a) => a !== "--dry-run"),
  ).remote;

  assertStringIncludes(dry, "--dry-run");
  assert(!real.includes("--dry-run"));
  assertEquals(real, dry.replace(" '--dry-run'", ""));
  // Still archived correctly once the flag is gone -- that is the whole risk.
  assertStringIncludes(real, "--s3-storage-class");
});

Deno.test("a packed seed command inlines the class, since the flag would hit the shell", () => {
  // The pack path runs `sh -c '<script>'`, so an appended flag would become a
  // positional parameter of the shell and rclone would never see it. The
  // builder refuses that shape unless the script names the class itself.
  const script = buildPackScript(
    "member",
    "dest:example-bucket/x/member.tar",
    "DEEP_ARCHIVE",
    smallUpload(),
  );
  const { remote } = buildRcloneInvocation(
    SEED_CREDS,
    SEED_DEST,
    { ...SEED_TRANSPORT, entrypoint: "sh" },
    ["-c", script],
  );
  assertStringIncludes(remote, "--s3-storage-class");
  assertStringIncludes(remote, "--entrypoint");

  assertThrows(() =>
    buildRcloneInvocation(
      SEED_CREDS,
      SEED_DEST,
      { ...SEED_TRANSPORT, entrypoint: "sh" },
      ["-c", "rclone rcat dest:example-bucket/x/member.tar"],
    )
  );
});

Deno.test("the seed env template carries placeholders, never the real values", () => {
  // Built by handing buildEnvFile placeholder credentials, so the true values
  // are never in the string rather than being substituted back out of it --
  // there is no redaction step here that could be got wrong.
  const template = buildEnvFile(
    { accessKeyId: "<ACCESS_KEY_ID>", secretAccessKey: "<SECRET_ACCESS_KEY>" },
    SEED_DEST,
  );
  assert(!template.includes(SEED_CREDS.accessKeyId));
  assert(!template.includes(SEED_CREDS.secretAccessKey));
  assertStringIncludes(
    template,
    "RCLONE_CONFIG_DEST_ACCESS_KEY_ID=<ACCESS_KEY_ID>",
  );
  assertStringIncludes(
    template,
    "RCLONE_CONFIG_DEST_SECRET_ACCESS_KEY=<SECRET_ACCESS_KEY>",
  );
  // The non-secret half must be real, or the operator cannot use it.
  assertStringIncludes(
    template,
    "RCLONE_CONFIG_DEST_STORAGE_CLASS=DEEP_ARCHIVE",
  );
  assertStringIncludes(
    template,
    `RCLONE_CONFIG_DEST_REGION=${SEED_DEST.region}`,
  );
});

Deno.test("the emitted command really does read its credentials from stdin", () => {
  // This is why the env file has to be emitted with it: pasted alone the
  // command blocks in `cat` reading the terminal, which reads as a hung
  // transfer rather than as a missing argument.
  const { remote } = buildRcloneInvocation(
    SEED_CREDS,
    SEED_DEST,
    SEED_TRANSPORT,
    ["copy", "/data", "dest:example-bucket/x"],
  );
  assertStringIncludes(remote, "exec 3<&0");
  assertStringIncludes(remote, "mkfifo");
  assertStringIncludes(remote, "--env-file");
});

// ---------------------------------------------------------------------------
// push must resolve the `auto` strategy, not fall through to direct
// ---------------------------------------------------------------------------
//
// The fall-through was the worst shape a cost bug can take: scan computed the
// decision correctly and said pack, push silently did direct, and both rungs
// reported success. Packing exists only to amortise the 40 KB per-object
// billing minimum, so on a small-file share that is the minimum paid per file.

/** A fake ssh that records every invocation, so "did it measure?" is testable. */
async function countingSsh(script: string) {
  const log = await Deno.makeTempFile({ prefix: "rclone-calls-" });
  const ssh = await fakeSsh(`printf '%s\\n' "$*" >> ${log}\n${script}`);
  return {
    ...ssh,
    calls: () =>
      Deno.readTextFileSync(log).split("\n").filter((l) => l.length > 0),
    cleanup: () => {
      ssh.cleanup();
      try {
        Deno.removeSync(log);
      } catch { /* already gone */ }
    },
  };
}

Deno.test("auto picks pack when the mean file size is below the threshold", async () => {
  // 1000 B over 10 files = 100 B mean, far under the 1 MiB default.
  const ssh = await countingSsh(`echo '{"count":10,"bytes":1000}'`);
  const { written, context } = testContext(baseArgs(ssh.path));
  try {
    await model.methods.push.execute({ dryRun: true }, context);
    assertEquals(written.length, 1);
    assertEquals(written[0].data.strategy, "pack");
    assert(
      ssh.calls().some((c) => c.includes("size")),
      "auto must MEASURE; a decision made without measuring is the old bug",
    );
  } finally {
    ssh.cleanup();
  }
});

Deno.test("auto picks direct when the mean file size is above the threshold", async () => {
  // 10 GB over 10 files = 1 GB mean.
  const ssh = await countingSsh(`echo '{"count":10,"bytes":10000000000}'`);
  const { written, context } = testContext(baseArgs(ssh.path));
  try {
    await model.methods.push.execute({ dryRun: true }, context);
    assertEquals(written.length, 1);
    assertEquals(written[0].data.strategy, "direct");
  } finally {
    ssh.cleanup();
  }
});

Deno.test("an explicitly pinned strategy skips the measurement entirely", async () => {
  // The measurement is a full source walk, so pinning has to actually avoid it
  // -- otherwise the escape hatch for a scheduled incremental run does nothing.
  const ssh = await countingSsh(`echo '{"count":10,"bytes":1000}'`);
  const { context } = testContext(baseArgs(ssh.path, { strategy: "direct" }));
  try {
    await model.methods.push.execute({ dryRun: true }, context);
    assert(
      !ssh.calls().some((c) => c.includes("size")),
      "a pinned strategy must not pay for a source walk it does not need",
    );
  } finally {
    ssh.cleanup();
  }
});

Deno.test("an unmeasurable share refuses rather than defaulting either way", async () => {
  // Defaulting to direct here would be the original bug wearing a comment, and
  // defaulting to pack would tar a share whose size we just failed to establish.
  const ssh = await countingSsh("exit 3");
  const { written, context } = testContext(baseArgs(ssh.path));
  try {
    await model.methods.push.execute({}, context);
    assertEquals(written.length, 1);
    const d = written[0].data as Record<string, unknown>;
    assertEquals(d.passed, false);
    assertEquals(d.inconclusive, true);
    assertStringIncludes(String(d.failureReason), "strategy-undetermined");
  } finally {
    ssh.cleanup();
  }
});
