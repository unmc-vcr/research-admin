#!/usr/bin/env python3
"""Sanity-check a generated documentation site.

The templates build links and the diagram graph model by hand, so the failure
modes are broken relative links and edges that point at nodes the page never
emitted. Neither shows up as a build error — the site just renders wrongly — so
CI checks for them explicitly.

Usage:

    python scripts/check_site.py site
"""

from __future__ import annotations

import argparse
import json
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urldefrag

SKIP_SCHEMES = ("http://", "https://", "mailto:", "data:", "javascript:")


class PageParser(HTMLParser):
    """Collects local links, embedded diagram graphs, and whether the page
    declares the import map the diagram module needs."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[str] = []
        self.script_srcs: list[str] = []
        self.graphs: list[str] = []
        self.has_importmap = False
        self.has_diagram = False
        self._in_graph = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr = dict(attrs)
        if tag in ("a", "link"):
            href = attr.get("href")
            if href:
                self.links.append(href)
        elif tag == "script":
            if attr.get("type") == "importmap":
                self.has_importmap = True
            if "data-diagram-data" in attr:
                self._in_graph = True
            src = attr.get("src")
            if src:
                self.links.append(src)
                self.script_srcs.append(src)
        if "data-diagram" in attr:
            self.has_diagram = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "script":
            self._in_graph = False

    def handle_data(self, data: str) -> None:
        if self._in_graph:
            self.graphs.append(data)


def check_graph(graph: dict, where: str, problems: list[str]) -> int:
    """Every edge endpoint must be a node the same page emitted, or React Flow
    silently drops the edge."""
    ids = {node.get("id") for node in graph.get("nodes", [])}
    if not ids:
        problems.append(f"{where}: diagram has no nodes")
        return 0
    for edge in graph.get("edges", []):
        for end in ("source", "target"):
            if edge.get(end) not in ids:
                problems.append(
                    f"{where}: edge {edge.get('id')!r} {end}={edge.get(end)!r} "
                    f"is not a node on this page"
                )
    for node in graph.get("nodes", []):
        if not node.get("label"):
            problems.append(f"{where}: node {node.get('id')!r} has no label")
    return len(graph.get("edges", []))


def check_site(root: Path) -> tuple[int, list[str]]:
    """Walks every page under `root`, including the landing page and each
    schema's subdirectory. Stylesheets and scripts are checked implicitly:
    they are links like any other, so a missing asset shows up as a broken one."""
    problems: list[str] = []

    if not (root / "index.html").is_file():
        problems.append(f"{root}: no index.html — the site has no entry point")

    pages = sorted(root.rglob("*.html"))
    if not pages:
        problems.append(f"{root}: no HTML pages")
        return 0, problems

    links = 0
    diagrams = 0
    edges = 0

    for page in pages:
        rel = page.relative_to(root)
        parser = PageParser()
        parser.feed(page.read_text(encoding="utf-8"))

        for href in parser.links:
            if href.startswith(SKIP_SCHEMES) or href.startswith("#") or not href:
                continue
            target, _ = urldefrag(href)
            if not target:
                continue
            resolved = (page.parent / unquote(target)).resolve()
            links += 1
            if not resolved.exists():
                problems.append(f"{rel}: broken link -> {href}")

        for blob in parser.graphs:
            diagrams += 1
            try:
                graph = json.loads(blob)
            except json.JSONDecodeError as err:
                problems.append(f"{rel}: diagram JSON is invalid ({err})")
                continue
            edges += check_graph(graph, str(rel), problems)

        if parser.has_diagram:
            # The diagram module's bare imports only resolve through the map.
            if not parser.has_importmap:
                problems.append(f"{rel}: has a diagram but no import map")

            # docs.js reaches diagram.js through a dynamic import resolved
            # against its own URL, so no markup references it and a failure to
            # copy it would leave every diagram silently falling back to text.
            # Check the sibling the runtime will actually request.
            entry = [src for src in parser.script_srcs if src.endswith("docs.js")]
            if not entry:
                problems.append(f"{rel}: has a diagram but does not load docs.js")
            else:
                resolved = (page.parent / unquote(entry[0])).resolve()
                if not (resolved.parent / "diagram.js").is_file():
                    problems.append(
                        f"{rel}: diagram.js is missing beside {entry[0]}"
                    )

    print(
        f"{root}: {len(pages)} pages, {links} local links, "
        f"{diagrams} diagrams, {edges} edges"
    )
    return len(pages), problems


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", nargs="+", type=Path, help="built site root(s)")
    args = parser.parse_args(argv)

    all_problems: list[str] = []
    for directory in args.directory:
        if not directory.is_dir():
            all_problems.append(f"{directory}: not a directory")
            continue
        _, problems = check_site(directory)
        all_problems.extend(problems)

    if all_problems:
        print(f"\n{len(all_problems)} problem(s):", file=sys.stderr)
        for problem in all_problems:
            print(f"  {problem}", file=sys.stderr)
        return 1

    print("OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
