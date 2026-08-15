# PRD — Synology → Glacier Deep Archive via rclone

**Lead-owned.** Scope authority. For implementation detail, `CONVENTIONS.md`
wins.

Third in the line that begins with
[`swamp-backblaze`](https://github.com/sntxrr/swamp-backblaze) (inventory the
object-storage estate) and
[`swamp-restic`](https://github.com/sntxrr/swamp-restic) (prove the backups
restore). This one closes the gap both of those leave open.

---

## 1. Why

The homelab backs up 18 Linux hosts nightly with restic into per-host Backblaze
B2 buckets, and `@sntxrr/restic-repository` validates that they can be restored.
Every host in the fleet is covered.

Except one. **`nas`, the Synology, holds 13.8 TB and has no off-site copy at
all.** It is simultaneously the largest store of data in the house and the only
machine with nothing behind it.

The evidence that this was noticed before and never finished:

- `backrest` (a restic orchestrator) runs on `nas` in Container Manager with
  **0 repositories and 0 plans** — an 823-byte config that has never been used.
- Synology's own `GlacierBackup` package is **installed**, and `@GlacierBackup`
  on volume1 is **empty**. It targets the legacy Glacier *vault* API rather than
  S3 Deep Archive, and Synology has not meaningfully developed it in years.
- `nas` appears in **none** of the 18 `@sntxrr/restic/repository` model
  instances in `swamp-homelab`.

So the goal is one sentence: **the Synology is the last unprotected host, and
this suite is what protects it.**

## 2. Scope

**In:** all of volume1 — 13.8 TB across 19 shares — copied to S3 Glacier Deep
Archive, on a schedule, driven from the existing `swamp serve` instance on the
`docker` host, with credentials from 1Password Connect.

**Out:**

- Restoring the NAS. This suite proves a restore is *possible* and drills it on
  a sample; a full 13.8 TB recovery is an operator runbook, not a model method.
- Managing the AWS side — bucket creation, lifecycle rules, IAM. That is
  `@swamp/aws/s3` territory; this suite consumes a bucket it did not create.
- Replacing restic. The two coexist: restic covers the Linux fleet to B2, this
  covers the NAS to Glacier.

### 2.1 Scope decision, recorded

Full-volume coverage was chosen deliberately over the narrower alternatives.
The counter-argument is recorded here so it is not re-litigated, and so the cost
is attributable when it appears:

**Roughly half the volume is already backup data of other systems** — an
appliance-backup store, a set of VM dumps, and a Time Machine target.
Archiving them is backups-of-backups, and two consequences follow that the
implementation must handle rather than hide:

| Share | Size | Consequence |
| ----- | ---: | ----------- |
| `appliance-backups` | 4.1 T | A backup appliance's own deduplicated chunk store. Restorable only *through that appliance*, so an object-level copy is a copy of an opaque format. Churns as it prunes. |
| `mac-backups` | 1.3 T | Time Machine sparsebundles — roughly 157 000 8 MB band files rewritten continuously. Every run replaces objects that Deep Archive **still bills for 180 days**. This is the single largest recurring cost risk in the suite. |
| `vm-dumps` | 1.4 T | Dumps of hosts that already have their own restic repositories elsewhere. |

`scan` therefore **must** measure and report churn per share (§4, rung 1), so
the cost of this decision is visible in data rather than discovered on a bill.

### 2.2 What the data actually looks like

Share names throughout this document are **fictional**, per the convention the
sibling suites follow: the real instances live in the private implementation
repo and `/models/` is gitignored here, because a share-by-share table of names
and sizes is a complete contents inventory of the volume this suite exists to
protect. The sizes and proportions are real, because the design decisions
follow from them.

| Share | Size | Shape |
| ----- | ---: | ----- |
| `appliance-backups` | 4.1 T | opaque chunk store, churning |
| `media-library` | 3.8 T | large media files — ideal Glacier shape |
| `homes` | 2.7 T | **the irreplaceable data**; mixed sizes, many small |
| `vm-dumps` | 1.4 T | large dump files |
| `mac-backups` | 1.3 T | ~157 k churning 8 MB bands |
| `video-originals` | 0.4 T | large video originals |
| five small shares | 0.1 T | mixed |
| **total** | **13.8 T** | |

Two distinct shapes, needing two strategies (§4). Large-file shares copy
object-per-file efficiently. Small-file trees do not: Deep Archive bills 40 KB
of overhead per object regardless of file size, so a share of 500 KB documents
pays roughly 8% overhead before storing a byte, plus $0.05 per 1 000 PUTs.

## 3. Cost model

Storage is not the constraint. **Recovery is.**

| Item | Rate | 13.8 TB |
| ---- | ---- | -------: |
| Deep Archive storage | $0.00099 / GB-mo | **$13.65 / mo** |
| Per-object overhead | 40 KB / object | ~$2.50 / mo per million objects |
| Upload (PUT) | $0.05 / 1 000 | one-off, per object |
| Retrieval — bulk (48 h) | $0.0025 / GB | $34 |
| Retrieval — standard (12 h) | $0.02 / GB | $276 |
| **Egress to internet** | **$0.09 / GB** | **$1 241** |

Egress dominates every other line by an order of magnitude. A full recovery of
volume1 costs more in bandwidth than four years of storing it. This is worth
knowing *before* it is needed, which is why `scan` records the projected
retrieval cost of every share it inventories.

## 4. The ladder

Cost-ordered, mirroring `swamp-restic`. Each rung is a method, each writes its
own resource, and a rung that has never run is itself a finding.

| Rung | Method | Proves |
| ---- | ------ | ------ |
| 1 | `scan` | What is there — file count, byte total, size distribution, churn since last scan, projected storage and retrieval cost. Chooses `pack` or `direct`. |
| 2 | `push` | The data is at AWS, in the Deep Archive storage class, without having deleted or overwritten anything. |
| 3 | `verify` | Destination inventory matches source — count and bytes. Metadata only; Deep Archive cannot be read. |
| 4 | `restoreRequest` | A retrieval can be *initiated* — the credentials and the storage class permit it. |
| 5 | `restoreDrill` | A sample object **materialises and matches its source hash**. The only rung that proves recovery. |

Rungs 4 and 5 are one logical step split in two because Deep Archive retrieval
takes 12–48 hours. `restoreRequest` records a pending retrieval in the resource;
`restoreDrill` polls it, and both are safe to run repeatedly.

### 4.1 Packing

Shares whose scan shows a small mean file size are archived as **tar streams**,
not object-per-file. This amortises the 40 KB overhead and the per-PUT charge
across thousands of files.

**One pack per top-level entry, with no size-based grouping.** The obvious
design targets a pack size — group small directories until they reach ~1 GB —
and it is wrong. Grouping makes pack boundaries a function of the *data*: add
one file, the grouping shifts, every downstream pack gets a new name, and the
next push re-uploads the entire share while paying a fresh 180-day minimum on
every object it replaced. Stable names are worth more than optimal packing,
because an archive is written far more often than it is read.

The cost is granularity: restoring one file means retrieving its whole pack. For
an archive of last resort that is the right trade — but it is a trade, so `scan`
records the strategy it chose and why, and `restoreDrill` on a packed share must
extract a *single member* from the pack to prove the packing is reversible.

## 5. Where it runs

`swamp serve` runs in a container on the `docker` host. volume1 is on `nas`.
rclone must read volume1, so it runs **on nas**, in a container, driven over
SSH:

```
swamp serve (docker host)
  └─ssh─▶ nas
           └─▶ docker run --rm -i rclone/rclone …
```

No rclone binary is installed on DSM — there is no Entware on this box and a
package installed by hand does not survive a DSM upgrade. A container does.

This transport is the one genuinely new thing in the suite. `swamp-restic` runs
its binary locally against a *remote* repository and needs no transport at all;
here the data is remote and the credentials are local, which puts a second
host's `ps` output and a container runtime between the secret and its use.
`CONVENTIONS.md` §5 and §6 exist almost entirely because of this.

## 6. Non-goals that are really warnings

- **This suite never deletes.** Not from the source, not from the destination.
  `rclone sync`, `delete`, `purge` and `move` are refused at the runner. On Deep
  Archive a delete is unrecoverable *and* still billed for 180 days.
- **This suite is not a versioned backup.** rclone copies current state. A file
  corrupted on the NAS and then copied is corrupted in Glacier too. restic is
  what provides history; this provides an off-site copy of last resort.
- **`verify` does not read data.** It cannot. Deep Archive objects are not
  readable without a restore, so `verify` compares inventory metadata and
  `restoreDrill` is the only rung that touches content.
