# research-admin

LinkML schemas for research administration at the University of Nebraska.

| Schema | Contents |
| --- | --- |
| [`research_administration.yaml`](research_administration.yaml) | Core model: projects, awards, organisations, people |
| [`nacubo_functional_classification.yaml`](nacubo_functional_classification.yaml) | NACUBO functional expense classification value set (FARM 342.1) |

## Documentation site

`gen-doc` renders each schema as a static HTML site. The generator only writes
rendered templates, so the build script also copies the stylesheet and scripts
next to the generated pages.

```bash
uv run --with linkml python scripts/build_docs.py
```

For a build that matches CI exactly, install the pinned version instead:

```bash
pip install -r requirements-docs.txt && python scripts/build_docs.py
```

That writes `site/research_administration/` and
`site/nacubo_functional_classification/`, each self-contained, plus a
`site/index.html` landing page linking to both. To preview:

```bash
python3 -m http.server -d site 8000
```

Build one schema somewhere specific, or turn the diagrams off:

```bash
uv run --with linkml python scripts/build_docs.py research_administration.yaml -d site/ra --no-diagrams
```

### Continuous integration

[`.github/workflows/docs.yml`](.github/workflows/docs.yml) lints both schemas,
builds the site, checks the output and uploads it as a build artifact, on every
push to `main` and every pull request.

`linkml-lint` runs with `--ignore-warnings`: the warnings on these schemas are
style notes (classes and slots without a `description`), so failing on them
would leave CI permanently red and quickly ignored. Genuine schema errors — a
dangling slot reference, say — still exit non-zero and fail the job.

The build itself rarely fails, because the things that go wrong in hand-written
templates are bad relative paths and diagram edges pointing at nodes the page
never emitted; both render wrongly rather than raising. So the workflow also
runs:

```bash
python scripts/check_site.py site
```

which walks every generated page and verifies that each local link resolves to a
file that exists, each embedded diagram graph parses, every edge endpoint is a
node on the same page, and every page with a diagram also carries the import
map. It needs no dependencies beyond the standard library, so it is worth
running locally after template changes.

### Publishing

A `deploy` job publishes the site to GitHub Pages on every push to `main`. Pull
requests build and check but never deploy; to review one, download the `site`
artifact from its run page.

> [!IMPORTANT]
> This needs **Settings → Pages → Source: GitHub Actions** set once on the
> repository. Until it is, the deploy job fails with a "Pages site not found"
> error while the build job keeps passing.

Published at <https://unmc-vcr.github.io/research-admin/>. Every link in the
generated site is relative, so serving it from a subpath needs no extra
configuration.

Because each schema builds into its own subdirectory and GitHub Pages has no
directory listing, `build_docs.py` also writes `site/index.html` — a landing
page linking to each schema. Without it the site root would be a 404. Pass
`--no-landing` to skip it.

Deployments queue rather than cancel one another, and a run on `main` is never
cancelled by a newer push, so a deploy is not aborted halfway through.

### How the site is put together

```
.github/workflows/docs.yml   lint, build, check, upload, deploy to Pages
requirements-docs.txt        pinned LinkML version
scripts/
  build_docs.py       renders each schema through gen-doc, copies assets,
                      writes the landing page
  check_site.py       link and diagram-graph checks for the built output
docs/
  templates/          Jinja2 templates gen-doc renders through
    _base.html.jinja2       page shell: nav, search, theme toggle, table of contents
    _macros.html.jinja2     links, badges, cardinality, inheritance trees
    _graph.html.jinja2      diagram graph model + figure markup
    _class_diagram.html.jinja2, _common_metadata.html.jinja2
    index / class / slot / enum / type / subset / schema .html.jinja2
  assets/
    css/linkml-docs.css     one stylesheet, themed with CSS custom properties
    js/docs.js              navigation, filtering, theme, copy buttons
    js/diagram.js           the interactive diagrams
```

`gen-doc` looks for `TYPE.html.jinja2` in `--template-directory` and falls back
to its built-in Markdown templates when a file is missing, so all seven element
templates have to exist for HTML output.

Colours live as custom properties on `:root` in `linkml-docs.css`. Dark mode
follows the operating system unless the reader picks a scheme, which
`docs.js` records on `<html data-theme>`. Re-brand by changing `--brand` and
`--brand-ink`.

### Diagrams

Class pages and the index carry an interactive diagram: [React
Flow](https://reactflow.dev) nodes laid out with [ELK](https://eclipse.dev/elk/)
(`layered`, orthogonal edge routing). The visual grammar follows the LinkML
modeller app, so the two read alike:

| Edge | Meaning |
| --- | --- |
| solid, hollow triangle at the parent | `is_a` |
| dashed, hollow triangle at the parent | `mixin` |
| dotted, no arrowhead | `union_of` |
| solid green, filled arrowhead, labelled | slot `range` |

Slot rows carry badges: `A`/`S` for inline attribute vs schema-level slot, `R`
required, `M` multivalued, `id` identifier, `↑` inherited (with the ancestor in
the tooltip), `~` a `slot_usage` override, and `↻` for a slot whose range is its
own class — those are shown as a badge rather than drawn as a self-loop.
Expanded nodes anchor each range edge to the row of the slot that declares it.

The templates build the graph as JSON and embed it in the page; `diagram.js`
only lays it out and renders it. Every figure also carries a **Diagram as text**
disclosure with the same relationships, which is what print and screen readers
get.

React, React Flow and ELK are loaded from a CDN through an import map, since
this repo has no bundler. The import map and the versions are in
`_base.html.jinja2`, and it is only emitted on pages that actually have a
diagram. If the CDN is unreachable the figure removes itself and opens the text
rendering instead.
