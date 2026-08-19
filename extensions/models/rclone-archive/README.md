# `@sntxrr/rclone-archive`

Archive one Synology share to S3 Glacier Deep Archive with rclone, driven over
SSH into a container on the NAS.

One model instance per share. Strategy is per-share because the data is.

## Quick start

```bash
swamp model create @sntxrr/rclone-archive archive-homes \
  --global-arg 'shareName=homes' \
  --global-arg 'sourcePath=/volume1/homes' \
  --global-arg 'sshHost=nas' \
  --global-arg 'bucket=my-archive-bucket' \
  --global-arg 'region=us-west-2' \
  --global-arg 'destPrefix=nas/volume1' \
  --global-arg 'accessKeyId=${{ vault.get(onepassword, glacier-archive/access-key-id) }}' \
  --global-arg 'secretAccessKey=${{ vault.get(onepassword, glacier-archive/secret-access-key) }}'

# Rung 1 — what is there, and what would it cost to get back
swamp model method run archive-homes scan

# Rung 2 — ALWAYS dry-run first. The first real byte is also the first byte
# you are committed to paying 180 days for.
swamp model method run archive-homes push --input dryRun=true
swamp model method run archive-homes push

# Rung 3 — inventory comparison (metadata only)
swamp model method run archive-homes verify
```

## The ladder

| Method | Cost | Proves |
| ------ | ---- | ------ |
| `scan` | free | count, bytes, strategy, churn, projected storage **and retrieval** cost |
| `push` | upload | the data is at AWS in the archive storage class |
| `verify` | list requests | destination inventory matches source |
| `restoreRequest` | **money** | a retrieval can be initiated |
| `restoreDrill` | egress | a sample materialises and matches its source hash |

`restoreRequest` and `restoreDrill` are one logical step split in two, because
Deep Archive retrieval takes 12–48 hours. Both are safe to run repeatedly; the
drill reports `pending` until the object is actually available.

## Three behaviours this guards against

**`rclone sync` against a failed mount empties the destination.** A source path
that does not mount presents as an *empty source*, and `sync` faithfully deletes
everything at the destination to match — unrecoverably, and while still billing
the 180-day minimum on all of it. This model only ever runs `copy`, and the
runner refuses `sync`, `move`, `purge` and `delete` outright.

**Forgetting `--s3-storage-class` costs 23×, silently.** The upload lands at S3
Standard rates and nothing in rclone's output says so; you find out on a bill a
month later, by which point fixing it means re-uploading *and* paying the
minimum-duration charge on everything already written. The runner injects the
flag, and a check rejects a non-archive storage class outright.

**`docker run -e SECRET=…` leaks on the remote host.** The local argv looks
clean, which is what makes it easy to miss — but the secret is then in `ps`
output on the NAS for the life of the transfer, readable by every user on the
box. Credentials here travel as a docker `--env-file` read from the SSH stdin
pipe, so the remote `ps` line shows only `--env-file /dev/stdin`.

## Exit code 9 is load-bearing

Without `--error-on-no-transfer`, a run that transfers nothing exits 0 and is
indistinguishable from a run that transferred everything. For an incremental
archive that is the difference between "already up to date" and "the source was
empty and we uploaded nothing." This model always passes the flag and records
exit 9 as `nothingToTransfer: true` with `passed: true` — a distinct, queryable
outcome rather than either a failure or a silent success.

Similarly, exit 5 (retries exhausted), 8 (transfer cap) and 10 (duration cap)
are recorded as `inconclusive`, not as failures. None of them says anything
about whether the archive is healthy, and recording them as failures reports a
working backup as broken.

## `verify` does not verify content

It cannot, and it says so: every verification resource carries
`contentVerified: false`.

Deep Archive objects are not readable without a restore, and `--checksum` is no
help either — S3 returns an ETag, but for any multipart upload (which is every
large file here) that ETag is not an MD5 of the content, so comparing it
compares noise. `verify` therefore compares object count and byte totals, and
`restoreDrill` is the only rung that can prove integrity.

## Packing

`scan` chooses `pack` for shares below roughly 1 MB mean file size, where Deep
Archive's 40 KB per-object overhead stops being a rounding error.

```bash
swamp model method run archive-homes push \
  --input strategy=pack --input dryRun=true
```

**Pack boundaries are one-per-top-level-entry and never size-grouped.** Grouping
would make object names a function of the data: add a file, the grouping shifts,
every pack is renamed, and the next push re-uploads the share while paying a
fresh 180-day minimum on each replaced object. `homes` gives one pack per user,
`mac-backups` one per sparsebundle, `docker` one per container — which is also
the granularity you would actually want to restore at.

Loose files in the share root are collected into a single `_root.tar` so they
are neither skipped nor turned into one object each.

Existing packs are **skipped**, not replaced. Pass `--input repack=true` to
replace one deliberately — on Deep Archive a replacement deletes the old object
and bills its remaining 180-day minimum anyway, so re-packing an unchanged
subtree pays twice for the same bytes.

### Drilling a pack

Hashing a whole pack proves it downloaded. It does **not** prove it opens. Pass
`member` and the drill unpacks in flight and hashes just that file:

```bash
swamp model method run archive-homes restoreDrill \
  --input objectPath=don.tar \
  --input member=don/Documents/notes.txt \
  --input sourceSha256=<sha>
```

Both the pack and extract scripts set `pipefail`, and neither is optional. In
the pack direction, a tar that dies halfway would otherwise exit 0 and store a
truncated object as complete. In the extract direction, a member that is not in
the archive would otherwise let `sha256sum` exit 0 having hashed an empty
stream — a green drill for data that is not there.

## Testing

```bash
~/.swamp/deno/deno test --allow-all extensions/models/rclone-archive/rclone_archive_test.ts
```

72 tests. The suite mocks the `ssh` boundary only — `shQuote`, the remote
command line, storage-class injection, env-file assembly and all parsing
execute for real, because `shQuote` is the most security-relevant function here
and stubbing it would test nothing.

All 14 guards are mutation-verified — each is deleted in turn and the suite must
fail: `shQuote`, the forbidden-subcommand set, storage-class injection, the
shell-entrypoint storage-class assertion, the credentials-based exemption for
source-only calls, the argv secret scan, the env-file newline rejection, the
restore byte ceiling, `pipefail` in both the pack and extract scripts, the
skip-existing pack guard, pack-plan determinism, and per-spec instance-name
distinctness.

A green suite proves nothing until a mutation is shown to break it.
