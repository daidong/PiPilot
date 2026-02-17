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
    return normalized[:80] if normalized else "outline"


def call_openai_outline(
    *,
    api_key: str,
    model: str,
    topic: str,
    doc_type: str,
    notes: str,
    literature_context: str,
) -> dict:
    system = (
        "You are a research writing specialist. "
        "Return strict JSON only with keys: "
        "title,type,sections,estimatedTotalWords,notes. "
        "sections must be a non-empty list with fields: "
        "heading,level,description,subsections,suggestedWordCount,citationsNeeded."
    )
    user = "\n".join(
        [
            f"Topic: {topic}",
            f"Document type: {doc_type}",
            f"Notes: {notes or '(none)'}",
            f"Literature context: {literature_context or '(none)'}",
        ]
    )

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.2,
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


def fallback_outline(topic: str, doc_type: str, notes: str, literature_context: str) -> dict:
    context_hint = (literature_context or notes or "").strip()
    citation_seed = "related work" if not context_hint else context_hint[:120]
    return {
        "title": topic.strip() or "Untitled Research Document",
        "type": doc_type,
        "sections": [
            {
                "heading": "Introduction",
                "level": 1,
                "description": "Motivation, problem tension, and contribution preview.",
                "subsections": [
                    "Problem context",
                    "Why current approaches are insufficient",
                    "Main contributions",
                ],
                "suggestedWordCount": 700,
                "citationsNeeded": [citation_seed, "problem framing"],
            },
            {
                "heading": "Method",
                "level": 1,
                "description": "Approach design, assumptions, and key mechanisms.",
                "subsections": [
                    "System design",
                    "Decision policy",
                    "Complexity and cost considerations",
                ],
                "suggestedWordCount": 1200,
                "citationsNeeded": ["method baseline", "design alternatives"],
            },
            {
                "heading": "Evaluation Plan",
                "level": 1,
                "description": "Metrics, datasets/tasks, and ablation strategy.",
                "subsections": [
                    "Primary metrics",
                    "Baselines and controls",
                    "Ablations and error analysis",
                ],
                "suggestedWordCount": 900,
                "citationsNeeded": ["benchmark protocol", "evaluation metrics"],
            },
            {
                "heading": "Discussion and Conclusion",
                "level": 1,
                "description": "Implications, limitations, and next steps.",
                "subsections": [
                    "Key findings",
                    "Limitations",
                    "Future directions",
                ],
                "suggestedWordCount": 600,
                "citationsNeeded": ["limitations", "future work"],
            },
        ],
        "estimatedTotalWords": 3400,
        "notes": "Fallback template generated because model-assisted outline was unavailable."
    }


def normalize_outline(obj: dict, topic: str, doc_type: str) -> dict:
    sections = obj.get("sections")
    if not isinstance(sections, list):
        sections = []

    normalized_sections = []
    for idx, row in enumerate(sections):
        if not isinstance(row, dict):
            continue
        heading = str(row.get("heading") or "").strip()
        if not heading:
            heading = f"Section {idx + 1}"
        level = row.get("level")
        if not isinstance(level, int) or level < 1:
            level = 1
        description = str(row.get("description") or "").strip()
        subsections_raw = row.get("subsections")
        subsections = []
        if isinstance(subsections_raw, list):
            for item in subsections_raw:
                if isinstance(item, str) and item.strip():
                    subsections.append(item.strip())
        citations_raw = row.get("citationsNeeded")
        citations = []
        if isinstance(citations_raw, list):
            for item in citations_raw:
                if isinstance(item, str) and item.strip():
                    citations.append(item.strip())
        word_count = row.get("suggestedWordCount")
        if not isinstance(word_count, int) or word_count <= 0:
            word_count = 500

        normalized_sections.append(
            {
                "heading": heading,
                "level": level,
                "description": description or "Describe this section's role in the narrative.",
                "subsections": subsections,
                "suggestedWordCount": word_count,
                "citationsNeeded": citations,
            }
        )

    if not normalized_sections:
        normalized_sections = fallback_outline(topic, doc_type, "", "").get("sections", [])

    estimated_total_words = obj.get("estimatedTotalWords")
    if not isinstance(estimated_total_words, int) or estimated_total_words <= 0:
        estimated_total_words = sum(int(item.get("suggestedWordCount", 0)) for item in normalized_sections)

    return {
        "title": str(obj.get("title") or topic or "Untitled Research Document").strip(),
        "type": str(obj.get("type") or doc_type or "paper").strip(),
        "sections": normalized_sections,
        "estimatedTotalWords": estimated_total_words,
        "notes": str(obj.get("notes") or "").strip(),
    }


def render_markdown(outline: dict, source: str, json_rel_path: str) -> str:
    lines = [
        f"# Outline: {outline.get('title')}",
        "",
        f"- generated_at: {now_iso()}",
        f"- source: {source}",
        f"- type: {outline.get('type')}",
        f"- estimated_total_words: {outline.get('estimatedTotalWords')}",
        f"- json_path: {json_rel_path}",
        "",
        "## Sections",
        "",
    ]

    for idx, section in enumerate(outline.get("sections", []), start=1):
        heading = section.get("heading")
        lines.append(f"### {idx}. {heading}")
        lines.append(f"- level: {section.get('level')}")
        lines.append(f"- suggested_word_count: {section.get('suggestedWordCount')}")
        lines.append(f"- description: {section.get('description')}")
        subsections = section.get("subsections") or []
        lines.append("- subsections:")
        if subsections:
            for sub in subsections:
                lines.append(f"  - {sub}")
        else:
            lines.append("  - (none)")
        citations = section.get("citationsNeeded") or []
        lines.append("- citations_needed:")
        if citations:
            for cite in citations:
                lines.append(f"  - {cite}")
        else:
            lines.append("  - (none)")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate a research writing outline and persist artifacts.")
    parser.add_argument("--topic", required=True, help="Writing topic/title")
    parser.add_argument("--doc-type", default="paper", choices=["paper", "report", "review", "proposal"])
    parser.add_argument("--notes", default="", help="Additional notes")
    parser.add_argument("--literature-context", default="", help="Related-work context")
    parser.add_argument("--model", default="gpt-5.2", help="Model id for optional API-assisted drafting")
    parser.add_argument("--project-root", default=".", help="Project root directory")
    parser.add_argument("--output-dir", default=".yolo-researcher/library/writing", help="Relative output dir")
    args = parser.parse_args()

    topic = args.topic.strip()
    if not topic:
        print("AF_RESULT_JSON: " + json.dumps({
            "schema": "academic-writing.outline.v1",
            "success": False,
            "error": "topic is required",
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
            raw_outline = call_openai_outline(
                api_key=api_key,
                model=args.model,
                topic=topic,
                doc_type=args.doc_type,
                notes=args.notes.strip(),
                literature_context=args.literature_context.strip(),
            )
            source = f"openai:{args.model}"
        else:
            raw_outline = fallback_outline(topic, args.doc_type, args.notes.strip(), args.literature_context.strip())
            warning = "OPENAI_API_KEY not set; used fallback outline template."
    except Exception as exc:  # noqa: BLE001
        raw_outline = fallback_outline(topic, args.doc_type, args.notes.strip(), args.literature_context.strip())
        warning = f"model outline failed; fallback used: {exc}"

    outline = normalize_outline(raw_outline, topic, args.doc_type)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    stem = f"outline-{stamp}-{slugify(topic)}"
    json_path = os.path.join(output_dir, f"{stem}.json")
    md_path = os.path.join(output_dir, f"{stem}.md")

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(
            {
                "schema": "academic-writing.outline.v1",
                "generatedAt": now_iso(),
                "source": source,
                "topic": topic,
                "docType": args.doc_type,
                "outline": outline,
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
        f.write(render_markdown(outline, source, rel_json))

    print(f"Saved writing outline artifacts: {rel_json}, {rel_md}")
    print("AF_RESULT_JSON: " + json.dumps({
        "schema": "academic-writing.outline.v1",
        "success": True,
        "topic": topic,
        "title": outline.get("title"),
        "estimatedTotalWords": outline.get("estimatedTotalWords"),
        "jsonPath": rel_json,
        "markdownPath": rel_md,
        "source": source,
        "warning": warning or None,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
