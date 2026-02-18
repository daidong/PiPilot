#!/usr/bin/env python3
import argparse
import json
import os
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def slugify(text: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return normalized[:80] if normalized else "query"


def read_url(url: str, timeout_sec: int = 20) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "AgentFoundry-LiteratureSkill/1.0"})
    with urllib.request.urlopen(req, timeout=timeout_sec) as response:
        return response.read().decode("utf-8", errors="replace")


def openalex_abstract(item: dict) -> str:
    inverted = item.get("abstract_inverted_index")
    if not isinstance(inverted, dict):
        return ""

    max_pos = -1
    for positions in inverted.values():
        if isinstance(positions, list):
            for pos in positions:
                if isinstance(pos, int) and pos > max_pos:
                    max_pos = pos
    if max_pos < 0:
        return ""

    tokens = [""] * (max_pos + 1)
    for token, positions in inverted.items():
        if not isinstance(token, str) or not isinstance(positions, list):
            continue
        for pos in positions:
            if isinstance(pos, int) and 0 <= pos <= max_pos:
                tokens[pos] = token

    return " ".join(t for t in tokens if t).strip()


def search_openalex(query: str, limit: int) -> list[dict]:
    params = urllib.parse.urlencode({"search": query, "per-page": str(limit)})
    url = f"https://api.openalex.org/works?{params}"
    raw = read_url(url)
    data = json.loads(raw)
    results = []

    for item in data.get("results", []):
        if not isinstance(item, dict):
            continue
        title = (item.get("title") or "").strip()
        if not title:
            continue
        authors = []
        for auth in item.get("authorships", []):
            if isinstance(auth, dict):
                author = auth.get("author")
                if isinstance(author, dict):
                    name = (author.get("display_name") or "").strip()
                    if name:
                        authors.append(name)

        doi = (item.get("doi") or "").strip()
        if doi.startswith("https://doi.org/"):
            doi = doi[len("https://doi.org/"):]

        results.append({
            "source": "openalex",
            "id": str(item.get("id") or "").strip() or None,
            "title": title,
            "authors": authors,
            "year": item.get("publication_year"),
            "abstract": openalex_abstract(item),
            "venue": ((item.get("primary_location") or {}).get("source") or {}).get("display_name"),
            "doi": doi or None,
            "url": item.get("primary_location", {}).get("landing_page_url") or item.get("id"),
            "pdfUrl": item.get("primary_location", {}).get("pdf_url")
        })

    return results


def search_arxiv(query: str, limit: int) -> list[dict]:
    encoded = urllib.parse.quote_plus(query)
    url = (
        "http://export.arxiv.org/api/query?"
        f"search_query=all:{encoded}&start=0&max_results={limit}"
    )
    raw = read_url(url)
    root = ET.fromstring(raw)

    ns = {"atom": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}
    results = []

    for entry in root.findall("atom:entry", ns):
        title = (entry.findtext("atom:title", default="", namespaces=ns) or "").strip()
        if not title:
            continue
        summary = (entry.findtext("atom:summary", default="", namespaces=ns) or "").strip()
        id_url = (entry.findtext("atom:id", default="", namespaces=ns) or "").strip()

        authors = []
        for author in entry.findall("atom:author", ns):
            name = (author.findtext("atom:name", default="", namespaces=ns) or "").strip()
            if name:
                authors.append(name)

        published = (entry.findtext("atom:published", default="", namespaces=ns) or "").strip()
        year = None
        if len(published) >= 4 and published[:4].isdigit():
            year = int(published[:4])

        pdf_url = None
        for link in entry.findall("atom:link", ns):
            href = link.attrib.get("href", "").strip()
            title_attr = link.attrib.get("title", "").strip().lower()
            rel = link.attrib.get("rel", "").strip().lower()
            if title_attr == "pdf" or (rel == "related" and href.endswith(".pdf")):
                pdf_url = href
                break

        results.append({
            "source": "arxiv",
            "id": id_url or None,
            "title": title,
            "authors": authors,
            "year": year,
            "abstract": summary,
            "venue": "arXiv",
            "doi": None,
            "url": id_url or None,
            "pdfUrl": pdf_url
        })

    return results


def dedupe_papers(papers: list[dict]) -> list[dict]:
    seen = set()
    output = []
    for paper in papers:
        title = (paper.get("title") or "").lower().strip()
        if not title:
            continue
        key = re.sub(r"\s+", " ", title)
        if key in seen:
            continue
        seen.add(key)
        output.append(paper)
    return output


def write_outputs(project_root: str, output_dir: str, query: str, papers: list[dict], errors: list[str]) -> tuple[str, str]:
    abs_output_dir = os.path.abspath(os.path.join(project_root, output_dir))
    os.makedirs(abs_output_dir, exist_ok=True)

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    stem = f"search-{stamp}-{slugify(query)}"
    json_path = os.path.join(abs_output_dir, f"{stem}.json")
    md_path = os.path.join(abs_output_dir, f"{stem}.md")

    payload = {
        "schema": "literature-search.result.v1",
        "query": query,
        "generatedAt": now_iso(),
        "paperCount": len(papers),
        "papers": papers,
        "errors": errors,
    }

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")

    lines = [
        f"# Literature Search: {query}",
        "",
        f"- generated_at: {payload['generatedAt']}",
        f"- paper_count: {len(papers)}",
        f"- json_path: {json_path}",
        "",
        "## Papers",
    ]

    if not papers:
        lines.extend(["- (none)", ""])
    else:
        for idx, paper in enumerate(papers, start=1):
            authors = ", ".join((paper.get("authors") or [])[:5]) or "Unknown"
            lines.extend([
                f"### {idx}. {paper.get('title')}",
                f"- source: {paper.get('source')}",
                f"- year: {paper.get('year')}",
                f"- authors: {authors}",
                f"- url: {paper.get('url')}",
                f"- doi: {paper.get('doi')}",
                "",
                "Abstract:",
                paper.get("abstract") or "(none)",
                "",
            ])

    if errors:
        lines.extend(["## Source Errors", ""])
        for err in errors:
            lines.append(f"- {err}")
        lines.append("")

    with open(md_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    return json_path, md_path


def main() -> int:
    parser = argparse.ArgumentParser(description="Search academic literature and persist local artifacts.")
    parser.add_argument("--query", required=True, help="Literature query")
    parser.add_argument("--limit", type=int, default=8, help="Max results per source (default: 8)")
    parser.add_argument("--project-root", default=".", help="Project root path")
    parser.add_argument(
        "--output-dir",
        "--out-dir",
        "--out",
        "--library",
        dest="output_dir",
        required=True,
        help="Output directory relative to project root (compat: --out-dir/--out/--library)",
    )
    parser.add_argument("--skip-arxiv", action="store_true", help="Skip arXiv source")
    args = parser.parse_args()

    query = args.query.strip()
    if not query:
        print("AF_RESULT_JSON: " + json.dumps({
            "schema": "literature-search.result.v1",
            "success": False,
            "error": "query is required"
        }))
        return 2

    limit = max(1, min(30, int(args.limit)))

    all_papers: list[dict] = []
    errors: list[str] = []

    try:
        all_papers.extend(search_openalex(query, limit))
    except Exception as exc:  # noqa: BLE001
        errors.append(f"openalex: {exc}")

    if not args.skip_arxiv:
        try:
            all_papers.extend(search_arxiv(query, limit))
        except Exception as exc:  # noqa: BLE001
            errors.append(f"arxiv: {exc}")

    papers = dedupe_papers(all_papers)

    json_path, md_path = write_outputs(
        project_root=args.project_root,
        output_dir=args.output_dir,
        query=query,
        papers=papers,
        errors=errors,
    )

    rel_json = os.path.relpath(json_path, os.path.abspath(args.project_root))
    rel_md = os.path.relpath(md_path, os.path.abspath(args.project_root))

    print(f"Saved literature artifacts: {rel_json}, {rel_md}")
    print("AF_RESULT_JSON: " + json.dumps({
        "schema": "literature-search.result.v1",
        "success": True,
        "query": query,
        "paperCount": len(papers),
        "errors": errors,
        "jsonPath": rel_json,
        "markdownPath": rel_md,
    }))

    return 0


if __name__ == "__main__":
    sys.exit(main())
