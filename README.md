# swamp-rclone

A Synology volume as a typed, queryable [swamp](https://swamp-club.com)
resource in **S3 Glacier Deep Archive** — and, more to the point, a measured
answer to *what would it cost to get it back*.

Third in a line: [`swamp-backblaze`](https://github.com/sntxrr/swamp-backblaze)
inventories the object-storage estate,
[`swamp-restic`](https://github.com/sntxrr/swamp-restic) proves the Linux
fleet's backups restore, and this one covers the host neither of them reaches.

## Why

The homelab backs up 18 Linux hosts nightly with restic into per-host Backblaze
B2 buckets, and `@sntxrr/restic-repository` validates that they restore. Every
host in the fleet is covered.

Except the Synology. It holds **13.79 TB** and has no off-site copy at all — the
largest store of data in the house is the only machine with nothing behind it.

The evidence that this was noticed before and never finished is still on the
box: `backrest` runs in Container Manager with **0 repositories and 0 plans**,
and Synology's own `GlacierBackup` package is installed with an **empty** data
directory. Both are abandoned starts on the same problem.

## Design

Read-mostly, and structured as a cost-ordered **ladder**. Each rung is a method,
each writes its own resource, and a rung that has never run is itself a finding:

| Rung | Proves |
| ---- | ------ |
| `scan` | What is there — count, bytes, chosen strategy, churn, and the projected cost to both store and *retrieve* |
| `push` | The data is at AWS, in the archive storage class, with nothing deleted or overwritten |
| `verify` | Destination inventory matches source. Metadata only — Deep Archive cannot be read |
| `restoreRequest` | A retrieval can be initiated |
| `restoreDrill` | A sample object materialises and **matches its source hash** |

Three rules shape everything else:

**It never deletes.** `sync`, `move`, `purge` and `delete` are refused at the
runner. A source path that fails to mount presents to rclone as an *empty
source*, and `sync` would then do exactly as asked and empty the destination —
unrecoverably, while still billing the 180-day minimum on everything it removed.

**It runs where the data is.** rclone executes on the NAS, in a container,
driven over SSH from the `swamp serve` host. Nothing is installed on DSM: there
is no Entware on this box, and a hand-installed binary does not survive a DSM
upgrade. A container does.

**It reports the recovery cost, not just the storage cost.** Storage is cheap
enough to be invisible — $13.65/mo for 13.79 TB. Egress for a full recovery is
**$1 241**. An archive whose recovery cost is first discovered *during* a
recovery is an archive nobody can afford to use, so `scan` records that number
every time it runs.

See [`PRD.md`](./PRD.md) for scope and [`CONVENTIONS.md`](./CONVENTIONS.md) for
the implementation contract and every rclone and Deep Archive trap it guards
against.

## Extensions

| Extension | Purpose |
| --------- | ------- |
| [`@sntxrr/rclone-archive`](./extensions/models/rclone-archive/) | Archive one share — the full ladder |

One model instance per share. Strategy is per-share because the data is: large
media files copy efficiently object-per-file, while small-file trees pay 40 KB
of Deep Archive overhead *per object* and want packing instead.

## Credentials

Each instance takes an AWS key pair wired from a vault — never inline.
[`@sntxrr/1password-connect`](https://github.com/sntxrr/swamp-1password-connect)
reads 1Password Connect over plain HTTP and so works headless, in cron, in
containers, and under `swamp serve`.

Archive keys should carry **only** `s3:PutObject`, `s3:GetObject`,
`s3:ListBucket` and `s3:RestoreObject`. **Never `s3:DeleteObject`** — the suite
never deletes, so a key that *can* delete only widens the blast radius of a
mistake it is not permitted to make.

The credentials never appear in `ps` output on either host. They travel as a
docker `--env-file` read from the SSH stdin pipe; see
[`CONVENTIONS.md`](./CONVENTIONS.md) §6 for why the obvious `docker run -e …`
spelling is wrong.

## Status

**Wave 1.** `scan`, `push` (direct), `verify`, `restoreRequest` and
`restoreDrill` are implemented, with 55 tests and every guard mutation-verified.

**Not yet implemented:** the `pack` strategy (PRD §4.1). `scan` will *choose*
pack for small-file shares and record why, and `push` **refuses** to run in that
mode rather than silently performing a direct copy while labelling the result a
pack — a transfer resource that misreports its own strategy would make every
downstream cost projection wrong.
