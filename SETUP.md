# Setup — the AWS side

Everything here has to exist before `push` can move a byte. None of it is
created by the extension: this suite consumes a bucket it did not create, so
the blast radius of a bug in it stops at "uploads to the wrong prefix".

## 1. The bucket

```bash
aws s3api create-bucket \
  --bucket <archive-bucket> \
  --region us-west-2 \
  --create-bucket-configuration LocationConstraint=us-west-2

aws s3api put-public-access-block \
  --bucket <archive-bucket> \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

**Leave versioning off.** It is the intuitive belt-and-braces choice and it is
the wrong one here: every superseded version becomes its own Deep Archive
object carrying its own **180-day minimum charge**, so a share that is re-packed
a few times quietly pays for several copies of itself. The protection
versioning would give — "a delete cannot lose data" — is obtained for free by
not granting `s3:DeleteObject` at all (§2).

## 2. The IAM policy

The key deliberately **cannot delete**. The suite never deletes, so a key that
*could* only widens the blast radius of a mistake it is not permitted to make.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListTheBucket",
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:ListBucketMultipartUploads"],
      "Resource": "arn:aws:s3:::<archive-bucket>"
    },
    {
      "Sid": "WriteAndRetrieveObjects",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:RestoreObject",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": "arn:aws:s3:::<archive-bucket>/*"
    }
  ]
}
```

`s3:AbortMultipartUpload` looks like a delete and is not one: it discards the
*parts of an upload that never completed*, which is cleanup, not data loss.
Omitting it is actively harmful — see §3.


**Do not add `s3:CreateBucket` to make an error go away.** rclone checks the
bucket exists and tries to CREATE it when that check is inconclusive, and
`rcat` — which is how every packed upload is written — takes that path for each
object. With a least-privilege user the result is:

```
ERROR : _root.tar: Post request rcat error: failed to prepare upload:
  operation error S3: CreateBucket, StatusCode: 403 ...
  is not authorized to perform: s3:CreateBucket
```

The fix is `--s3-no-check-bucket`, which this suite injects on every credentialed
invocation as of 2026.08.19.4 and REFUSES to run a shell-entrypoint script
without. The bucket is provisioned out of band in §1, and nothing in the archive
path should be able to create one — that the policy denies it is the design
working, not a gap to fill.

Worth knowing why it surfaced so late: `copy` never triggers the bucket check,
so the direct strategy ran green against real hardware for days. Only the packed
path hits it, and the packed path was unreachable until 2026.08.19.3.

## 3. Abort incomplete multipart uploads — this one bites

Every file over `--s3-upload-cutoff` (5 MB by default, so essentially
everything here) is uploaded in parts. **A multipart upload that fails partway
leaves its parts stored and billed, and they do not appear in
`ListObjects`** — they are invisible to `aws s3 ls`, to the console's object
view, and to `rclone size`. They simply accrue.

This is not a hypothetical for this homelab: `swamp-backblaze` already lists
"leaked unfinished large uploads" as one of the recurring cost problems it was
built to find in B2. The S3 version of the same bug is worse, because on Deep
Archive the orphaned parts are also subject to minimum-duration billing.

The fix is a lifecycle rule, not vigilance:

```bash
cat > /tmp/lifecycle.json <<'EOF'
{
  "Rules": [
    {
      "ID": "abort-incomplete-multipart-uploads",
      "Status": "Enabled",
      "Filter": {},
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
    }
  ]
}
EOF

aws s3api put-bucket-lifecycle-configuration \
  --bucket <archive-bucket> \
  --lifecycle-configuration file:///tmp/lifecycle.json
```

Note what this rule is **not**: there is no transition rule and no expiration
rule. Objects are written *directly* as `DEEP_ARCHIVE` by rclone, so
transitioning them is unnecessary, and a lifecycle transition would additionally
charge a per-object transition fee for a storage class they are already in.

## 4. Storing the credentials

Into the 1Password vault that Connect can read — Connect cannot access the
built-in Private, Personal, Employee or default Shared vaults, so the item must
live in a custom vault.

```bash
op item create --category="API Credential" \
  --vault homelab --title "glacier-archive" \
  "access-key-id[text]=AKIA…" \
  "secret-access-key[password]=…"
```

Then wire them as references — never literals:

```
accessKeyId=${{ vault.get(onepassword, glacier-archive/access-key-id) }}
secretAccessKey=${{ vault.get(onepassword, glacier-archive/secret-access-key) }}
```

## 5. SSH from the serve container to the NAS

`swamp serve` runs as the `swamp` user inside its container; the NAS must accept
that key non-interactively, because the runner passes `BatchMode=yes` and a host
that wants a password fails instantly rather than hanging.

On the NAS, the account needs to run `docker` without a TTY and without sudo
prompting — DSM's docker socket is root-owned, so the account must be in the
group that owns it, or the invocation needs a passwordless sudo rule scoped to
`/usr/local/bin/docker`.

Verify before wiring anything up:

```bash
ssh -o BatchMode=yes <nas> /usr/local/bin/docker run --rm rclone/rclone:1.75.0 version
```

If that prints a version, the transport works. If it asks for anything, fix that
first — every method in the suite goes through this one path.

## 6. First run, in order (after the seed — see §7)

The CLI is `swamp model method run <model> <method>` — model first, then
method. Earlier revisions of this file had it the other way round, which fails
with `Model not found: scan`.

```bash
# 1. What is there, and what would recovery cost?
swamp model method run archive-<share> scan

# 2. Dry run. Nothing is billed, nothing is written.
swamp model method run archive-<share> push --input dryRun=true

# 3. A capped real run against ONE small share before anything large.
swamp model method run archive-<share> push \
  --input maxTransferBytes=1073741824

# 4. Inventory comparison
swamp model method run archive-<share> verify

# 5. Prove it comes back. Bulk tier is 48 hours; run restoreDrill the next day.
swamp model method run archive-<share> restoreRequest \
  --input objectPath=<key> --input allowRestore=true
swamp model method run archive-<share> restoreDrill \
  --input objectPath=<key> --input sourceSha256=<sha>
```

**Run step 1 before step 3, and not only for the cost estimate.** With
`strategy` left at its default `auto`, `push` measures the share and picks
`direct` or `pack` from the mean file size. `scan` reports the same decision, so
step 1 is where you see it before any bytes move — and if the two ever disagree,
that is a bug, not a tuning choice.

Until 2026.08.19.3, `push` did not implement `auto` at all: it fell through to
`direct` regardless, while `scan` correctly reported `pack`. Packing exists only
to amortise the 40 KB per-object billing minimum, so on a small-file share the
effect was to pay that minimum per file, with both rungs reporting success. If
you have objects archived before that version, they were written object-per-file
whatever `scan` said. They are not wrong, only more expensive — and note that
this suite cannot remove them: `--immutable`, no `sync`, and the IAM user has no
`s3:DeleteObject`. Re-pushing such a share as a pack stores it twice for the
180-day minimum, so it is worth doing only where the overhead justifies it.

Pinning `strategy` explicitly skips the measurement, which is a full source
walk. That is worth doing on a scheduled incremental run, where the answer is
already known and will not change.

Do not skip step 5 on the grounds that steps 1–4 passed. Everything below it
compares metadata, and metadata cannot see corruption — an archive that has
never been restored is an assumption, not a backup. That is the entire lesson
of `swamp-restic`, and it applies here with more force, because Deep Archive
makes the drill slow enough to be easy to postpone forever.

## 7. Seeding out of band, under herdr

The first full copy does not run as a swamp method (PRD §5.1) — no cadence gets
9.6 TB through a 6-hour timeout. It runs as a long-lived operator session under
[`herdr`](https://herdr.dev), which manages persistent sessions on this fleet.

> **Preflight verified 2026-08-16** against herdr 0.8.0 on the NAS; the results
> are recorded inline below. The seed itself has still never been run, so §7.3
> and §7.4 remain intended procedure rather than observed.

### 7.1 Preflight on the NAS

herdr uses a client/server model: `herdr server` runs headless on the NAS, and a
workstation attaches with `herdr --remote`. Three DSM-specific things tend to
break that, all of them the same shape as the `docker` lesson elsewhere in this
document — **DSM is not a normal Linux userland, so use absolute paths.**

```bash
# 1. Is it actually there, and what does it think its config path is?
ssh <nas> '/volume1/homes/sntxrr/.local/bin/herdr --version'

# 2. PATH. `ssh host 'cmd'` is a NON-INTERACTIVE, NON-LOGIN shell: it reads
#    neither ~/.profile nor ~/.bashrc, so ~/.local/bin is almost certainly not
#    on PATH even when an interactive login session has it. Do not "fix" this
#    by sourcing a profile from a script — invoke herdr by absolute path, the
#    way this suite already invokes /usr/local/bin/docker.
ssh <nas> 'command -v herdr || echo "not on PATH — use the absolute path"'

# 3. Home directory. Synology home dirs only exist when the User Home service
#    is enabled; without it $HOME may be / and the config path is nonsense.
ssh <nas> 'echo "$HOME"; ls -d "$HOME/.config/herdr" 2>/dev/null || echo "no config dir yet"'
```

What those three returned, on herdr 0.8.0:

1. Present at the absolute path above.
2. **Not** on `PATH` — confirmed, so the warning stands: invoke it absolutely.
3. `HOME` is `/var/services/homes/sntxrr`, **not** the `/volume1` path. That is
   DSM's service symlink and it resolves to `/volume1/homes/sntxrr`, so both
   spellings reach the same directory and the User Home service is enabled. The
   socket lands at `$HOME/.config/herdr/herdr.sock`.

One thing the list did not cover: `herdr --help` advertises only `server stop`
and `server reload-config`, which reads as though bare `herdr server` were not a
command. It is — `herdr server --help` describes the group as "Run or control
the headless server", and the bare form is what runs it.

### 7.2 Making the server survive a reboot

**DSM has no systemd.** A headless `herdr server` started by hand dies with the
next reboot, and a seed that takes two weeks will meet one. Persistence on DSM
is *Control Panel → Task Scheduler → Create → Triggered Task → Boot-up*, run as
`sntxrr`. **Created 2026-08-16**, named `herdr server`, owner `sntxrr`, enabled.

It has to be created in the GUI: `synoschedtask` needs root and `sudo` on this
box prompts for a password, so there is no scripted path to it.

**The task body is not the bare command.** The obvious contents —

```
/volume1/homes/sntxrr/.local/bin/herdr server
```

— are wrong in two ways, and both were observed rather than reasoned about:

```bash
export HOME=/var/services/homes/sntxrr
setsid nohup /volume1/homes/sntxrr/.local/bin/herdr server \
  >/tmp/herdr-server.log 2>&1 </dev/null &
```

`setsid` is what makes the daemon outlive its parent. The scheduler runs the
script and then tears down its process group, exactly as `ssh host 'cmd &'`
does — a plain `nohup … &` server dies with the session, observed both ways.
`setsid` puts it in a new session, after which it reparents to PID 1 and
survives. Verified by running the task from Task Scheduler with the server
stopped, then confirming from a shell:

```
sntxrr  31064  1  /volume1/homes/sntxrr/.local/bin/herdr server
```

The `1` in the PPID column is the whole point of the exercise.

`HOME` is set explicitly because the socket path derives from it
(`$HOME/.config/herdr/herdr.sock`), and a boot-time task should not depend on
the shell having resolved a home directory the way an interactive login does.

Note that `herdr status server` reports `not running` for a moment after launch
while the socket is still being created; check it again rather than concluding
the start failed.

**The Boot-up trigger is proven.** `sinner` was rebooted 2026-08-16 (from 27 days
of uptime) and the server came back unattended:

```
sntxrr  17427  1  /volume1/homes/sntxrr/.local/bin/herdr server
status: running
```

The PID differs from the pre-reboot process, so this is a new one rather than a
survivor, and `/tmp/herdr-server.log` was rewritten — `/tmp` is cleared on boot,
so that file could only have come from the task. **The preflight is complete.**

Two things to expect from a reboot of this NAS, neither related to herdr:

- DSM takes roughly **five minutes** to answer SSH again, and container recovery
  runs well behind that. Nothing has failed at the two-minute mark; load average
  is still in double digits then.
- `Code-Server` is the one container set to `restart=on-failure`, which Docker
  does not reliably restart after a *clean* shutdown. Everything else on the box
  is `unless-stopped` or `always`. Start it by hand if you want it.

### 7.3 Running the seed

Two rules, both inherited from how herdr behaves elsewhere on this fleet:

**Start the seed inside herdr from the beginning.** A running process cannot be
adopted into a herdr session afterwards — it is bound to its original PTY, and
herdr does not reparent processes. Starting the seed in a bare SSH session and
planning to "move it in later" does not work; the only recovery is to kill it
and start again.

**Type the command into the pane's shell — do not use `herdr agent start`.**
`agent start` execs a binary directly, bypassing shell aliases and any
profile-sourced environment. That is exactly how the 1Password-sourced `claude`
alias gets skipped on the workstation, and the same mechanism would drop
whatever environment the seed depends on.

```bash
# 1. Generate the exact command — real code path, nothing uploaded.
#    Note the argument order: the CLI is `method run <model> <method>`.
swamp model method run archive-<share> push --input dryRun=true

# 2. Attach a named session on the NAS from your workstation.
herdr --remote <nas> --session glacier-seed

# 3. In the pane's shell, paste the generated docker/rclone command.
#    Detach freely; the session and the transfer outlive the SSH connection.

# Later, from anywhere:
herdr --remote <nas> --session glacier-seed     # reattach
herdr session list                              # what is running
```

Copy the command from step 1 rather than writing one. A hand-written invocation
that omits `--s3-storage-class` puts 9.6 TB at S3 Standard rates — about
$221/mo against $10 — and rclone will not mention it.

**This became true in 2026.08.19.1, and was not before.** Until then `dryRun`
logged only what it *would* pack; the assembled command was never printed at
any level, so step 1 produced nothing to paste and the only way to seed was to
write the invocation by hand — the exact thing the paragraph above forbids. It
now logs the command through the same `buildRcloneInvocation` the real run
uses, so the printed string and the executed string cannot drift.

Two properties of that emission are worth knowing before trusting it:

- **`--dry-run` is stripped, and only `--dry-run`.** The emitter filters the
  real argv rather than rebuilding it. Emitting the dry command would be worse
  than emitting nothing: it looks copy-pasteable, runs cleanly, and transfers
  not one byte.
- **A packed share emits one command per pack, not one command.** That is how
  the pack path really runs — one tar stream per top-level entry, each its own
  container — so a packed seed is a list to work through, and `direct` shares
  are the single-command case.

The command is safe to have on screen and in scrollback: credentials never
appear in it. They reach the container through the env-file streamed into a
FIFO, which shows up only as `"$ENVF"`, and `buildRcloneInvocation` *refuses*
to build a command whose argv contains a credential rather than redacting one.

**The command reads its credentials from its own stdin, and will hang if you
forget.** That is not a quirk to work around — it is the credential transport:
`docker run -e` leaks into `ps` on the NAS, and DSM cannot open `/dev/stdin`
(see CONVENTIONS §6), so the wrapper makes a FIFO and pipes an env file into
it. Pasted on its own the command does not fail with a clear error; it **blocks
in `cat` reading the terminal**, which reads as a hung transfer.

So step 1 prints the env file with the command, with the two secret values as
`<ACCESS_KEY_ID>` and `<SECRET_ACCESS_KEY>`. Supply them in the pane like this,
which keeps them out of scrollback:

```bash
# In the herdr pane on the NAS. -s suppresses the echo.
read -rs -p 'aws access key id: '     AKID; echo
read -rs -p 'aws secret access key: ' SK;   echo

printf 'RCLONE_CONFIG_DEST_TYPE=s3\n...\nRCLONE_CONFIG_DEST_ACCESS_KEY_ID=%s\nRCLONE_CONFIG_DEST_SECRET_ACCESS_KEY=%s\n' \
  "$AKID" "$SK" | <paste the command here>

unset AKID SK
```

Fill the `...` from the printed env file — the non-secret lines (type, provider,
region, location constraint, storage class) are printed verbatim and must be
passed through unchanged. **`RCLONE_CONFIG_DEST_STORAGE_CLASS` is one of them**,
so dropping a line here loses the storage class just as surely as dropping the
flag would, and just as silently.

The values stay in the pane's shell environment until `unset`, so they are
readable via `/proc/<pid>/environ` by that user for the life of the seed. That
is a deliberate trade against writing them to the NAS disk, where they would
outlive the transfer.

### 7.4 Handing over to swamp

Once the seed is complete, swamp takes the steady state. The handover is a
single **full** reconciliation push (no `--max-age`), which lists the
destination once and confirms nothing was missed while the seed was running.
Only after that passes should the windowed schedule start — a windowed run
assumes everything older than the window is already archived, and that is only
true once a full pass has said so.

## 8. Metrics (planned — not built)

The ladder is only as useful as its visibility, and "this rung has not run in
six weeks" is invisible unless something says so. The NAS already runs
Prometheus, Grafana, node-exporter, cAdvisor and SNMP as a compose stack.

> **The monitoring stack is deploy-managed and `rsync --delete`s the host
> directory.** Its source of truth is a private repo deployed with `make
> deploy`; any file on the host that is not in that repo is deleted on the next
> deploy. Every change below therefore goes in **via a PR to that repo**, never
> by editing the host. A textfile-collector directory placed inside the deployed
> tree without being tracked will be silently removed.

### 8.1 Shape: a separate model, pushing to a Pushgateway

Two designs work. The recommendation is a Pushgateway.

**Pushgateway (recommended).** Add `prom/pushgateway` to the monitoring compose
stack; Prometheus scrapes it with `honor_labels: true`; a new
`@sntxrr/prometheus-push` model POSTs metrics at the end of each rung. This is
the canonical pattern for *batch* jobs — which is exactly what these are — and
it needs no SSH and no file writing, since `swamp serve` can reach the NAS over
the tailnet.

Its one real trap: **Pushgateway metrics persist until explicitly deleted.**
Decommission a share and its last-known values sit there forever, graphing and
alerting as though the share still existed. Whatever emits metrics must also be
able to `DELETE /metrics/job/<job>/instance/<share>`, and decommissioning a
share must call it. This is the metrics equivalent of the leaked-multipart-upload
problem in §3: invisible state that accrues because nothing removes it.

**node-exporter textfile collector (alternative).** node-exporter is already
running, so this adds no service: write `*.prom` files to a mounted directory
and let it pick them up. Stale metrics vanish when the file is removed, which is
strictly better than the Pushgateway's persistence. The costs are that the
writer must reach the NAS filesystem (over the SSH transport this suite already
has), writes must be atomic (`write .tmp` then `mv`, or node-exporter reads a
half-written file), and the directory must sit outside the `rsync --delete`
tree or be tracked in the repo.

### 8.2 Metrics worth emitting

Mostly timestamps, because the failure mode is silence rather than error:

```
rclone_archive_last_success_timestamp_seconds{share,rung}
rclone_archive_push_success{share}                  # 1/0
rclone_archive_push_inconclusive{share}             # 1/0 — not the same as failure
rclone_archive_source_bytes{share}
rclone_archive_source_files{share}
rclone_archive_dest_bytes{share}
rclone_archive_churn_fraction{share}
rclone_archive_projected_cost_usd{share,kind="storage|overhead|egress|retrieval"}
rclone_archive_packs_uploaded_total{share}
rclone_archive_packs_failed{share}
```

Alerts that follow directly, and are the actual point:

- `time() - rclone_archive_last_success_timestamp_seconds{rung="push"} > 90000`
  — no successful push in 25 hours.
- `time() - rclone_archive_last_success_timestamp_seconds{rung="restoreDrill"} > 3456000`
  — no proven restore in 40 days. **A rung that has never run never fails, so
  this is the alert that catches the thing nothing else can.**
- `rclone_archive_churn_fraction > 0.2` — churn heading toward a
  180-day-minimum cost problem.
- `rclone_archive_projected_cost_usd{kind="storage"}` climbing sharply — the
  **storage-class detector**. A wrong class is otherwise invisible until AWS
  bills for it a month later; a cost line on a dashboard makes it a same-day
  finding.

Emitting `push_inconclusive` separately from `push_success` matters: a transfer
cap or a retry exhaustion is a normal outcome, and an alert that fires on those
is an alert that gets muted.

### 8.3 Sequencing

The emitter is a separate extension, reusable by the restic and Backblaze
suites, which have the same unanswered "did the rung run" question. Check the
registry before building it — `@keeb/prometheus` covers agent install and target
registration, and `@magistr/victoriametrics` covers the query side, but neither
pushes metrics from a batch job, so this looks like new work.

None of this blocks the archive. Build it after the seed and the first
successful drill, so the dashboard has real data to show rather than zeroes.

## 9. Shares that are not DSM shared folders

`/volume1` typically contains directories that are **not** DSM shared folders —
working directories created over SSH, leftovers from migrations, and loose files
sitting in the volume root.

They do not appear in Storage Analyzer's share list, in `synoshare --enum`, or
anywhere else that enumerates *shares*. A model-instance list generated from the
DSM share list therefore misses them silently. On the NAS this suite was built
for that was six directories and roughly 17 GB — small, but silence is the
problem rather than the size, and the next volume's number is not this one.

Enumerate what is actually there before trusting any share list:

```bash
ssh <nas> 'ls /volume1 | grep -v "^@"'   # everything, shares or not
```

Either add instances for them explicitly, or add one instance covering
`/volume1` itself with the real shares excluded. Do not assume the share list is
the volume.
