#!/usr/bin/env python3
"""Render a LinkML schema as an HTML documentation site.

DocGenerator writes rendered templates and nothing else, so this script also
copies docs/assets next to the generated pages. The templates reference the
stylesheet at `assets/css/linkml-docs.css` relative to the output root, which
is why each output directory gets its own copy.

Usage:

    python scripts/build_docs.py                      # every schema in src/schemas
    python scripts/build_docs.py src/schemas/research_administration.yaml -d site/ra
"""

from __future__ import annotations

import argparse
import html
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TEMPLATE_DIR = REPO_ROOT / "docs" / "templates"
ASSET_DIR = REPO_ROOT / "docs" / "assets"
SITE_DIR = REPO_ROOT / "site"
SRC_DIR = REPO_ROOT / "src"

# `src/schemas/` holds the documented entry points; `src/types/` and
# `src/enums/` hold modules those schemas import, which are rendered as part of
# whichever schema pulls them in rather than as sites of their own.
SCHEMA_DIR = SRC_DIR / "schemas"


def discover_schemas() -> list[Path]:
    return sorted(SCHEMA_DIR.glob("*.yaml"))


def build(schema: Path, directory: Path, diagram_type: str | None) -> dict:
    from linkml.generators.docgen import DocGenerator

    generator = DocGenerator(
        str(schema),
        format="html",
        template_directory=str(TEMPLATE_DIR),
        directory=str(directory),
        diagram_type=diagram_type,
        include_top_level_diagram=diagram_type is not None,
        subfolder_type_separation=True,
        hierarchical_class_view=True,
        sort_by="name",
    )
    generator.serialize()

    assets = directory / "assets"
    if assets.exists():
        shutil.rmtree(assets)
    shutil.copytree(ASSET_DIR, assets)

    pages = len(list(directory.rglob("*.html")))
    print(f"{schema.name} -> {directory}{'/' if not str(directory).endswith('/') else ''} ({pages} pages)")

    view = generator.schemaview
    return {
        "title": generator.schema_title(),
        "name": view.schema.name,
        "description": view.schema.description or "",
        "path": directory.name,
        "pages": pages,
        "classes": len(view.all_classes()),
        "slots": len(view.all_slots()),
        "enums": len(view.all_enums()),
    }


LANDING_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="LinkML schema documentation for {title}.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='3' fill='%23c8102e'/%3E%3C/svg%3E">
<link rel="stylesheet" href="assets/css/linkml-docs.css">
</head>
<body>
<header class="topbar">
  <a class="topbar__brand" href="index.html">
    <span class="topbar__title">{title}</span>
    <span class="topbar__sub">schema documentation</span>
  </a>
  <div class="topbar__spacer"></div>
  <button class="theme-toggle" type="button" data-theme-toggle title="Switch between light and dark">
    <span class="sr-only">Toggle colour scheme</span>
    <span aria-hidden="true" data-theme-icon>&#9789;</span>
  </button>
</header>

<main class="content" id="content" style="margin: 0 auto;">
  <header class="page-header">
    <p class="eyebrow">Schemas</p>
    <h1>{title}</h1>
    <p class="lede">LinkML schemas for research administration at the University
    of Nebraska. Each is documented as its own site.</p>
  </header>
{cards}
</main>

<footer class="footer">
  <p>Built with <a href="https://linkml.io/linkml/generators/docgen.html" target="_blank" rel="noopener">LinkML docgen</a></p>
</footer>

<script src="assets/js/docs.js" defer></script>
</body>
</html>
"""

CARD_TEMPLATE = """  <section class="section">
    <h2><a href="{path}/index.html">{title}</a></h2>
    <p class="prose">{description}</p>
    <ul class="statgrid">
      <li><a href="{path}/index.html#classes"><span class="statgrid__n">{classes}</span><span class="statgrid__l">Classes</span></a></li>
      <li><a href="{path}/index.html#slots"><span class="statgrid__n">{slots}</span><span class="statgrid__l">Slots</span></a></li>
      <li><a href="{path}/index.html#enums"><span class="statgrid__n">{enums}</span><span class="statgrid__l">Enumerations</span></a></li>
    </ul>
    <p><code>{name}</code></p>
  </section>
"""


def write_landing(directory: Path, schemas: list[dict], title: str) -> None:
    """A root index for the published site.

    GitHub Pages has no directory listing, so without this the site URL is a
    404 — each schema builds into its own subdirectory.
    """
    cards = "".join(
        CARD_TEMPLATE.format(
            path=html.escape(entry["path"]),
            title=html.escape(entry["title"]),
            name=html.escape(entry["name"]),
            description=html.escape(entry["description"] or "No description."),
            classes=entry["classes"],
            slots=entry["slots"],
            enums=entry["enums"],
        )
        for entry in schemas
    )
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "index.html").write_text(
        LANDING_TEMPLATE.format(title=html.escape(title), cards=cards),
        encoding="utf-8",
    )

    assets = directory / "assets"
    if assets.exists():
        shutil.rmtree(assets)
    shutil.copytree(ASSET_DIR, assets)
    print(f"landing page -> {directory}/index.html ({len(schemas)} schemas)")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("schema", nargs="*", type=Path, help="schema files to build (default: every project schema)")
    parser.add_argument("-d", "--directory", type=Path, help="output directory (only valid with a single schema)")
    parser.add_argument(
        "--diagram-type",
        choices=["mermaid_class_diagram", "er_diagram", "plantuml_class_diagram"],
        default="mermaid_class_diagram",
        help="diagram style embedded in each class page (default: mermaid_class_diagram)",
    )
    parser.add_argument("--no-diagrams", action="store_true", help="skip diagrams entirely")
    parser.add_argument("--no-landing", action="store_true", help="skip the root landing page")
    args = parser.parse_args(argv)

    try:
        import linkml  # noqa: F401
    except ImportError:
        parser.error(
            "linkml is not installed. Try: pip install -r requirements.txt"
        )

    schemas = args.schema or discover_schemas()
    if not schemas:
        parser.error(f"no schemas found in {SCHEMA_DIR.relative_to(REPO_ROOT)}/")
    if args.directory and len(schemas) != 1:
        parser.error("--directory requires exactly one schema")

    diagram_type = None if args.no_diagrams else args.diagram_type

    built = []
    for schema in schemas:
        schema = schema if schema.is_absolute() else Path.cwd() / schema
        if not schema.is_file():
            parser.error(f"no such schema: {schema}")
        directory = args.directory or (SITE_DIR / schema.stem)
        built.append(build(schema, directory, diagram_type))

    # Only meaningful for the default multi-schema build into site/; a single
    # schema written to an explicit --directory is its own entry point.
    if not args.directory and not args.no_landing:
        write_landing(SITE_DIR, built, "Research Administration")

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
