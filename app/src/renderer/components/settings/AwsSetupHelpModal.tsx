/**
 * AWS setup help dialog — surfaces the contents of
 * `docs/spec/aws-setup.md` inside the app so users don't have to dig
 * through the repo to find prerequisites + the inline IAM policy.
 *
 * The IAM policy JSON has a one-click copy button — the field that
 * users get wrong most often (managed policies look right but omit
 * `iam:PassRole`).
 */

import React, { useEffect, useRef, useState } from 'react'
import { X, Copy, Check, ExternalLink } from 'lucide-react'

interface Props {
  open: boolean
  onClose: () => void
}

const IAM_POLICY_JSON = `{
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
}`

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function AwsSetupHelpModal({ open, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!open) return
    const trigger = document.activeElement as HTMLElement | null
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current
      if (!panel) return
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      ;(focusables[0] ?? panel).focus()
    })
    return () => {
      cancelAnimationFrame(frame)
      if (trigger && document.contains(trigger)) trigger.focus?.()
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (!active || !panel.contains(active)) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [open, onClose])

  const copyPolicy = async () => {
    try {
      await navigator.clipboard.writeText(IAM_POLICY_JSON)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard API not available — fall through silently; user can still select+copy
    }
  }

  const openExternal = (url: string) => (e: React.MouseEvent) => {
    e.preventDefault()
    window.open(url, '_blank')
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="aws-help-title"
        tabIndex={-1}
        className="relative w-full max-w-2xl max-h-[85vh] rounded-xl border t-border t-bg-surface shadow-xl overflow-hidden flex flex-col outline-none"
      >
        <header className="flex items-center justify-between px-5 py-3 border-b t-border-subtle shrink-0">
          <h2 id="aws-help-title" className="text-[14px] font-semibold t-text">
            How to configure AWS
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded-md t-text-muted hover:t-text hover:t-bg-hover"
          >
            <X size={14} />
          </button>
        </header>

        <div className="overflow-y-auto px-5 py-4 space-y-5 text-[12px] t-text-secondary leading-relaxed">
          <section>
            <p>
              Research Copilot's AWS support (Phase 1) provisions an EC2 instance to run your
              script, streams stdout back via SSH, and gives the agent S3 <em>read</em> tools to
              pull outputs after the run. The script is expected to upload outputs to S3 itself —
              the backend does not SCP files back.
            </p>
          </section>

          <section>
            <h3 className="text-[12px] font-semibold t-text mb-1.5">1. Prerequisites in AWS</h3>
            <p className="mb-2">
              Two IAM identities are involved — keep them straight: <strong>your IAM user</strong>
              {' '}(the credentials you paste here, used from your laptop to call
              {' '}<code className="font-mono">RunInstances</code>) and the
              {' '}<strong>EC2 instance role</strong> (a separate role that launched instances
              {' '}assume, used by the script to <code className="font-mono">aws s3 cp</code>
              {' '}outputs).
            </p>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                An IAM user with the inline policy below (don't substitute
                {' '}<code className="font-mono">AmazonEC2FullAccess</code> — it omits
                {' '}<code className="font-mono">iam:PassRole</code> and
                {' '}<code className="font-mono">RunInstances</code> will fail).
              </li>
              <li>
                An EC2 instance role with trust <code className="font-mono">ec2.amazonaws.com</code>
                {' '}and <code className="font-mono">s3:PutObject</code> on your output bucket — plus
                {' '}a <strong>matching instance profile</strong> with the role attached. The AWS
                {' '}console creates both when you make the role; the CLI does not (you'd need
                {' '}<code className="font-mono">aws iam create-instance-profile</code> +
                {' '}<code className="font-mono">add-role-to-instance-profile</code>).
              </li>
              <li>
                A key pair created <em>in your target region</em> (key pairs are region-scoped) —
                {' '}save the <code className="font-mono">.pem</code> locally and immediately
                {' '}<code className="font-mono">chmod 400 &lt;key&gt;.pem</code>.
              </li>
              <li>A security group that allows inbound SSH (port 22) from your public IP.</li>
              <li>An S3 bucket the script can write outputs to.</li>
            </ul>
            <a
              href="https://console.aws.amazon.com/iam/home#/policies"
              onClick={openExternal('https://console.aws.amazon.com/iam/home#/policies')}
              className="mt-2 inline-flex items-center gap-1 text-[11px] t-text-muted hover:t-text"
            >
              Open IAM policies in AWS console <ExternalLink size={10} />
            </a>
          </section>

          <section>
            <div className="flex items-center justify-between mb-1.5">
              <h3 className="text-[12px] font-semibold t-text">2. Inline IAM policy</h3>
              <button
                type="button"
                onClick={() => void copyPolicy()}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md border t-border text-[11px] t-text-secondary hover:t-text"
              >
                {copied ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />}
                {copied ? 'Copied' : 'Copy JSON'}
              </button>
            </div>
            <p className="mb-1.5">
              Replace <code className="font-mono">&lt;account-id&gt;</code> with your account
              number and <code className="font-mono">&lt;role-name&gt;</code> with the EC2 instance
              role you'll attach to launched instances (the role that grants the script
              {' '}<code className="font-mono">s3:PutObject</code> on your output bucket).
            </p>
            <pre className="rounded-md border t-border-subtle t-bg-base px-3 py-2 text-[11px] font-mono whitespace-pre overflow-x-auto leading-snug">
              {IAM_POLICY_JSON}
            </pre>
            <p className="mt-1.5 text-[11px] t-text-muted">
              The <code className="font-mono">PassEc2InstanceRole</code> statement is the
              load-bearing piece — it lets your IAM user hand the EC2-side role over to a
              launching instance, scoped to EC2 only.
            </p>
          </section>

          <section>
            <h3 className="text-[12px] font-semibold t-text mb-1.5">3. Configure in this app</h3>
            <ol className="list-decimal pl-5 space-y-1">
              <li>Paste the access key ID + secret access key into the AWS section.</li>
              <li>(Optional) Add a session token for short-lived STS / SSO credentials.</li>
              <li>Set the default region (e.g. <code className="font-mono">us-east-1</code>). Per-call overrides are supported on every S3 tool and the EC2 plan input.</li>
              <li>Click <strong>Test connection</strong>. Three green checks confirm STS, EC2 read, and S3 read access.</li>
              <li>Set the <strong>Auto-kill threshold (USD)</strong>. Leave headroom — the estimator uses on-demand us-east-1 pricing and does not model EBS / network egress.</li>
            </ol>
            <p className="mt-2 text-[11px] t-text-muted">
              Keys are stored in plaintext in <code className="font-mono">~/.research-copilot/config.json</code>
              {' '}(owner-only file permissions) and exported to the EC2 backend + S3 tools as
              {' '}<code className="font-mono">AWS_ACCESS_KEY_ID</code> /
              {' '}<code className="font-mono">AWS_SECRET_ACCESS_KEY</code>
              {' '}(+ optional <code className="font-mono">AWS_SESSION_TOKEN</code>).
            </p>
          </section>

          <section>
            <h3 className="text-[12px] font-semibold t-text mb-1.5">4. S3 as the artifact pipeline</h3>
            <p>
              The EC2 backend never copies files back. Your script should upload outputs to S3
              explicitly, then ask the agent to retrieve them:
            </p>
            <pre className="mt-1.5 rounded-md border t-border-subtle t-bg-base px-3 py-2 text-[11px] font-mono whitespace-pre overflow-x-auto leading-snug">
{`#!/bin/bash
# ... do work ...
aws s3 cp ./outputs s3://my-bucket/runs/$RUN_ID/ --recursive`}
            </pre>
            <p className="mt-1.5">
              Read-side tools available to the agent:
              {' '}<code className="font-mono">s3_download</code>,
              {' '}<code className="font-mono">s3_list</code>,
              {' '}<code className="font-mono">s3_presigned_url</code>.
            </p>
          </section>

          <section>
            <h3 className="text-[12px] font-semibold t-text mb-1.5">Gotchas — at submit time</h3>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                <strong>Test connection passing ≠ RunInstances works.</strong> STS / EC2-Describe /
                S3-ListBuckets only confirm the credentials reach AWS — they don't exercise
                {' '}<code className="font-mono">RunInstances</code> with an instance profile.
              </li>
              <li>
                <strong>Shell <code className="font-mono">AWS_*</code> env vars used to shadow saved keys.</strong>
                {' '}Fixed — the UI now wins. Still worth knowing if other tools on your machine see
                different keys than this app does.
              </li>
              <li>
                <strong><code className="font-mono">iam:PassRole</code> is the EC2 instance-profile cliff.</strong>
                {' '}Without it you'll see "is not authorized to perform: iam:PassRole" and the
                instance never starts ($0 charged — good failure mode, just not obvious from the
                encoded error string).
              </li>
              <li>
                <strong>"Invalid IAM instance profile name" usually means you created the role but
                {' '}not the matching instance profile.</strong> AWS console makes both; the CLI
                {' '}does not. Run <code className="font-mono">aws iam create-instance-profile</code>
                {' '}+ <code className="font-mono">add-role-to-instance-profile</code>.
              </li>
            </ul>
          </section>

          <section>
            <h3 className="text-[12px] font-semibold t-text mb-1.5">Gotchas — at SSH / runtime</h3>
            <p className="mb-1.5">
              These don't surface during <strong>Test connection</strong> — they only bite after
              the instance is launched. The runner surfaces targeted suggestions in the run's
              {' '}<code className="font-mono">failure.suggestions</code> when it recognizes the
              {' '}error, but you'll lose a turn for each one you hit blind.
            </p>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                <strong>SSH "Permission denied (publickey)" — wrong file permissions.</strong>
                {' '}The <code className="font-mono">.pem</code> file MUST be
                {' '}<code className="font-mono">chmod 400</code>. SSH refuses to use a key that's
                {' '}group/world-readable.
              </li>
              <li>
                <strong>SSH "Permission denied (publickey)" — wrong <code className="font-mono">sshUser</code>.</strong>
                {' '}It depends on the AMI: Ubuntu AMIs use <code className="font-mono">ubuntu</code>,
                {' '}Amazon Linux uses <code className="font-mono">ec2-user</code>. Mismatched user
                {' '}looks identical to a bad key.
              </li>
              <li>
                <strong>SSH stalls with <code className="font-mono">ETIMEDOUT</code> after a known-good setup.</strong>
                {' '}Your public IP changed (home → office, switched wifi, VPN on/off) and the
                {' '}security group's source CIDR no longer matches. Re-edit the SG rule from your
                {' '}current IP.
              </li>
              <li>
                <strong>AMI ids are region-scoped.</strong>
                {' '}<code className="font-mono">ami-xxx</code> in us-east-1 is a different image
                {' '}from us-west-2. Look up the right one per region with
                {' '}<code className="font-mono">aws ssm get-parameter --name /aws/service/.../ami-id --region &lt;region&gt;</code>.
              </li>
            </ul>
          </section>
        </div>

        <footer className="flex justify-end gap-2 px-5 py-3 border-t t-border-subtle shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg border t-border t-bg-elevated t-text text-[12px] font-medium hover:t-bg-hover transition-colors"
          >
            Got it
          </button>
        </footer>
      </div>
    </div>
  )
}
