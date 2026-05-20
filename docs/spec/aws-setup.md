# AWS Setup — EC2 compute + S3 read tools (Phase 1)

This guide covers how to enable Research Copilot's Phase-1 AWS support
([RFC-009 §0.2](../../lib/docs/rfc/009-aws-multi-service-integration.md#02-phase-1-scope-next-implementation-cycle--the-clean-handoff)).
Phase 1 ships two AWS surfaces:

| Surface | What it does |
|---|---|
| **EC2 compute backend** | Provisions an instance, SSH-streams stdout to a local log, terminates on script exit. **No artifact copy-back** — the user script writes outputs to S3. |
| **S3 read tools** (`s3_download`, `s3_list`, `s3_presigned_url`) | Lets the agent retrieve those outputs after the run. |

Phase 1 does **not** include Bedrock, AWS Batch / Fargate / SageMaker,
S3 write tools, Lambda / CloudWatch / DynamoDB, telemetry/cost ledger,
or STS-role-assumption / SSO. See the RFC §0.2 deferred list for the
roadmap.

## 1. Prerequisites

Two IAM identities are involved and it pays to keep them straight:

- **Your IAM user** (§1.A) — the credentials you paste into Settings. This identity calls
  `RunInstances` / `TerminateInstances` etc. *from your laptop*.
- **The EC2 instance role** (§1.B) — a *separate* role that *launched instances* assume. The
  script running on the box uses it to `aws s3 cp` outputs to your bucket.

The most common Phase-1 setup failure is conflating the two (or creating the role but not the
matching instance profile — §1.B step 3 below).

### A. Your IAM user

1. Create the user (or pick an existing one) and attach the **inline policy below**. Don't try to
   substitute `AmazonEC2FullAccess` + `AmazonS3ReadOnlyAccess` + `IAMReadOnlyAccess` — those
   AWS-managed policies look right but omit `iam:PassRole`, and EC2 rejects `RunInstances` the
   moment you attach an instance profile. Replace `<account-id>` with your AWS account number and
   `<role-name>` with the EC2 instance role you'll create in §1.B:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "EC2Lifecycle",
         "Effect": "Allow",
         "Action": [
           "ec2:RunInstances",
           "ec2:DescribeInstances",
           "ec2:DescribeRegions",
           "ec2:TerminateInstances",
           "ec2:CreateTags"
         ],
         "Resource": "*"
       },
       {
         "Sid": "S3Read",
         "Effect": "Allow",
         "Action": ["s3:GetObject", "s3:ListBucket", "s3:GetBucketLocation"],
         "Resource": "*"
       },
       {
         "Sid": "PassEc2InstanceRole",
         "Effect": "Allow",
         "Action": "iam:PassRole",
         "Resource": "arn:aws:iam::<account-id>:role/<role-name>",
         "Condition": {
           "StringEquals": {"iam:PassedToService": "ec2.amazonaws.com"}
         }
       },
       {
         "Sid": "Sts",
         "Effect": "Allow",
         "Action": "sts:GetCallerIdentity",
         "Resource": "*"
       }
     ]
   }
   ```

   The `PassEc2InstanceRole` statement is the load-bearing piece — `iam:PassRole` is what lets
   your IAM user "hand" the EC2-side role over to a launching instance. The
   `iam:PassedToService` condition narrows the grant to EC2 only (best practice; prevents the role
   from being handed to Lambda, ECS, or anything else).

2. Generate an access key + secret access key for this user. You'll paste both into
   **Settings → Compute → AWS** (§2).

### B. EC2 instance role + matching instance profile

This is what *launched instances* assume — distinct from §1.A. The script running on the EC2 box
uses it to `aws s3 cp` outputs and call any other AWS APIs.

1. **Create the role.** Trust policy: `ec2.amazonaws.com` (so EC2 can assume it). In the AWS
   console: IAM → Roles → Create role → "AWS service" → "EC2".

2. **Attach permissions.** At minimum, grant `s3:PutObject` (and `s3:PutObjectAcl` if you upload
   with ACLs) on your output bucket. Inline policy is fine:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": ["s3:PutObject", "s3:AbortMultipartUpload"],
       "Resource": "arn:aws:s3:::<your-bucket>/*"
     }]
   }
   ```

3. **Make sure there's a matching instance profile.** The AWS console creates one automatically
   when you create the role through the wizard, but the CLI does NOT — you have to do it yourself:

   ```bash
   aws iam create-instance-profile --instance-profile-name <role-name>
   aws iam add-role-to-instance-profile \
       --instance-profile-name <role-name> --role-name <role-name>
   ```

   The `iamInstanceProfile` field you pass to `compute_plan` is the *instance profile* name (not
   the role name — they happen to match when the console creates them, but they're separate
   resources). Symptoms of missing this step: `RunInstances` fails with
   `"Invalid IAM instance profile name: <name>"`, the run never starts (so $0 charged), and the
   error often looks like an account/region mismatch because the resource genuinely doesn't exist.

### C. Key pair, security group, output bucket

1. **Key pair** — created in the target region (key pairs are region-scoped; `my-key` in
   us-east-1 is a different resource from `my-key` in us-west-2). Download the `.pem` and
   immediately `chmod 400 <key>.pem`, otherwise SSH refuses to use it ("Permission denied
   (publickey)"). Note `KeyName` to pass to `RunInstances`.

2. **Security group** — allow inbound SSH (port 22) from your public IP. The source CIDR is
   tied to whatever IP you create the rule from, so it expires when your IP changes (switching
   between home / office / cafe wifi is the usual trigger). Symptom: SSH stalls with
   `ETIMEDOUT` after the instance is otherwise healthy. Either widen the CIDR (with care) or
   re-edit the SG when you move.

3. **Output bucket** — in the same account, with the §1.B role granted `s3:PutObject` on it.

### D. The matching private key on this machine

Save the `.pem` from §1.C locally; we SSH using it. `privateKeyPath` in the plan input is the
absolute path. The `sshUser` you pass depends on the AMI you launch — Ubuntu AMIs default to
`ubuntu`, Amazon Linux to `ec2-user`. Mismatched user shows up as "Permission denied (publickey)"
even when the key itself is correct.

## 2. Configure the app

1. Open **Settings → Compute → AWS**.
2. Paste the access key ID + secret access key. (Optional: session
   token for short-lived STS / SSO credentials.) These are stored
   encrypted in `~/.research-copilot/config.json` and exported to the
   process at runtime — they are NOT written to the settings JSON in
   plaintext.
3. Set the **Default region** (e.g. `us-east-1`). Per-call overrides
   are supported on every S3 tool and the EC2 plan input — workflows
   that span regions don't need to flip this setting.
4. Click **Test connection**. You should see three green checks:
   - `STS GetCallerIdentity` — credentials are valid.
   - `EC2 DescribeRegions` — the key has EC2 read access.
   - `S3 ListBuckets` — the key has S3 read access.
5. Set the **Auto-kill threshold (USD)**. EC2 runs are terminated when
   elapsed estimated cost exceeds this number. The estimate uses
   on-demand us-east-1 pricing; EBS and network egress are not
   modeled, so leave headroom.

## 3. Run a job

EC2 plans require approval before submit — same gate as Modal. The
typical flow when chatting with the agent:

1. Ask the agent to "run this script on EC2 with a `t3.medium` in
   us-east-1, using key `my-research-key` and `~/.ssh/research.pem`."
2. The agent calls `compute_plan(backend='aws-ec2', ...)` and passes
   the full spec as the `backend_data` parameter (a JSON-encoded
   string — the tool layer parses it and threads it through as
   `PlanInput.backendData`; Phase 2 will auto-derive these fields via
   an LLM plan agent, but Phase 1 expects the caller to supply them):
   ```json
   {
     "instanceSpec": {
       "instanceType": "t3.medium",
       "region": "us-east-1",
       "amiId": "ami-0c11a84d2375a8e10",
       "keyName": "my-research-key",
       "privateKeyPath": "/Users/me/.ssh/research.pem",
       "sshUser": "ubuntu",
       "scriptPath": "scripts/train.sh",
       "iamInstanceProfile": "research-ec2-s3-writer",
       "securityGroupIds": ["sg-0abc123"],
       "rootVolumeGiB": 30
     },
     "taskProfile": {
       "expectedDurationClass": "minutes"
     }
   }
   ```
   Concretely the tool call looks like:
   ```
   compute_plan(
     backend="aws-ec2",
     command="bash scripts/train.sh",
     task_description="Train model on AWS",
     backend_data='{"instanceSpec":{...},"taskProfile":{...}}'   ← JSON string
   )
   ```
3. Approve the plan in the Compute tab. The backend issues
   `RunInstances`, persists the `instanceId` to the run ledger
   (`.research-pilot/compute-runs/aws-ec2-runs.jsonl`), polls until
   the instance has a public DNS, opens SSH, uploads the script via
   SFTP into `/tmp`, and `exec`s it. Stdout streams to
   `.research-pilot/compute-runs/<runId>/output.log` and the Compute
   tab tail updates every 5 s.
4. On script exit (or cost-kill, or timeout), the runner issues
   `TerminateInstances` and marks the run terminal.

## 4. The S3-as-artifact-pipeline contract

The EC2 backend never copies files back. Your script is expected to
upload its outputs explicitly:

```bash
#!/bin/bash
# ... do work ...
aws s3 cp ./outputs s3://my-bucket/runs/$RUN_ID/ --recursive
```

After the run completes, ask the agent to retrieve them:

> "Download `s3://my-bucket/runs/abc/results.json` into the workspace."

The agent calls `s3_download` which writes to
`<workspace>/s3-downloads/results.json` by default (override with
`output_path`). Other read tools available:

- `s3_list` — enumerate keys / prefixes under a bucket.
- `s3_presigned_url` — mint a time-limited HTTPS link (default 1h,
  max 7 days) to share or paste into a notebook.

Why this design (RFC-009 §0.2 Phase 1 design note): SCP-back-of-files
is ~200-300 LOC of fragile SSH/file-transfer code with retry and
completion-ordering semantics. S3 is the documented AWS pattern, the
script can upload incrementally so a partial run still has artifacts,
and the instance terminates the moment the script exits without
waiting on transfers.

## 5. Crash recovery

Every EC2 run is persisted to a JSONL ledger BEFORE
`submit()` returns. On app restart, `hydrate()` reads each non-terminal
row and queries `DescribeInstances`:

| AWS state | App state | Action |
|---|---|---|
| `terminated` / `shutting-down` | non-terminal | mark `failed` ("recovered after crash; AWS already cleaned up") |
| `running` | non-terminal | terminate the instance, mark `cancelled` ("recovered after crash; SSH stream lost, instance terminated to avoid orphan cost") |

**Zero orphan instances** is the invariant. If you ever find a
`research-copilot-*` tagged instance running but no matching row in
the ledger, file an issue — that's a bug.

## 6. Limitations / sharp edges (Phase 1)

- **Plan input is verbose.** Phase 1 has no LLM-driven plan agent for
  EC2 — the caller supplies the full `instanceSpec` via `backend_data`.
  Phase 2 will add one (the Modal backend's `plan-agent.ts` is the
  reference shape).
- **Cost estimator is coarse.** On-demand us-east-1 pricing only;
  unknown instance families fall back to $0.10/hr. The auto-kill
  threshold should account for this — leave a buffer.
- **No spot support.** Setting `useSpot: true` is accepted in the
  schema but currently runs on-demand. Phase 2.
- **No SCP back.** Outputs MUST go through S3 (see §4).
- **No Bedrock / Batch / Fargate / SageMaker.** Each lands in Phase 2+
  when a user case forces it.

### Three IAM gotchas we hit on first green smoke test

Captured here so the next user doesn't lose an evening to them:

1. **`Test connection` green ≠ `RunInstances` works.** STS / EC2-Describe /
   S3-ListBuckets only confirm the credentials can talk to AWS at all.
   They don't exercise `RunInstances` with an instance profile —
   that's where most permissions cliffs hide.

2. **`AWS_ACCESS_KEY_ID` in your shell shadows what you save in the UI**
   (fixed in `shared-electron/api-key-loader.ts` — UI now wins). If
   `Test connection` shows the wrong account ARN despite saving fresh
   keys, you used to need `unset AWS_ACCESS_KEY_ID` before launching
   the app; that's no longer required, but other apps (CLI, scripts)
   still see the shell env, so be mindful of which keys live where.

3. **`iam:PassRole` is the EC2-instance-profile gotcha.** AWS-managed
   policies (`AmazonEC2FullAccess` etc.) deliberately omit it; you
   need the inline policy in §1 with the `PassEc2InstanceRole`
   statement. Without it, EC2 rejects `RunInstances` with
   "User ... is not authorized to perform: iam:PassRole" and the
   instance never starts (so $0 charged — good failure mode, just
   not obvious from the encoded-auth-failure error string).

## 7. Files

- `lib/aws/credentials.ts` — shared credential provider
- `lib/aws-ec2-compute/` — runner, run store (ledger), cost estimator
- `lib/compute/backends/aws-ec2/aws-ec2-backend.ts` — ComputeBackend
  adapter
- `lib/tools/s3-tools.ts` — `s3_download` / `s3_list` /
  `s3_presigned_url`
- `app/src/main/ipc.ts` — `compute:test-aws-connection` handler +
  coordinator wiring
- `app/src/renderer/components/settings/ComputeSettings.tsx` — AWS
  section in Compute tab Settings
