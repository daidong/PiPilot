"""
Schema Inference Script

Reads a data file and outputs rich per-column schema information as JSON.
Supports CSV, TSV, JSON (records), and unstructured text files.

Usage: python3 schema-inference.py <file_path>

Output JSON structure:
{
  "isStructured": true/false,
  "rowCount": int,
  "columns": [ { "name", "dtype", "missingRate", "topKValues", "min", "max", "mean" } ],
  "sampleRows": [ [...], ... ],
  // For unstructured files:
  "firstLines": [...],
  "lineCount": int,
  "patterns": { "hasTimestamps", "hasDelimiters", "hasKeyValue" }
}
"""

import sys
import json
import os
import re

def infer_structured(file_path: str, ext: str) -> dict:
    """Infer schema from a structured file (CSV, TSV, JSON)."""
    import pandas as pd
    import numpy as np

    if ext == '.json':
        df = pd.read_json(file_path)
    elif ext == '.tsv':
        df = pd.read_csv(file_path, sep='\t', nrows=200)
    else:
        df = pd.read_csv(file_path, nrows=200)

    total_rows = len(df)

    # For large files, get actual row count from full file
    if ext != '.json':
        with open(file_path, 'r', errors='replace') as f:
            actual_rows = sum(1 for _ in f) - 1  # subtract header
        if actual_rows > total_rows:
            total_rows = actual_rows

    columns = []
    for col in df.columns:
        series = df[col]
        info: dict = {
            'name': str(col),
            'dtype': str(series.dtype),
            'missingRate': round(float(series.isna().mean()), 4)
        }

        if pd.api.types.is_numeric_dtype(series):
            clean = series.dropna()
            if len(clean) > 0:
                info['min'] = round(float(clean.min()), 6)
                info['max'] = round(float(clean.max()), 6)
                info['mean'] = round(float(clean.mean()), 6)
        else:
            # Categorical / string: top-K values
            vc = series.dropna().astype(str).value_counts().head(5)
            info['topKValues'] = [
                {'value': str(v), 'count': int(c)}
                for v, c in vc.items()
            ]

        columns.append(info)

    # Sample rows (up to 5 random rows)
    sample_n = min(5, len(df))
    sample_df = df.sample(n=sample_n, random_state=42) if sample_n > 0 else df.head(0)
    sample_rows = []
    for _, row in sample_df.iterrows():
        sample_rows.append([
            None if pd.isna(v) else (
                round(float(v), 6) if isinstance(v, (float, np.floating)) else
                int(v) if isinstance(v, (int, np.integer)) else
                str(v)
            )
            for v in row.values
        ])

    return {
        'isStructured': True,
        'rowCount': total_rows,
        'columns': columns,
        'sampleRows': sample_rows
    }


def infer_unstructured(file_path: str) -> dict:
    """Infer basic info from an unstructured text file."""
    with open(file_path, 'r', errors='replace') as f:
        lines = f.readlines()

    first_lines = [l.rstrip('\n') for l in lines[:20]]
    line_count = len(lines)

    # Pattern detection
    sample_text = '\n'.join(first_lines)
    has_timestamps = bool(re.search(
        r'\d{4}[-/]\d{2}[-/]\d{2}|\d{2}:\d{2}:\d{2}', sample_text
    ))
    has_delimiters = bool(re.search(r'[,\t|;]', sample_text))
    has_key_value = bool(re.search(r'\w+=\w+', sample_text))

    return {
        'isStructured': False,
        'rowCount': line_count,
        'columns': [],
        'firstLines': first_lines,
        'lineCount': line_count,
        'patterns': {
            'hasTimestamps': has_timestamps,
            'hasDelimiters': has_delimiters,
            'hasKeyValue': has_key_value
        }
    }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'Usage: python3 schema-inference.py <file_path>'}))
        sys.exit(1)

    file_path = sys.argv[1]
    if not os.path.exists(file_path):
        print(json.dumps({'error': f'File not found: {file_path}'}))
        sys.exit(1)

    ext = os.path.splitext(file_path)[1].lower()
    structured_exts = {'.csv', '.tsv', '.json'}

    try:
        if ext in structured_exts:
            result = infer_structured(file_path, ext)
        else:
            result = infer_unstructured(file_path)
    except Exception as e:
        # Fallback: treat as unstructured on any error
        try:
            result = infer_unstructured(file_path)
            result['inferenceWarning'] = f'Fell back to unstructured inference: {e}'
        except Exception as e2:
            result = {
                'isStructured': False,
                'rowCount': 0,
                'columns': [],
                'error': str(e2)
            }

    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
