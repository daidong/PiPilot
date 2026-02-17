#!/usr/bin/env python3
import argparse
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def slugify(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return normalized[:80] if normalized else "section"


def call_openai_draft(
    *,
    api_key: str,
    model: str,
    section_heading: str,
    section_outline: str,
    instructions: str,
    source_notes: str,
    citation_hints: str,
) -> dict:
    system = (
        "You are a research writing specialist. "
        "Return strict JSON only with keys: "
        "sectionHeading,content,wordCount,citationsUsed,suggestions. "
        "citationsUsed must be an array of objects with keys key and context."
    )
    user = "\n".join(
        [
            f"Section heading: {section_heading}",
            f"Section outline: {section_outline or '(none)'}",
            f"Instructions: {instructions or '(none)'}",
            f"Source notes: {source_notes or '(none)'}",
            f"Citation hints: {citation_hints or '(none)'}",
        ]
    )

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.3,
    }
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as response:
        body = response.read().decode("utf-8", errors="replace")
    parsed = json.loads(body)
    content = (
        parsed.get("choices", [{}])[0]
        .get("message", {})
        .get("content", "")
    )
    if not isinstance(content, str) or not content.strip():
        raise RuntimeError("empty response content")
    obj = json.loads(content)
    if not isinstance(obj, dict):
        raise RuntimeError("model did not return JSON object")
    return obj


def fallback_draft(section_heading: str, section_outline: str, instructions: str, source_notes: str, citation_hints: str) -> dict:
    lead = (
        f"{section_heading} is central to the argument because it connects motivation to execution. "
        "This section should clearly define assumptions, describe the proposed mechanism, and explain expected impacts."
    )
    body = (
        "The narrative should first establish the operational setting and constraints, then present the design choice "
        "with explicit tradeoffs in cost, robustness, and scalability. "
        "After introducing the mechanism, the text should walk through how it is evaluated and why the selected metrics "
        "are sufficient to validate the claim."
    )
    tail = (
        "Finally, the section should acknowledge limitations and explicitly transition to the next section, "
        "which can provide empirical evidence or ablation analysis."
    )
    extras = "\n".join(
        part for part in [
            f"Outline guidance: {section_outline}" if section_outline else "",
            f"Instruction notes: {instructions}" if instructions else "",
            f"Source notes: {source_notes}" if source_notes else "",
            f"Citation hints: {citation_hints}" if citation_hints else "",
        ]
        if part
    )
    content = "\n\n".join([lead, body, tail, extras]).strip()
    return {
        "sectionHeading": section_heading,
        "content": content,
        "wordCount": len(content.split()),
        "citationsUsed": [],
        "suggestions": "Fallback draft generated because model-assisted drafting was unavailable."
    }


def normalize_draft(obj: dict, section_heading: str) -> dict:
    content = str(obj.get("content") or "").strip()
    if not content:
        content = fallback_draft(section_heading, "", "", "", "").get("content", "")

    citations = obj.get("citationsUsed")
    normalized_citations = []
    if isinstance(citations, list):
        for row in citations:
            if not isinstance(row, dict):
                continue
            key = str(row.get("key") or "").strip()
            context = str(row.get("context") or "").strip()
            if not key and not context:
                continue
            normalized_citations.append({"key": key or "unknown", "context": context or "reference context"})

    word_count = obj.get("wordCount")
    if not isinstance(word_count, int) or word_count <= 0:
        word_count = len(content.split())

    return {
        "sectionHeading": str(obj.get("sectionHeading") or section_heading).strip() or section_heading,
        "content": content,
        "wordCount": word_count,
        "citationsUsed": normalized_citations,
        "suggestions": str(obj.get("suggestions") or "").strip(),
    }


def render_markdown(draft: dict, source: str, json_rel_path: str) -> str:
    lines = [
        f"# Draft: {draft.get('sectionHeading')}",
        "",
        f"- generated_at: {now_iso()}",
        f"- source: {source}",
        f"- word_count: {draft.get('wordCount')}",
        f"- json_path: {json_rel_path}",
        "",
        "## Content",
        "",
        draft.get("content") or "",
        "",
        "## Citations Used",
        "",
    ]
    citations = draft.get("citationsUsed") or []
    if citations:
        for row in citations:
            lines.append(f"- {row.get('key')}: {row.get('context')}")
    else:
        lines.append("- (none)")
    lines.extend(["", "## Suggestions", "", draft.get("suggestions") or "(none)", ""])
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Draft one writing section and persist artifacts.")
    parser.add_argument("--section-heading", required=True, help="Section heading")
    parser.add_argument("--section-outline", default="", help="Optional section outline")
    parser.add_argument("--instructions", default="", help="Optional drafting instructions")
    parser.add_argument("--source-notes", default="", help="Optional source notes")
    parser.add_argument("--citation-hints", default="", help="Optional citation keys/hints")
    parser.add_argument("--model", default="gpt-5.2", help="Model id for optional API-assisted drafting")
    parser.add_argument("--project-root", default=".", help="Project root directory")
    parser.add_argument("--output-dir", default=".yolo-researcher/library/writing", help="Relative output dir")
    args = parser.parse_args()

    section_heading = args.section_heading.strip()
    if not section_heading:
        print("AF_RESULT_JSON: " + json.dumps({
            "schema": "academic-writing.draft.v1",
            "success": False,
            "error": "section-heading is required",
        }))
        return 2

    project_root = os.path.abspath(args.project_root)
    output_dir = os.path.abspath(os.path.join(project_root, args.output_dir))
    os.makedirs(output_dir, exist_ok=True)

    api_key = (os.getenv("OPENAI_API_KEY") or "").strip()
    source = "fallback"
    warning = ""
    try:
        if api_key:
            raw_draft = call_openai_draft(
                api_key=api_key,
                model=args.model,
                section_heading=section_heading,
                section_outline=args.section_outline.strip(),
                instructions=args.instructions.strip(),
                source_notes=args.source_notes.strip(),
                citation_hints=args.citation_hints.strip(),
            )
            source = f"openai:{args.model}"
        else:
            raw_draft = fallback_draft(
                section_heading,
                args.section_outline.strip(),
                args.instructions.strip(),
                args.source_notes.strip(),
                args.citation_hints.strip(),
            )
            warning = "OPENAI_API_KEY not set; used fallback draft template."
    except Exception as exc:  # noqa: BLE001
        raw_draft = fallback_draft(
            section_heading,
            args.section_outline.strip(),
            args.instructions.strip(),
            args.source_notes.strip(),
            args.citation_hints.strip(),
        )
        warning = f"model draft failed; fallback used: {exc}"

    draft = normalize_draft(raw_draft, section_heading)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    stem = f"draft-{stamp}-{slugify(section_heading)}"
    json_path = os.path.join(output_dir, f"{stem}.json")
    md_path = os.path.join(output_dir, f"{stem}.md")

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(
            {
                "schema": "academic-writing.draft.v1",
                "generatedAt": now_iso(),
                "source": source,
                "input": {
                    "sectionHeading": section_heading,
                    "sectionOutline": args.section_outline.strip() or None,
                    "instructions": args.instructions.strip() or None,
                    "sourceNotes": args.source_notes.strip() or None,
                    "citationHints": args.citation_hints.strip() or None,
                },
                "draft": draft,
                "warning": warning or None,
            },
            f,
            ensure_ascii=False,
            indent=2,
        )
        f.write("\n")

    rel_json = os.path.relpath(json_path, project_root)
    rel_md = os.path.relpath(md_path, project_root)
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(render_markdown(draft, source, rel_json))

    print(f"Saved writing draft artifacts: {rel_json}, {rel_md}")
    print("AF_RESULT_JSON: " + json.dumps({
        "schema": "academic-writing.draft.v1",
        "success": True,
        "sectionHeading": draft.get("sectionHeading"),
        "wordCount": draft.get("wordCount"),
        "jsonPath": rel_json,
        "markdownPath": rel_md,
        "source": source,
        "warning": warning or None,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
