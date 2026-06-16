#!/usr/bin/env python3
"""Convert a GAIA split's metadata.parquet to metadata.jsonl.

The GAIA HuggingFace dataset ships metadata as parquet, which Node can't
read without an extra dependency. The headless bench runner
(scripts/bench-gaia.ts) consumes JSONL, so we do a one-time conversion here.

Usage:
    python3 scripts/gaia_to_jsonl.py [GAIA_DIR] [SPLIT]

  GAIA_DIR  root of the downloaded dataset (default: ~/Desktop/Provenance/gaia-data)
  SPLIT     validation | test                (default: validation)

Writes <GAIA_DIR>/2023/<split>/metadata.jsonl with one task per line.
Requires pandas + pyarrow (the anaconda python has both:
  /opt/anaconda3/bin/python scripts/gaia_to_jsonl.py).
"""
import json
import os
import sys

import pandas as pd

gaia_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser(
    "~/Desktop/Provenance/gaia-data"
)
split = sys.argv[2] if len(sys.argv) > 2 else "validation"

src = os.path.join(gaia_dir, "2023", split, "metadata.parquet")
dst = os.path.join(gaia_dir, "2023", split, "metadata.jsonl")

if not os.path.exists(src):
    sys.exit(f"parquet not found: {src}")

df = pd.read_parquet(src)
n = 0
with open(dst, "w", encoding="utf-8") as f:
    for _, row in df.iterrows():
        rec = {k: (None if pd.isna(v) else v) for k, v in row.to_dict().items()}
        # Annotator Metadata is a nested dict — keep it as-is.
        f.write(json.dumps(rec, ensure_ascii=False, default=str) + "\n")
        n += 1

print(f"wrote {n} tasks -> {dst}")
