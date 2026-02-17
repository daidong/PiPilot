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


def read_url(url: str, timeout_sec: int = 25) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "AgentFoundry-LiteratureSweep/1.0"})
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
            if not isinstance(auth, dict):
                continue
            author = auth.get("author")
            if isinstance(author, dict):
                name = (author.get("display_name") or "").strip()
                if name:
                    authors.append(name)

        doi = (item.get("doi") or "").strip()
        if doi.startswith("https://doi.org/"):
            doi = doi[len("https://doi.org/") :]

        results.append(
            {
                "source": "openalex",
                "id": str(item.get("id") or "").strip() or None,
                "title": title,
                "authors": authors,
                "year": item.get("publication_year"),
                "abstract": openalex_abstract(item),
                "venue": ((item.get("primary_location") or {}).get("source") or {}).get("display_name"),
                "doi": doi or None,
                "url": item.get("primary_location", {}).get("landing_page_url") or item.get("id"),
                "pdfUrl": item.get("primary_location", {}).get("pdf_url"),
                "queryTag": query,
            }
        )
    return results


def search_openalex_citing(seed_work_id: str, limit: int) -> list[dict]:
    short_id = seed_work_id.strip().split("/")[-1]
    if not short_id:
        return []
    params = urllib.parse.urlencode({"filter": f"cites:{short_id}", "per-page": str(limit)})
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
            if not isinstance(auth, dict):
                continue
            author = auth.get("author")
            if isinstance(author, dict):
                name = (author.get("display_name") or "").strip()
                if name:
                    authors.append(name)
        results.append(
            {
                "source": "openalex-cites",
                "id": str(item.get("id") or "").strip() or None,
                "title": title,
                "authors": authors,
                "year": item.get("publication_year"),
                "abstract": openalex_abstract(item),
                "venue": ((item.get("primary_location") or {}).get("source") or {}).get("display_name"),
                "doi": item.get("doi"),
                "url": item.get("primary_location", {}).get("landing_page_url") or item.get("id"),
                "pdfUrl": item.get("primary_location", {}).get("pdf_url"),
                "queryTag": f"cites:{short_id}",
            }
        )
    return results


def search_arxiv(query: str, limit: int) -> list[dict]:
    encoded = urllib.parse.quote_plus(query)
    url = (
        "http://export.arxiv.org/api/query?"
        f"search_query=all:{encoded}&start=0&max_results={limit}"
    )
    raw = read_url(url)
    root = ET.fromstring(raw)
    ns = {"atom": "http://www.w3.org/2005/Atom"}

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
        year = int(published[:4]) if len(published) >= 4 and published[:4].isdigit() else None
        pdf_url = None
        for link in entry.findall("atom:link", ns):
            href = link.attrib.get("href", "").strip()
            title_attr = link.attrib.get("title", "").strip().lower()
            if title_attr == "pdf":
                pdf_url = href
                break
        results.append(
            {
                "source": "arxiv",
                "id": id_url or None,
                "title": title,
                "authors": authors,
                "year": year,
                "abstract": summary,
                "venue": "arXiv",
                "doi": None,
                "url": id_url or None,
                "pdfUrl": pdf_url,
                "queryTag": query,
            }
        )
    return results


def tokenize(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", (text or "").lower()))


def score_paper(query_tokens: set[str], paper: dict) -> float:
    title_tokens = tokenize(str(paper.get("title") or ""))
    abstract_tokens = tokenize(str(paper.get("abstract") or ""))
    overlap = len(query_tokens & title_tokens) * 2 + len(query_tokens & abstract_tokens)
    year = paper.get("year")
    recency = 0.0
    if isinstance(year, int) and year >= 2000:
        recency = min(0.8, (year - 2000) / 40.0)
    source_bonus = 0.4 if str(paper.get("source")).startswith("openalex-cites") else 0.0
    return float(overlap) + recency + source_bonus


def dedupe_rank(query: str, papers: list[dict], final_limit: int) -> list[dict]:
    query_tokens = tokenize(query)
    ranked = []
    seen = set()
    for paper in papers:
        title = re.sub(r"\s+", " ", str(paper.get("title") or "").strip().lower())
        if not title or title in seen:
            continue
        seen.add(title)
        score = score_paper(query_tokens, paper)
        row = dict(paper)
        row["relevanceScore"] = round(score, 3)
        ranked.append(row)
    ranked.sort(
        key=lambda x: (
            float(x.get("relevanceScore") or 0.0),
            int(x.get("year") or 0),
            len(str(x.get("abstract") or "")),
        ),
        reverse=True,
    )
    return ranked[: max(1, final_limit)]


def generate_subqueries(query: str, max_subqueries: int) -> list[str]:
    base = query.strip()
    if not base:
        return []
    candidates = [
        base,
        f"{base} related work",
        f"{base} survey",
        f"{base} benchmark",
        f"{base} ablation",
        f"{base} efficiency",
        f"{base} optimization",
    ]
    out = []
    seen = set()
    for item in candidates:
        norm = re.sub(r"\s+", " ", item.strip().lower())
        if not norm or norm in seen:
            continue
        seen.add(norm)
        out.append(item.strip())
        if len(out) >= max(1, max_subqueries):
            break
    return out


def write_outputs(
    *,
    project_root: str,
    output_dir: str,
    query: str,
    subqueries: list[str],
    papers: list[dict],
    errors: list[str],
) -> tuple[str, str]:
    abs_output_dir = os.path.abspath(os.path.join(project_root, output_dir))
    os.makedirs(abs_output_dir, exist_ok=True)

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    stem = f"sweep-{stamp}-{slugify(query)}"
    json_path = os.path.join(abs_output_dir, f"{stem}.json")
    md_path = os.path.join(abs_output_dir, f"{stem}.md")

    payload = {
        "schema": "literature-search.sweep.result.v1",
        "query": query,
        "generatedAt": now_iso(),
        "subqueries": subqueries,
        "paperCount": len(papers),
        "papers": papers,
        "errors": errors,
    }
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")

    lines = [
        f"# Literature Sweep: {query}",
        "",
        f"- generated_at: {payload['generatedAt']}",
        f"- subqueries: {len(subqueries)}",
        f"- paper_count: {len(papers)}",
        f"- json_path: {json_path}",
        "",
        "## Subqueries",
        "",
    ]
    for sq in subqueries:
        lines.append(f"- {sq}")
    lines.extend(["", "## Top Papers", ""])

    if not papers:
        lines.extend(["- (none)", ""])
    else:
        for idx, paper in enumerate(papers, start=1):
            authors = ", ".join((paper.get("authors") or [])[:5]) or "Unknown"
            lines.extend(
                [
                    f"### {idx}. {paper.get('title')}",
                    f"- source: {paper.get('source')}",
                    f"- relevance_score: {paper.get('relevanceScore')}",
                    f"- year: {paper.get('year')}",
                    f"- authors: {authors}",
                    f"- query_tag: {paper.get('queryTag')}",
                    f"- url: {paper.get('url')}",
                    "",
                ]
            )

    if errors:
        lines.extend(["## Source Errors", ""])
        for err in errors:
            lines.append(f"- {err}")
        lines.append("")

    with open(md_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    return json_path, md_path


def main() -> int:
    parser = argparse.ArgumentParser(description="Run full literature sweep with subqueries and citation expansion.")
    parser.add_argument("--query", required=True, help="Main literature query")
    parser.add_argument("--limit-per-query", type=int, default=8, help="Max results per source per subquery")
    parser.add_argument("--final-limit", type=int, default=40, help="Final merged top-K papers")
    parser.add_argument("--max-subqueries", type=int, default=5, help="Maximum generated subqueries")
    parser.add_argument("--citation-seed-count", type=int, default=5, help="How many OpenAlex seed papers to expand")
    parser.add_argument("--citation-limit", type=int, default=5, help="Citing papers per seed")
    parser.add_argument("--project-root", default=".", help="Project root path")
    parser.add_argument(
        "--output-dir",
        "--out-dir",
        "--out",
        "--library",
        dest="output_dir",
        default=".yolo-researcher/library/literature",
        help="Output directory relative to project root (compat: --out-dir/--out/--library)",
    )
    parser.add_argument("--skip-arxiv", action="store_true", help="Skip arXiv source")
    args = parser.parse_args()

    query = args.query.strip()
    if not query:
        print("AF_RESULT_JSON: " + json.dumps({
            "schema": "literature-search.sweep.result.v1",
            "success": False,
            "error": "query is required",
        }))
        return 2

    limit_per_query = max(1, min(20, int(args.limit_per_query)))
    final_limit = max(1, min(120, int(args.final_limit)))
    max_subqueries = max(1, min(8, int(args.max_subqueries)))
    citation_seed_count = max(0, min(10, int(args.citation_seed_count)))
    citation_limit = max(1, min(20, int(args.citation_limit)))

    subqueries = generate_subqueries(query, max_subqueries)
    all_papers: list[dict] = []
    errors: list[str] = []

    for sq in subqueries:
        try:
            all_papers.extend(search_openalex(sq, limit_per_query))
        except Exception as exc:  # noqa: BLE001
            errors.append(f"openalex[{sq}]: {exc}")

        if not args.skip_arxiv:
            try:
                all_papers.extend(search_arxiv(sq, limit_per_query))
            except Exception as exc:  # noqa: BLE001
                errors.append(f"arxiv[{sq}]: {exc}")

    seed_openalex_ids = []
    for paper in all_papers:
        source = str(paper.get("source") or "")
        paper_id = str(paper.get("id") or "")
        if source != "openalex" or not paper_id:
            continue
        seed_openalex_ids.append(paper_id)
        if len(seed_openalex_ids) >= citation_seed_count:
            break

    for seed_id in seed_openalex_ids:
        try:
            all_papers.extend(search_openalex_citing(seed_id, citation_limit))
        except Exception as exc:  # noqa: BLE001
            errors.append(f"openalex-cites[{seed_id}]: {exc}")

    papers = dedupe_rank(query, all_papers, final_limit)
    json_path, md_path = write_outputs(
        project_root=args.project_root,
        output_dir=args.output_dir,
        query=query,
        subqueries=subqueries,
        papers=papers,
        errors=errors,
    )

    rel_json = os.path.relpath(json_path, os.path.abspath(args.project_root))
    rel_md = os.path.relpath(md_path, os.path.abspath(args.project_root))
    print(f"Saved literature sweep artifacts: {rel_json}, {rel_md}")
    print("AF_RESULT_JSON: " + json.dumps({
        "schema": "literature-search.sweep.result.v1",
        "success": True,
        "query": query,
        "subqueries": subqueries,
        "paperCount": len(papers),
        "errors": errors,
        "jsonPath": rel_json,
        "markdownPath": rel_md,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
