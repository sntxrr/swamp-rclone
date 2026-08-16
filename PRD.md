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

**In:** all of volume1 except `appliance-backups`, and excluding every share's
recycle bin — **9.6 TB across 18 shares** — copied to S3 Glacier Deep Archive, on a schedule, driven from the existing
`swamp serve` instance on the `docker` host, with credentials from 1Password
Connect.

That figure is **apparent** size, which is the only one that predicts a
transfer: tar and rclone both read file contents, so sparse holes and
reflink-shared extents are read and uploaded in full. Physical usage — what
`df` reports, and the source of the 13.8 TB this document previously claimed —
undercounts the work by however much the filesystem is sharing. On `vm-dumps`
the gap is 2.6x (1.3 TB apparent against 0.5 TB allocated, sparse VM images);
on `appliance-backups` it is 216x, which is why that share is now out of
scope.

**Also in:** metric emission, so the ladder is observable in the existing
Prometheus/Grafana stack rather than only in `swamp data query` (§6).

**Out:**

- Restoring the NAS. This suite proves a restore is *possible* and drills it on
  a sample; a full 9.6 TB recovery is an operator runbook, not a model method.
- Managing the AWS side — bucket creation, lifecycle rules, IAM. That is
  `@swamp/aws/s3` territory; this suite consumes a bucket it did not create.
- Replacing restic. The two coexist: restic covers the Linux fleet to B2, this
  covers the NAS to Glacier.
- **The initial seed.** Moving the first 9.6 TB is explicitly *not* a swamp
  method (§5.1). swamp owns the steady state; the seed is an operator job.
- **`appliance-backups`.** Removed from scope after measurement; see §2.1. It is
  4.7 TB on disk but **1 015 TB to read**, and no bandwidth makes that finish.

### 2.1 Scope decision, recorded

Full-volume coverage was chosen deliberately over the narrower alternatives.
The counter-argument is recorded here so it is not re-litigated, and so the cost
is attributable when it appears:

**Roughly half the volume is already backup data of other systems** — an
appliance-backup store, a set of VM dumps, and a Time Machine target.
Archiving them is backups-of-backups, and two consequences follow that the
implementation must handle rather than hide:

| Share | On disk | To read | Consequence |
| ----- | ------: | ------: | ----------- |
| `appliance-backups` | 4.7 T | **1 015 T** | **Out of scope — see below.** A backup appliance's own deduplicated chunk store. Restorable only *through that appliance*, so an object-level copy is a copy of an opaque format. Churns as it prunes. |
| `mac-backups` | 1.5 T | 1.5 T | Time Machine sparsebundles — roughly 157 000 8 MB band files rewritten continuously. Every run replaces objects that Deep Archive **still bills for 180 days**. This is the single largest recurring cost risk in the suite. |
| `vm-dumps` | 0.5 T | 1.3 T | Dumps of hosts that already have their own restic repositories elsewhere. Sparse images: 2.6x more to read than to store. |

`scan` therefore **must** measure and report churn per share (§4, rung 1), so
the cost of this decision is visible in data rather than discovered on a bill.

**The `appliance-backups` reversal, recorded.** Full-volume coverage was chosen
before anyone had measured what the shares cost to *read* rather than to store,
and one of them does not survive that measurement.

Active-Backup-style appliances write each snapshot as a full-size image and let
the filesystem share the unchanged extents — btrfs reflinks, not hardlinks.
Individual images measure 1.86 TiB apparent against 860 GiB allocated with
`links = 1`, across many dated snapshots. **Neither tar nor rclone can see
through a reflink**: both open the file and read it, so every snapshot is read
at full size and every byte the filesystem was sharing is uploaded again, once
per snapshot. The share is 4.7 TB on disk and 1 015 TB to read — 216x.

At the measured uplink (§5.1) that is on the order of millennia, so this is not
a cost trade-off to weigh but an impossibility to route around. Nothing in the
suite could have absorbed it either: the ratio is a property of the source
filesystem, invisible to the destination.

It is therefore **out of scope**, and protecting that appliance's data is
delegated back to the appliance. The general lesson is the one now enforced in
code: **size a transfer by apparent bytes, never by `df` or `du` defaults**, or
dedup and sparseness will silently rewrite the estimate.

### 2.2 What the data actually looks like

Share names throughout this document are **fictional**, per the convention the
sibling suites follow: the real instances live in the private implementation
repo and `/models/` is gitignored here, because a share-by-share table of names
and sizes is a complete contents inventory of the volume this suite exists to
protect. The sizes and proportions are real, because the design decisions
follow from them.

Sizes are apparent and net of recycle bins, per §2 and §2.3. Rows are rounded
independently, so they do not sum exactly.

| Share | Size | Shape |
| ----- | ---: | ----- |
| `media-library` | 3.8 T | large media files — ideal Glacier shape |
| `homes` | 2.7 T | **the irreplaceable data**; mixed sizes, many small |
| `vm-dumps` | 1.3 T | sparse VM images — 0.5 T on disk |
| `mac-backups` | 1.3 T | ~157 k churning 8 MB bands |
| `video-originals` | 0.4 T | large video originals |
| thirteen small shares | 0.2 T | mixed |
| **total** | **9.6 T** | |
| ~~`appliance-backups`~~ | ~~1 015 T~~ | **out of scope (§2.1)** — 4.7 T on disk, 216x on read |
| ~~recycle bins~~ | ~~0.7 T~~ | **never archived (§2.3)** — deleted files |

Two distinct shapes, needing two strategies (§4). Large-file shares copy
object-per-file efficiently. Small-file trees do not: Deep Archive bills 40 KB
of overhead per object regardless of file size, so a share of 500 KB documents
pays roughly 8% overhead before storing a byte, plus $0.05 per 1 000 PUTs.

### 2.3 What is never archived

Two directory names are excluded at every rung: `#recycle` and `@eaDir`. They
are excluded for **different reasons**, and keeping the two arguments separate
is what stops the list growing into "things that look like junk".

**`#recycle` — deleted data.** Every DSM share carries one: the files a human
already chose to delete. The case is not really about money, though the money is
real — 705 GiB, **7.3% of everything otherwise in scope**, and one share
measured **97.6% recycle bin**. The case is that Deep Archive bills a 180-day
minimum per object and a recycle bin *churns*: it fills as people delete things
and empties when someone clears it, so each run archives freshly-deleted files
and pays six months for each, in perpetuity, for data whose defining property is
that nobody wants it.

**`@eaDir` — derived data.** DSM's thumbnail and index sidecars, which the NAS
regenerates on its own. This one is *not* a size argument, and the measurement
is worth recording so nobody re-opens it expecting savings: across this volume
`@eaDir` totals **296 MiB, 0.003% of everything in scope** — against the recycle
bin's 705 GiB. Nearly all of it is one share (282 MiB), and the 3.8 TB media
share holds 33 KiB. It is excluded because an archive of last resort should not
carry a cache that the source rebuilds for free, not because it costs anything
to keep.

The exclusion is applied at **every** rung that counts or moves bytes — `scan`,
`push`, `verify`, and both the sizing and the tar of the packing path. That
consistency is load-bearing rather than tidy: exclude it from `push` but not
from `verify`, and `verify` compares a filtered destination against an
unfiltered source and reports a permanent, meaningless delta — which trains
whoever reads it to ignore the rung that exists to catch real drift.

The two names differ in **shape**, and the sizing path has to respect that.
`#recycle` exists only at a share root, so dropping it from the pack plan is
enough. `@eaDir` sits beside every indexed directory at any depth, so nothing
top-level can catch it — and busybox `du` has no exclude of any kind. Sizing
therefore measures each entry, measures the excluded subtrees beneath it, and
subtracts. Skipping that step corrupts nothing, but it feeds the chunk-size
choice and would make the guarantee above false in the one place nobody looks.

## 3. Cost model

Storage is not the constraint. **Recovery is.**

| Item | Rate | 9.6 TB |
| ---- | ---- | -----: |
| Deep Archive storage | $0.00099 / GB-mo | **$9.52 / mo** |
| Per-object overhead | 40 KB / object | ~$2.50 / mo per million objects |
| Upload (PUT) | $0.05 / 1 000 | one-off, per object |
| Retrieval — bulk (48 h) | $0.0025 / GB | $24 |
| Retrieval — standard (12 h) | $0.02 / GB | $192 |
| **Egress to internet** | **$0.09 / GB** | **$865** |

Egress dominates every other line by an order of magnitude. A full recovery of
the archive costs more in bandwidth than seven years of storing it. This is worth
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

#### The `_root` pack

Loose files sitting directly in a share root belong to no top-level directory,
so they are collected into one `_root` pack. Two things about it are easy to get
wrong, and both were wrong until measured against the real NAS:

**`_root` is not `tar .`.** Tarring the share root archives every directory that
already has a pack of its own, making `_root.tar` a second full copy of the
share. On a small share that upload *succeeds*, and the share is stored twice at
the 180-day minimum; on a large one it fails, but only after moving terabytes,
because `_root` is sized from the loose-file total and so picks chunks for a few
kilobytes and dies at part 10 000. The pack is built with `--no-recursion` over
an explicit glob instead: files whole, directories as bare entries.

**Loose files must not also be entries.** Sizing globs directories only. With a
bare glob each loose file is reported as its own entry and becomes its own
single-file object — one 40 KB overhead and one PUT each, which is the exact
cost packing exists to amortise. Seven of the in-scope shares have loose files
at their root; the share used for the restore drill has none, which is why the
drill passed without exercising any of this.

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

### 5.1 The seed is not a swamp method

The first full copy is out of scope for swamp, for a reason that is structural
rather than stylistic: **a swamp method has a 6-hour default timeout, and the
seed cannot finish inside one.** There is no cadence at which a single `push`
invocation completes it, and a push that ran for days would hold the per-model
lock for days, blocking every other rung.

**The link is the ceiling, and it is lower than assumed.** Measured from the NAS
across four samples: 31.4 / 50.0 / 58.7 / 23.6 Mbit/s up. The best of those
matches the 58 Mbit/s a real 37-file `push` achieved almost exactly, which
settles a question worth settling once — **7.2 MB/s was the pipe being full, not
a concurrency limit.** `--transfers`, `--s3-upload-concurrency` and
`--s3-chunk-size` have no throughput to recover here, and an earlier note in
this project claiming the ISP imposed no cap was simply wrong.

So 9.6 TB takes **~15 days at the peak rate and ~22 days at the four-sample
mean**, and the honest planning figure is the latter. Tune those flags for
memory safety (§5.2) if at all; do not expect them to buy time.

So the seed runs as an operator job under [`herdr`](https://herdr.dev), which
already manages long-lived sessions on this fleet — a named persistent session
on the NAS, attachable from a workstation, surviving disconnection. `rclone
copy` is resumable (it skips what already exists), so an interrupted seed is
continued rather than restarted.

**The seed must use the same flags the model would.** This is the one real
hazard of stepping outside swamp: a hand-written command that omits
`--s3-storage-class` lands 9.6 TB at S3 Standard rates — roughly $221/mo
against $10 — and nothing in rclone's output says so. The seed command is
therefore *generated* by `push --input dryRun=true`, which runs the real code
path and prints the exact invocation, rather than transcribed from memory.

Ingress to S3 is free, so the seed costs only PUT requests and storage. Those
scale with object count, which is the strongest argument for packing the
small-file shares before the seed rather than after: roughly $250 in PUTs at
5M objects, against under a cent packed.

### 5.2 A packed share has a size ceiling, and it is not obvious

`pack` builds each object by piping `tar` into `rclone rcat`, so **the object's
size is unknown when the upload starts**. That matters more than it sounds like
it should. rclone grows `--s3-chunk-size` automatically to stay inside S3's
10 000-part limit — but only for a file whose size it knows. A stream keeps
whatever chunk size it was given, so at the 5 MiB default **every pack was
capped at 48 GiB**, and the failure arrived 48 GiB into the transfer rather than
at plan time. `mac-backups` holds a single 912 GiB sparsebundle, nineteen times
over that line.

The fix is available for free, because `buildPackPlan` already knows how big
each pack is: the chunk size is derived from it, holding back 20% of the part
budget for tar's own headers and padding. Two constraints bound the result:

- **Memory.** rclone holds `--s3-upload-concurrency` chunks in RAM per transfer.
  The NAS has 8 GB with ~3 GB free and is already several GB into swap, so this
  is a real limit. Concurrency is spent down to one in-flight chunk before a
  pack is refused — on this link that costs nothing measurable (§5.1), and the
  alternative is an OOM.
- **S3's 5 TiB object limit**, past which the subtree must be split.

A pack that clears neither is **refused before any bytes move**, which is the
entire point: the alternative is discovering it at part 10 000.

**Size packs by apparent bytes.** `du` defaults to allocated blocks while tar
streams apparent ones, so sparse and reflink-shared files are undercounted —
and those are exactly the shares that select `pack`. Measured in the rclone
image, a directory holding one 100 MiB sparse file and one 10 MiB real file
reports 10 240 KB allocated against a 115 345 920-byte tar: an **11x
undercount**, which would pick a chunk size 11x too small. busybox `du` spells
apparent size `-b` — GNU's `--apparent-size` is absent, the image being
Alpine — and `du -skb` predicts that same tar to within 2 560 bytes.

## 6. Observability

A rung that has never run is a finding (§4), and today that finding is only
visible to someone who thinks to run `swamp data query`. Nobody thinks to. The
suite therefore emits metrics to the Prometheus instance already running on the
NAS, so the ladder is legible on a dashboard and — more usefully — alertable.

**Alerting is where the ladder's design pays off.** The metrics worth having are
mostly *timestamps of last success*, because the failure this suite exists to
prevent is silence:

| Metric | Alert it enables |
| ------ | ---------------- |
| `..._last_success_timestamp_seconds{share,rung}` | "no successful push in 25 h", "no restore drill in 40 days" |
| `..._push_success{share}` | a failing share, distinguished from an inconclusive one |
| `..._churn_fraction{share}` | churn climbing toward a 180-day-minimum cost problem |
| `..._projected_cost_usd{share,kind}` | cost drift — **the detector for a wrong storage class**, visible within a day instead of on a bill a month later |
| `..._source_bytes` / `..._dest_bytes{share}` | the archive falling behind the source |

That fourth row is the one that matters most given how this suite can fail
expensively: a storage-class mistake is currently invisible until AWS bills for
it. A projected-cost line on a dashboard turns a month-long feedback loop into a
same-day one.

Emission is a **separate model**, not a feature of `rclone-archive` — the same
split as [`@sntxrr/apprise-notify`](https://github.com/sntxrr/swamp-apprise),
which exists so swamp learns about one notifier rather than about every service
behind it. A metrics emitter is reusable by the restic and Backblaze suites,
which have exactly the same "did the rung run" question and no answer either.

Design and setup are in [`SETUP.md`](./SETUP.md) §8. Nothing here is built yet.

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
