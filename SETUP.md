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
rule. Objects are written *directly* as `GLACIER_DEEP_ARCHIVE` by rclone, so
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

## 6. First run, in order

```bash
# 1. What is there, and what would recovery cost?
swamp model @sntxrr/rclone-archive method run scan archive-<share>

# 2. Dry run. Nothing is billed, nothing is written.
swamp model @sntxrr/rclone-archive method run push archive-<share> --input dryRun=true

# 3. A capped real run against ONE small share before anything large.
swamp model @sntxrr/rclone-archive method run push archive-<share> \
  --input maxTransferBytes=1073741824

# 4. Inventory comparison
swamp model @sntxrr/rclone-archive method run verify archive-<share>

# 5. Prove it comes back. Bulk tier is 48 hours; run restoreDrill the next day.
swamp model @sntxrr/rclone-archive method run restoreRequest archive-<share> \
  --input objectPath=<key> --input allowRestore=true
swamp model @sntxrr/rclone-archive method run restoreDrill archive-<share> \
  --input objectPath=<key> --input sourceSha256=<sha>
```

Do not skip step 5 on the grounds that steps 1–4 passed. Everything below it
compares metadata, and metadata cannot see corruption — an archive that has
never been restored is an assumption, not a backup. That is the entire lesson
of `swamp-restic`, and it applies here with more force, because Deep Archive
makes the drill slow enough to be easy to postpone forever.

## 7. Shares that are not DSM shared folders

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
