#!/usr/bin/env python3
import argparse
import csv
import json
import math
import os
import statistics
import sys
from datetime import datetime, timezone


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def to_number(value: str):
    text = (value or "").strip()
    if text == "":
        return None
    try:
        return float(text)
    except ValueError:
        return None


def summarize_csv(file_path: str) -> dict:
    with open(file_path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
        headers = reader.fieldnames or []

    missing_cells = 0
    numeric_columns = {}
    for header in headers:
        values = []
        for row in rows:
            raw = row.get(header, "")
            if raw is None or str(raw).strip() == "":
                missing_cells += 1
            num = to_number(str(raw))
            if num is not None:
                values.append(num)
        if values:
            numeric_columns[header] = values

    numeric_summary = {}
    for name, values in numeric_columns.items():
        if not values:
            continue
        try:
            std_val = statistics.pstdev(values) if len(values) > 1 else 0.0
        except Exception:  # noqa: BLE001
            std_val = 0.0
        numeric_summary[name] = {
            "count": len(values),
            "min": min(values),
            "max": max(values),
            "mean": statistics.fmean(values),
            "std": std_val,
        }

    return {
        "rowCount": len(rows),
        "columnCount": len(headers),
        "columns": headers,
        "missingCells": missing_cells,
        "numericSummary": numeric_summary,
    }


def write_transform_copy(file_path: str, output_dir: str) -> str:
    target_path = os.path.join(output_dir, "transformed.csv")
    with open(file_path, "r", encoding="utf-8", newline="") as src:
        reader = csv.reader(src)
        rows = [[cell.strip() for cell in row] for row in reader]
    with open(target_path, "w", encoding="utf-8", newline="") as dst:
        writer = csv.writer(dst)
        writer.writerows(rows)
    return target_path


def maybe_make_histogram(file_path: str, output_dir: str) -> str | None:
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception:  # noqa: BLE001
        return None

    summary = summarize_csv(file_path)
    numeric = summary.get("numericSummary", {})
    if not numeric:
        return None

    first_col = sorted(numeric.keys())[0]
    values = []
    with open(file_path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            value = to_number(str(row.get(first_col, "")))
            if value is not None and not math.isnan(value):
                values.append(value)
    if not values:
        return None

    fig_path = os.path.join(output_dir, f"hist-{first_col}.png")
    plt.figure(figsize=(8, 5), dpi=140)
    plt.hist(values, bins=min(30, max(8, int(len(values) ** 0.5))), color="#14b8a6", edgecolor="#0f172a")
    plt.title(f"Distribution of {first_col}")
    plt.xlabel(first_col)
    plt.ylabel("Frequency")
    plt.tight_layout()
    plt.savefig(fig_path)
    plt.close()
    return fig_path


def render_markdown(result: dict, json_rel_path: str) -> str:
    lines = [
        f"# Data Analysis Result: {result.get('taskType')}",
        "",
        f"- generated_at: {result.get('generatedAt')}",
        f"- source_file: {result.get('filePath')}",
        f"- json_path: {json_rel_path}",
        "",
        "## Summary",
        "",
        f"- rows: {result.get('summary', {}).get('rowCount')}",
        f"- columns: {result.get('summary', {}).get('columnCount')}",
        f"- missing_cells: {result.get('summary', {}).get('missingCells')}",
        "",
        "## Numeric Columns",
        "",
    ]

    numeric = result.get("summary", {}).get("numericSummary", {})
    if isinstance(numeric, dict) and numeric:
        for name, row in numeric.items():
            if not isinstance(row, dict):
                continue
            lines.extend(
                [
                    f"### {name}",
                    f"- count: {row.get('count')}",
                    f"- min: {row.get('min')}",
                    f"- max: {row.get('max')}",
                    f"- mean: {row.get('mean')}",
                    f"- std: {row.get('std')}",
                    "",
                ]
            )
    else:
        lines.extend(["- (none)", ""])

    lines.extend(["## Outputs", ""])
    outputs = result.get("outputs", [])
    if isinstance(outputs, list) and outputs:
        for out in outputs:
            lines.append(f"- {out}")
    else:
        lines.append("- (none)")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run bounded data analysis and persist artifacts.")
    parser.add_argument("--file", required=True, help="Dataset path (relative to project root or absolute)")
    parser.add_argument("--task", default="analyze", choices=["analyze", "visualize", "transform", "model"], help="Task type")
    parser.add_argument("--instructions", default="", help="Optional instructions")
    parser.add_argument("--project-root", default=".", help="Project root")
    parser.add_argument("--output-dir", default=".yolo-researcher/library/data-analysis", help="Relative output dir")
    args = parser.parse_args()

    project_root = os.path.abspath(args.project_root)
    file_path = args.file
    if not os.path.isabs(file_path):
        file_path = os.path.abspath(os.path.join(project_root, file_path))

    if not os.path.isfile(file_path):
        print("AF_RESULT_JSON: " + json.dumps({
            "schema": "data-analysis.result.v1",
            "success": False,
            "error": f"file not found: {args.file}",
        }))
        return 2

    output_dir = os.path.abspath(os.path.join(project_root, args.output_dir))
    os.makedirs(output_dir, exist_ok=True)

    summary = summarize_csv(file_path)
    outputs: list[str] = []
    warnings: list[str] = []

    if args.task == "transform":
        transformed = write_transform_copy(file_path, output_dir)
        outputs.append(os.path.relpath(transformed, project_root))
    elif args.task == "visualize":
        hist_path = maybe_make_histogram(file_path, output_dir)
        if hist_path:
            outputs.append(os.path.relpath(hist_path, project_root))
        else:
            warnings.append("matplotlib unavailable or no numeric columns; skipped visualization output")
    elif args.task == "model":
        warnings.append("model task currently emits statistical baseline only (no ML fit)")

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    stem = f"{args.task}-{stamp}"
    json_path = os.path.join(output_dir, f"{stem}.json")
    md_path = os.path.join(output_dir, f"{stem}.md")

    payload = {
        "schema": "data-analysis.result.v1",
        "generatedAt": now_iso(),
        "taskType": args.task,
        "filePath": os.path.relpath(file_path, project_root),
        "instructions": args.instructions.strip() or None,
        "summary": summary,
        "outputs": outputs,
        "warnings": warnings,
    }

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")

    rel_json = os.path.relpath(json_path, project_root)
    rel_md = os.path.relpath(md_path, project_root)
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(render_markdown(payload, rel_json))

    print(f"Saved data analysis artifacts: {rel_json}, {rel_md}")
    print("AF_RESULT_JSON: " + json.dumps({
        "schema": "data-analysis.result.v1",
        "success": True,
        "taskType": args.task,
        "jsonPath": rel_json,
        "markdownPath": rel_md,
        "outputs": outputs,
        "rowCount": summary.get("rowCount"),
        "columnCount": summary.get("columnCount"),
        "warnings": warnings,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
