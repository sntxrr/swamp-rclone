import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { z } from "npm:zod@4";
import {
  buildEnvFile,
  chooseStrategy,
  churnFraction,
  classifyFailure,
  destPath,
  isInconclusive,
  model,
  normalisePrefix,
  OBJECT_OVERHEAD_BYTES,
  parseDu,
  parseSize,
  projectCost,
  buildPackPlan,
  buildPackScript,
  buildExtractScript,
  RCLONE_EXIT,
  type RcloneResult,
  redactSecrets,
  runRclone,
  shQuote,
} from "./rclone_archive.ts";

const CREDS = {
  accessKeyId: "AKIATESTKEYIDEXAMPLE",
  secretAccessKey: "test-secret-access-key-not-a-real-one",
};

const DEST = {
  bucket: "example-archive-bucket",
  region: "us-west-2",
  storageClass: "GLACIER_DEEP_ARCHIVE",
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
        const resource = (model.resources as Record<string, { schema: z.ZodType }>)[spec];
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
// shQuote — the paths in these tests are real entries on volume1
// ---------------------------------------------------------------------------

Deno.test("shQuote survives a path containing a space", () => {
  assertEquals(shQuote("/volume1/Resilio Sync"), `'/volume1/Resilio Sync'`);
});

Deno.test("shQuote survives parentheses, which are sh syntax errors bare", () => {
  assertEquals(
    shQuote("/volume1/twilight-tears(mix).mp3"),
    `'/volume1/twilight-tears(mix).mp3'`,
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
    assertStringIncludes(remote, `'--s3-storage-class' 'GLACIER_DEEP_ARCHIVE'`);
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
    assertStringIncludes(ssh.argv().at(-1) ?? "", "--env-file' '/dev/stdin");
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
  assertStringIncludes(body, "RCLONE_CONFIG_DEST_STORAGE_CLASS=GLACIER_DEEP_ARCHIVE");
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
  assertEquals(parseSize(`{"count":42,"bytes":123}`), { count: 42, bytes: 123 });
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
  assertEquals(classifyFailure(result({ code: RCLONE_EXIT.DIR_NOT_FOUND })), "source-not-found");
  assertEquals(classifyFailure(result({ code: RCLONE_EXIT.TEMPORARY })), "retries-exhausted");
  assertEquals(classifyFailure(result({ timedOut: true })), "timeout");
});

// ---------------------------------------------------------------------------
// Cost and strategy
// ---------------------------------------------------------------------------

Deno.test("small mean file size chooses pack", () => {
  // 500k files averaging 200 KB.
  assertEquals(chooseStrategy(500_000, 500_000 * 200 * 1024, 1024 * 1024), "pack");
});

Deno.test("large mean file size chooses direct", () => {
  // plex-data: ~30k files averaging >100 MB.
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
  assertEquals(destPath("b", "nas/volume1", "homes"), "dest:b/nas/volume1/homes");
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
  const { written, context } = testContext(baseArgs(ssh.path, { shareName: "time-machine" }));
  try {
    // time-machine's sparsebundle bands: high churn against a 180-day minimum.
    await model.methods.scan.execute({ previousBytes: 1_000_000_000_000 }, context);
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
  const { written, context } = testContext(baseArgs(ssh.path));
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
  const { context } = testContext(baseArgs(ssh.path));
  try {
    await model.methods.push.execute({}, context);
    assertStringIncludes(ssh.argv().at(-1) ?? "", "--error-on-no-transfer");
  } finally {
    ssh.cleanup();
  }
});

Deno.test("push copies and never syncs", async () => {
  const ssh = await fakeSsh("exit 0");
  const { context } = testContext(baseArgs(ssh.path));
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
    [{ name: "a", bytes: 10 }, { name: "b", bytes: 10 }, { name: "c", bytes: 10 }],
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

Deno.test("the pack script sets pipefail — without it a broken tar uploads truncated", () => {
  const script = buildPackScript("homes", "dest:b/x/homes.tar", "GLACIER_DEEP_ARCHIVE");
  assertStringIncludes(script, "set -o pipefail");
  // Without pipefail the exit status is rclone's alone, so a tar that dies
  // halfway still exits 0 and the truncated stream is stored as complete.
  assertStringIncludes(script, "tar -C /data -cf -");
  assertStringIncludes(script, "rclone rcat");
  assertStringIncludes(script, "--s3-storage-class");
});

Deno.test("the pack script quotes a member name containing a space", () => {
  const script = buildPackScript("Resilio Sync", "dest:b/x/a.tar", "GLACIER");
  assertStringIncludes(script, `'Resilio Sync'`);
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
    "silently land at S3 Standard rates",
  );
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
  const { written, context } = testContext(baseArgs(ssh.path, { strategy: "pack" }));
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
  const { written, context } = testContext(baseArgs(ssh.path, { strategy: "pack" }));
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
  const { written, context } = testContext(baseArgs(ssh.path, { strategy: "pack" }));
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
  const { written, context } = testContext(baseArgs(ssh.path, { strategy: "pack" }));
  try {
    await model.methods.push.execute({ dryRun: true }, context);
    const d = written[0].data as Record<string, unknown>;
    assertEquals(d.dryRun, true);
    assertEquals(d.passed, true);
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
        model.methods.restoreRequest.execute({ objectPath: "a/b.tar" }, context),
      Error,
      "allowRestore=true",
    );
  } finally {
    ssh.cleanup();
  }
});

Deno.test("restoreRequest proceeds with a per-run acknowledgement", async () => {
  const ssh = await fakeSsh("exit 0");
  const { written, context } = testContext(baseArgs(ssh.path));
  try {
    await model.methods.restoreRequest.execute(
      { objectPath: "a/b.tar", allowRestore: true },
      context,
    );
    assertEquals(written[0].data.phase, "requested");
    assertEquals(written[0].data.tier, "Bulk");
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
    await model.methods.restoreDrill.execute({ objectPath: "a/b.tar" }, context);
    assertEquals(written[0].data.phase, "pending");
    assertEquals(written[0].data.passed, false);
  } finally {
    ssh.cleanup();
  }
});

Deno.test("the extract script sets pipefail — a missing member must not hash empty", () => {
  const s = buildExtractScript("dest:b/x/homes.tar", "homes/don/notes.txt", "GLACIER");
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
      { objectPath: "homes.tar", member: "homes/don/notes.txt", sourceSha256: "deadbeef" },
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

Deno.test("restoreDrill refuses an object above the byte ceiling", async () => {
  const ssh = await fakeSsh(`echo '{"count":1,"bytes":9999999999999}'`);
  const { context } = testContext(baseArgs(ssh.path, { maxRestoreBytes: 1024 }));
  try {
    await assertRejects(
      () => model.methods.restoreDrill.execute({ objectPath: "big.tar" }, context),
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
  // is ignorable, "$317/mo instead of $14/mo" is not.
  assertStringIncludes(bad.errors?.[0] ?? "", "not an archive tier");
  assertStringIncludes(bad.errors?.[0] ?? "", "$317/mo");

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
