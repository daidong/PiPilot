#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: init-grant-structure.sh <target-dir> [agency]" >&2
  exit 1
fi

TARGET_DIR="$1"
AGENCY="${2:-generic}"

mkdir -p "$TARGET_DIR"

cat > "$TARGET_DIR/00-overview.md" <<EOF
# Proposal Overview

Agency: ${AGENCY}

## Problem

## Why now

## Expected impact
EOF

cat > "$TARGET_DIR/01-specific-aims.md" <<'EOF'
# Specific Aims

## Aim 1
- Hypothesis:
- Method:
- Milestone:

## Aim 2
- Hypothesis:
- Method:
- Milestone:
EOF

cat > "$TARGET_DIR/02-methods.md" <<'EOF'
# Methods and Technical Plan

## Study design

## Data and infrastructure

## Validation and evaluation
EOF

cat > "$TARGET_DIR/03-risks-mitigation.md" <<'EOF'
# Risks and Mitigation

## Technical risks

## Programmatic risks

## Fallback plans
EOF

cat > "$TARGET_DIR/04-timeline-budget.md" <<'EOF'
# Timeline and Budget Rationale

## Timeline (quarterly milestones)

## Budget categories

## Budget justification
EOF

echo "grant structure initialized in $TARGET_DIR"
