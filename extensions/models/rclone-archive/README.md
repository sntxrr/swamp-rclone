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
swamp model @sntxrr/rclone-archive method run scan archive-homes

# Rung 2 — ALWAYS dry-run first. The first real byte is also the first byte
# you are committed to paying 180 days for.
swamp model @sntxrr/rclone-archive method run push archive-homes --input dryRun=true
swamp model @sntxrr/rclone-archive method run push archive-homes

# Rung 3 — inventory comparison (metadata only)
swamp model @sntxrr/rclone-archive method run verify archive-homes
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

## Not yet implemented

The `pack` strategy. `scan` will choose it for small-file shares — below roughly
1 MB mean file size, Deep Archive's 40 KB per-object overhead stops being a
rounding error — and records the reason.

`push` **refuses** to run in pack mode rather than performing a direct copy
while labelling the result a pack. A transfer resource that misreports its own
strategy makes every downstream cost projection wrong, and the error surfaces
only as an unexplained bill.

## Testing

```bash
~/.swamp/deno/deno test --allow-all extensions/models/rclone-archive/rclone_archive_test.ts
```

55 tests. The suite mocks the `ssh` boundary only — `shQuote`, the remote
command line, storage-class injection, env-file assembly and all parsing
execute for real, because `shQuote` is the most security-relevant function here
and stubbing it would test nothing.

Every guard is mutation-verified: deleting the forbidden-subcommand set, the
storage-class injection, the argv secret scan, the env-file newline rejection,
the restore byte ceiling, the pack-mislabel refusal, or `shQuote` itself each
makes the suite fail.
