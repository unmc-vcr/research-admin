/* Progressive enhancement for the generated LinkML documentation.
   Every page works without this file; it only adds navigation conveniences. */
(function () {
  "use strict";

  var STORAGE_KEY = "linkml-docs-theme";

  // document.currentScript is only readable while the script is executing, and
  // dynamic import() would otherwise resolve against the page's own directory.
  var SCRIPT_URL = document.currentScript ? document.currentScript.src : null;

  function store(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (e) {
      /* private mode, blocked site data — ignore */
    }
  }

  function read(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  /* ------------------------------------------------------------ theme -- */

  function resolvedTheme() {
    var explicit = document.documentElement.getAttribute("data-theme");
    if (explicit) return explicit;
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  function paintThemeIcon() {
    var icon = document.querySelector("[data-theme-icon]");
    if (icon) icon.textContent = resolvedTheme() === "dark" ? "☀" : "☽";
  }

  function initTheme() {
    var saved = read(STORAGE_KEY);
    if (saved === "dark" || saved === "light") {
      document.documentElement.setAttribute("data-theme", saved);
    }
    paintThemeIcon();

    var button = document.querySelector("[data-theme-toggle]");
    if (!button) return;
    button.addEventListener("click", function () {
      var next = resolvedTheme() === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      store(STORAGE_KEY, next);
      paintThemeIcon();
      restyleDiagrams(next);
      // Diagram colours come from CSS custom properties, so React Flow needs
      // no help here.
    });
  }

  /* ---------------------------------------------------------- sidebar -- */

  function initSidebar() {
    var toggle = document.querySelector("[data-sidebar-toggle]");
    var sidebar = document.getElementById("sidebar");
    if (!toggle || !sidebar) return;

    toggle.addEventListener("click", function () {
      var open = sidebar.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && sidebar.classList.contains("is-open")) {
        sidebar.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
        toggle.focus();
      }
    });

    // Keep the current page visible in a long element list.
    var active = sidebar.querySelector("li.is-active");
    if (active && active.scrollIntoView) {
      active.scrollIntoView({ block: "center" });
    }
  }

  /* ----------------------------------------------------- nav filtering -- */

  function initNavFilter() {
    var input = document.querySelector("[data-nav-filter]");
    var root = document.querySelector("[data-nav-root]");
    if (!input || !root) return;

    var empty = root.querySelector("[data-nav-empty]");
    var groups = Array.prototype.slice.call(root.querySelectorAll(".navgroup"));
    var items = groups.map(function (group) {
      return {
        group: group,
        wasOpen: group.open,
        entries: Array.prototype.slice.call(group.querySelectorAll("li")).map(
          function (li) {
            return { li: li, text: (li.textContent || "").toLowerCase() };
          }
        )
      };
    });

    function apply() {
      var query = input.value.trim().toLowerCase();
      var total = 0;

      items.forEach(function (item) {
        var shown = 0;
        item.entries.forEach(function (entry) {
          var match = !query || entry.text.indexOf(query) !== -1;
          entry.li.hidden = !match;
          if (match) shown += 1;
        });
        item.group.hidden = query !== "" && shown === 0;
        if (query) {
          item.group.open = true;
        } else {
          item.group.open = item.wasOpen;
        }
        total += shown;
      });

      if (empty) empty.hidden = total !== 0;
    }

    input.addEventListener("input", apply);
    input.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        input.value = "";
        apply();
      }
    });

    // Focus the filter with "/" the way most docs sites do.
    document.addEventListener("keydown", function (event) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      var tag = (document.activeElement && document.activeElement.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      event.preventDefault();
      input.focus();
      input.select();
    });
  }

  /* -------------------------------------------------------------- toc -- */

  function initToc() {
    var list = document.querySelector("[data-toc]");
    var content = document.getElementById("content");
    if (!list || !content) return;

    var headings = Array.prototype.slice.call(
      content.querySelectorAll(".section > h2[id], .section[id] > h2")
    );

    // Sections carry the id; fall back to slugging the heading text.
    var links = [];
    headings.forEach(function (heading) {
      var section = heading.closest(".section");
      var id = heading.id || (section && section.id);
      if (!id) return;
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.href = "#" + id;
      a.textContent = heading.textContent.trim();
      li.appendChild(a);
      list.appendChild(li);
      links.push({ a: a, target: section || heading });
    });

    if (!links.length || !("IntersectionObserver" in window)) return;

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          var match = links.filter(function (link) {
            return link.target === entry.target;
          })[0];
          if (!match) return;
          if (entry.isIntersecting) {
            links.forEach(function (link) {
              link.a.classList.remove("is-current");
            });
            match.a.classList.add("is-current");
          }
        });
      },
      { rootMargin: "-20% 0px -70% 0px" }
    );

    links.forEach(function (link) {
      observer.observe(link.target);
    });
  }

  /* --------------------------------------------------- copy to clipboard -- */

  function initCopyButtons() {
    document.querySelectorAll("[data-copy]").forEach(function (button) {
      button.addEventListener("click", function () {
        var block = button.closest(".codeblock");
        var code = block && block.querySelector("code");
        if (!code || !navigator.clipboard) return;
        navigator.clipboard.writeText(code.textContent).then(
          function () {
            var original = button.textContent;
            button.textContent = "Copied";
            window.setTimeout(function () {
              button.textContent = original;
            }, 1200);
          },
          function () {
            button.textContent = "Press ⌘C";
          }
        );
      });
    });
  }

  /* ------------------------------------------------ interactive graphs -- */

  // The diagrams are a separate ES module so that React, React Flow and ELK are
  // only fetched on pages that actually show one. Those pages also carry the
  // import map the module's bare specifiers resolve through.
  function initGraphs() {
    var figures = Array.prototype.slice.call(
      document.querySelectorAll("[data-diagram]")
    );
    if (!figures.length || !SCRIPT_URL) return;

    import(new URL("diagram.js", SCRIPT_URL).href)
      .then(function (module) {
        module.mountDiagrams();
      })
      .catch(function () {
        // Offline, or the CDN is blocked: drop the empty canvas and open the
        // text rendering so the page still conveys the relationships.
        figures.forEach(function (figure) {
          var mount = figure.querySelector("[data-diagram-mount]");
          var text = figure.querySelector(".diagram__text");
          if (mount) mount.remove();
          if (text) text.open = true;
        });
      });
  }

  /* ---------------------------------------------------------- mermaid -- */

  var mermaidApi = null;

  function diagramSources() {
    return Array.prototype.slice.call(document.querySelectorAll("pre[data-mermaid]"));
  }

  function renderDiagrams(theme) {
    var nodes = diagramSources();
    if (!nodes.length || !mermaidApi) return;
    try {
      mermaidApi.initialize({
        startOnLoad: false,
        securityLevel: "loose",
        theme: theme === "dark" ? "dark" : "default"
      });
      nodes.forEach(function (node, index) {
        if (!node.dataset.source) node.dataset.source = node.textContent;
        var source = node.dataset.source;
        mermaidApi
          .render("mermaid-" + index + "-" + Date.now(), source)
          .then(function (result) {
            node.innerHTML = result.svg;
            node.setAttribute("data-rendered", "true");
            if (result.bindFunctions) result.bindFunctions(node);
          })
          .catch(function () {
            /* leave the readable source in place */
          });
      });
    } catch (e) {
      /* leave the readable source in place */
    }
  }

  function restyleDiagrams(theme) {
    if (mermaidApi) renderDiagrams(theme);
  }

  function initMermaid() {
    if (!diagramSources().length) return;
    import("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs")
      .then(function (module) {
        mermaidApi = module.default;
        renderDiagrams(resolvedTheme());
      })
      .catch(function () {
        /* offline or blocked: the <pre> still shows the diagram source */
      });
  }

  /* ------------------------------------------------------------- boot -- */

  initTheme();
  initSidebar();
  initNavFilter();
  initToc();
  initCopyButtons();
  initGraphs();
  initMermaid();
})();
