/**
 * Interactive schema diagrams: React Flow nodes laid out with ELK.
 *
 * The graph model is built by the Jinja templates (see _graph.html.jinja2) and
 * embedded in each figure as JSON; nothing here reads the schema. The visual
 * grammar — four edge kinds, per-slot handles, self-references as a badge
 * rather than a loop — follows the LinkML modeller app so the two read alike.
 *
 * Loaded from a CDN through the import map in _base.html.jinja2. There is no
 * bundler, so components are written with createElement rather than JSX.
 */
import {
  createElement as h,
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { createRoot } from "react-dom/client";
import ReactFlow, {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  Position,
  ReactFlowProvider,
  getSmoothStepPath,
  useEdgesState,
  useNodesState,
  useReactFlow
} from "reactflow";
import ELK from "elkjs";

/* ─────────────────────────────────────────────────────────── geometry ─── */

// These must stay in sync with the .rf-node rules in linkml-docs.css: the node
// renderer places handles with them and ELK sizes nodes with them, so a drift
// would put edges in the wrong place.
const CLASS_W = 264;
const COMPACT_W = 196;
const HEADER_H = 34;
const ISA_H = 22;
const BODY_PAD = 4;
const ROW_H = 23;
const SLOT_LIMIT = 18;
const VALUE_LIMIT = 6;

function visibleSlots(node, expanded) {
  if (!expanded || node.kind !== "class") return [];
  return node.slots.slice(0, SLOT_LIMIT);
}

function visibleValues(node, expanded) {
  if (!expanded || node.kind !== "enum") return [];
  return (node.values || []).slice(0, VALUE_LIMIT);
}

/** Rows below the header, whatever the node kind. */
function bodyRows(node, expanded) {
  if (node.kind === "class") {
    const shown = visibleSlots(node, expanded).length;
    const truncated = expanded && node.slots.length > SLOT_LIMIT ? 1 : 0;
    return shown + truncated;
  }
  if (node.kind === "enum") {
    const shown = visibleValues(node, expanded).length;
    const truncated =
      expanded && (node.values || []).length > VALUE_LIMIT ? 1 : 0;
    return shown + truncated;
  }
  return expanded && node.base ? 1 : 0;
}

function nodeSize(node, expanded) {
  const hasIsA = expanded && node.kind === "class" && !!node.isA;
  const rows = bodyRows(node, expanded);
  return {
    width: node.kind === "class" ? CLASS_W : COMPACT_W,
    height:
      HEADER_H +
      (hasIsA ? ISA_H : 0) +
      (rows > 0 ? BODY_PAD * 2 + rows * ROW_H : 0)
  };
}

/** Vertical midpoint of the slot row at `index`, relative to the node's top. */
function slotMidY(index, hasIsA) {
  return HEADER_H + (hasIsA ? ISA_H : 0) + BODY_PAD + index * ROW_H + ROW_H / 2;
}

/* ─────────────────────────────────────────────────────────── layout ───── */

const elk = new ELK();

async function layoutGraph(graph, expanded) {
  const result = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.spacing.nodeNode": "48",
      "elk.layered.spacing.nodeNodeBetweenLayers": "84",
      "elk.layered.spacing.edgeNodeBetweenLayers": "24",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.layered.mergeEdges": "true"
    },
    children: graph.nodes.map(function (n) {
      return Object.assign({ id: n.id }, nodeSize(n, expanded));
    }),
    edges: graph.edges.map(function (e) {
      return { id: e.id, sources: [e.source], targets: [e.target] };
    })
  });

  const positions = {};
  (result.children || []).forEach(function (child) {
    positions[child.id] = { x: child.x || 0, y: child.y || 0 };
  });

  // Only intermediate bend points are kept; the endpoints come from React
  // Flow's live handle coordinates.
  const bends = {};
  (result.edges || []).forEach(function (edge) {
    const section = (edge.sections || [])[0];
    if (section && section.bendPoints && section.bendPoints.length) {
      bends[edge.id] = section.bendPoints;
    }
  });

  // Bounds of the laid-out graph, used to set the viewport without waiting for
  // React Flow to measure the nodes.
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  graph.nodes.forEach(function (n) {
    const pos = positions[n.id];
    if (!pos) return;
    const size = nodeSize(n, expanded);
    x1 = Math.min(x1, pos.x);
    y1 = Math.min(y1, pos.y);
    x2 = Math.max(x2, pos.x + size.width);
    y2 = Math.max(y2, pos.y + size.height);
  });
  const bounds = Number.isFinite(x1)
    ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
    : null;

  return { positions, bends, bounds };
}

/** East or west, chosen so a range edge leaves toward its target. */
function rangeSide(positions, sourceId, targetId) {
  const src = positions[sourceId];
  const tgt = positions[targetId];
  if (!src || !tgt) return "east";
  return tgt.x >= src.x ? "east" : "west";
}

/** A slot gets its own handle only when its row is actually rendered. */
function hasSlotHandle(slot) {
  return !!slot.range && !slot.selfRef && (!slot.inherited || slot.usageOverride);
}

function toFlow(graph, expanded, positions, bends) {
  const byId = {};
  graph.nodes.forEach(function (n) {
    byId[n.id] = n;
  });

  const nodes = graph.nodes.map(function (n) {
    const size = nodeSize(n, expanded);
    return {
      id: n.id,
      type:
        n.kind === "class"
          ? "classNode"
          : n.kind === "enum"
            ? "enumNode"
            : "typeNode",
      position: positions[n.id] || { x: 0, y: 0 },
      data: Object.assign({}, n, { expanded: expanded }),
      width: size.width,
      height: size.height,
      style: { width: size.width }
    };
  });

  // Edges sharing a source/target pair fan out so they stay tellable apart.
  const pairCounts = {};
  graph.edges.forEach(function (e) {
    const key = e.source + "→" + e.target;
    pairCounts[key] = (pairCounts[key] || 0) + 1;
  });
  const pairSeen = {};

  const edges = graph.edges.map(function (e) {
    const key = e.source + "→" + e.target;
    const parallelIndex = pairSeen[key] || 0;
    pairSeen[key] = parallelIndex + 1;
    const shared = {
      parallelIndex: parallelIndex,
      parallelCount: pairCounts[key]
    };

    if (e.kind !== "range") {
      return {
        id: e.id,
        type: e.kind,
        source: e.source,
        target: e.target,
        data: Object.assign({ bends: bends[e.id] }, shared)
      };
    }

    // Range edges leave from the row of the slot that declares them, so ELK's
    // node-centre bend points would route them wrongly — smooth-step instead.
    const side = rangeSide(positions, e.source, e.target);
    const source = byId[e.source];
    const slot = (source ? visibleSlots(source, expanded) : []).filter(
      function (s) {
        return s.name === e.slot && hasSlotHandle(s);
      }
    )[0];
    return {
      id: e.id,
      type: "range",
      source: e.source,
      target: e.target,
      sourceHandle: slot ? "slot-" + side + "-" + e.slot : "side-" + side,
      targetHandle: side === "east" ? "side-west" : "side-east",
      data: Object.assign({}, e, shared)
    };
  });

  return { nodes: nodes, edges: edges };
}

/* ──────────────────────────────────────────────────────────── nodes ───── */

function cx() {
  return Array.prototype.filter.call(arguments, Boolean).join(" ");
}

function badge(key, text, title, kind) {
  return h(
    "span",
    { key: key, className: cx("rf-badge", kind && "rf-badge--" + kind), title: title },
    text
  );
}

function SlotRow(props) {
  const slot = props.slot;
  const badges = [];
  if (slot.inherited) {
    badges.push(
      badge("inh", "↑", slot.inheritedFrom ? "from " + slot.inheritedFrom : "inherited")
    );
  }
  badges.push(
    badge(
      "origin",
      slot.origin === "schema" ? "S" : "A",
      slot.origin === "schema" ? "schema-level slot" : "inline attribute"
    )
  );
  if (slot.usageOverride) badges.push(badge("usage", "~", "slot_usage override", "warn"));
  if (slot.required) badges.push(badge("req", "R", "required", "req"));
  if (slot.multivalued) badges.push(badge("multi", "M", "multivalued"));
  if (slot.identifier) badges.push(badge("id", "id", "identifier"));
  if (slot.selfRef) {
    badges.push(badge("self", "↻", "Self-reference: range = " + slot.range, "warn"));
  }

  return h(
    "div",
    {
      className: cx("rf-slot", slot.inherited && "is-inherited"),
      title: slot.inheritedFrom ? "Inherited from " + slot.inheritedFrom : undefined
    },
    h("span", { className: "rf-slot__name" }, slot.name),
    slot.range
      ? h(Fragment, null, h("span", { className: "rf-slot__colon" }, ":"), h(
          "span",
          {
            className: cx(
              "rf-slot__range",
              slot.rangeIsEntity && "rf-slot__range--entity"
            )
          },
          slot.range
        ))
      : null,
    h("span", { className: "rf-slot__badges" }, badges)
  );
}

function nodeHeader(data) {
  return h(
    "div",
    { className: "rf-node__header" },
    h(
      "a",
      { className: "rf-node__title", href: data.url || undefined, draggable: false },
      data.label
    ),
    data.abstract ? h("span", { className: "rf-node__tag" }, "abstract") : null,
    data.mixin ? h("span", { className: "rf-node__tag" }, "mixin") : null
  );
}

const ClassNode = memo(function ClassNode(props) {
  const data = props.data;
  const expanded = data.expanded;
  const rows = visibleSlots(data, expanded);
  const hidden = expanded ? Math.max(0, data.slots.length - SLOT_LIMIT) : 0;
  const hasIsA = expanded && !!data.isA;

  const slotHandles = [];
  if (expanded) {
    rows.forEach(function (slot, index) {
      if (!hasSlotHandle(slot)) return;
      const top = slotMidY(index, hasIsA);
      ["east", "west"].forEach(function (side) {
        slotHandles.push(
          h(Handle, {
            key: side + "-" + slot.name,
            type: "source",
            id: "slot-" + side + "-" + slot.name,
            position: side === "east" ? Position.Right : Position.Left,
            className: "rf-handle rf-handle--slot",
            style: { top: top }
          })
        );
      });
    });
  }

  return h(
    "div",
    {
      className: cx(
        "rf-node",
        "rf-node--class",
        data.focus && "is-focus",
        props.selected && "is-selected",
        data.abstract && "is-abstract",
        data.mixin && "is-mixin"
      )
    },
    h(Handle, { type: "target", position: Position.Top, className: "rf-handle" }),
    h(Handle, { type: "source", position: Position.Bottom, className: "rf-handle" }),
    h(Handle, {
      type: "source",
      id: "side-east",
      position: Position.Right,
      className: "rf-handle rf-handle--side"
    }),
    h(Handle, {
      type: "source",
      id: "side-west",
      position: Position.Left,
      className: "rf-handle rf-handle--side"
    }),
    nodeHeader(data),
    hasIsA
      ? h(
          "div",
          { className: "rf-node__isa" },
          h("span", { className: "rf-node__isakey" }, "is_a:"),
          h("span", { className: "rf-node__isaval" }, data.isA)
        )
      : null,
    rows.length || hidden
      ? h(
          "div",
          { className: "rf-node__body" },
          rows.map(function (slot) {
            return h(SlotRow, { key: slot.name, slot: slot });
          }),
          hidden
            ? h("div", { className: "rf-node__more" }, "+" + hidden + " more…")
            : null
        )
      : null,
    slotHandles
  );
});

const EnumNode = memo(function EnumNode(props) {
  const data = props.data;
  const values = visibleValues(data, data.expanded);
  const hidden = data.expanded
    ? Math.max(0, (data.values || []).length - VALUE_LIMIT)
    : 0;
  return h(
    "div",
    {
      className: cx("rf-node", "rf-node--enum", props.selected && "is-selected")
    },
    h(Handle, { type: "target", position: Position.Top, className: "rf-handle" }),
    h(Handle, {
      type: "source",
      id: "side-east",
      position: Position.Right,
      className: "rf-handle rf-handle--side"
    }),
    h(Handle, {
      type: "source",
      id: "side-west",
      position: Position.Left,
      className: "rf-handle rf-handle--side"
    }),
    nodeHeader(data),
    values.length || hidden
      ? h(
          "div",
          { className: "rf-node__body" },
          values.map(function (v) {
            return h("div", { key: v, className: "rf-value" }, v);
          }),
          hidden
            ? h("div", { className: "rf-node__more" }, "+" + hidden + " more…")
            : null
        )
      : null
  );
});

const TypeNode = memo(function TypeNode(props) {
  const data = props.data;
  return h(
    "div",
    {
      className: cx("rf-node", "rf-node--type", props.selected && "is-selected")
    },
    h(Handle, { type: "target", position: Position.Top, className: "rf-handle" }),
    h(Handle, {
      type: "source",
      id: "side-east",
      position: Position.Right,
      className: "rf-handle rf-handle--side"
    }),
    h(Handle, {
      type: "source",
      id: "side-west",
      position: Position.Left,
      className: "rf-handle rf-handle--side"
    }),
    nodeHeader(data),
    data.expanded && data.base
      ? h("div", { className: "rf-node__body" }, h("div", { className: "rf-value" }, data.base))
      : null
  );
});

const nodeTypes = { classNode: ClassNode, enumNode: EnumNode, typeNode: TypeNode };

/* ──────────────────────────────────────────────────────────── edges ───── */

const PARALLEL_STEP = 9;
const CORNER_R = 8;

function fmt(n) {
  return Number.isFinite(n) ? n.toFixed(2) : "0";
}

/** SVG path through ELK's bend points, with rounded corners. */
function bendPath(sourceX, sourceY, targetX, targetY, bends) {
  const pts = [{ x: sourceX, y: sourceY }].concat(bends, [
    { x: targetX, y: targetY }
  ]);
  const segs = pts.slice(0, -1).map(function (pt, i) {
    const dx = pts[i + 1].x - pt.x;
    const dy = pts[i + 1].y - pt.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    return { dx: dx, dy: dy, len: len, ux: len ? dx / len : 0, uy: len ? dy / len : 0 };
  });

  let d = "M " + fmt(sourceX) + " " + fmt(sourceY);
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const corner = pts[i + 1];
    if (i < segs.length - 1) {
      const next = segs[i + 1];
      const r = Math.min(CORNER_R, seg.len / 2, next.len / 2);
      d +=
        " L " + fmt(corner.x - r * seg.ux) + " " + fmt(corner.y - r * seg.uy) +
        " Q " + fmt(corner.x) + " " + fmt(corner.y) +
        " " + fmt(corner.x + r * next.ux) + " " + fmt(corner.y + r * next.uy);
    } else {
      d += " L " + fmt(corner.x) + " " + fmt(corner.y);
    }
  }

  // Label at the midpoint of the polyline.
  const total = segs.reduce(function (s, seg) {
    return s + seg.len;
  }, 0);
  let acc = 0;
  let labelX = (sourceX + targetX) / 2;
  let labelY = (sourceY + targetY) / 2;
  for (let i = 0; i < segs.length; i++) {
    if (acc + segs[i].len >= total / 2) {
      const t = segs[i].len ? (total / 2 - acc) / segs[i].len : 0;
      labelX = pts[i].x + t * segs[i].dx;
      labelY = pts[i].y + t * segs[i].dy;
      break;
    }
    acc += segs[i].len;
  }
  return { path: d, labelX: labelX, labelY: labelY };
}

function edgePath(props) {
  const data = props.data || {};
  let ox = 0;
  let oy = 0;
  const count = data.parallelCount || 1;
  if (count > 1) {
    const dx = props.targetX - props.sourceX;
    const dy = props.targetY - props.sourceY;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 0) {
      const offset = ((data.parallelIndex || 0) - (count - 1) / 2) * PARALLEL_STEP;
      ox = (-dy / len) * offset;
      oy = (dx / len) * offset;
    }
  }

  if (data.bends && data.bends.length) {
    const pts =
      ox || oy
        ? data.bends.map(function (p) {
            return { x: p.x + ox, y: p.y + oy };
          })
        : data.bends;
    return bendPath(
      props.sourceX + ox,
      props.sourceY + oy,
      props.targetX + ox,
      props.targetY + oy,
      pts
    );
  }

  const result = getSmoothStepPath({
    sourceX: props.sourceX + ox,
    sourceY: props.sourceY + oy,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX + ox,
    targetY: props.targetY + oy,
    targetPosition: props.targetPosition,
    borderRadius: CORNER_R
  });
  return { path: result[0], labelX: result[1], labelY: result[2] };
}

const RangeEdge = memo(function RangeEdge(props) {
  const geom = edgePath(props);
  const data = props.data || {};
  const [hovered, setHovered] = useState(false);
  const badges = [];
  if (data.required) badges.push("R");
  if (data.multivalued) badges.push("M");
  if (data.identifier) badges.push("id");

  return h(
    Fragment,
    null,
    // A wider invisible stroke makes the thin edge easy to hover.
    h("path", {
      d: geom.path,
      fill: "none",
      stroke: "transparent",
      strokeWidth: 12,
      style: { pointerEvents: "stroke" },
      onMouseEnter: function () {
        setHovered(true);
      },
      onMouseLeave: function () {
        setHovered(false);
      }
    }),
    h(BaseEdge, {
      path: geom.path,
      markerEnd: "url(#lm-arrow-filled)",
      className: cx(
        "rf-edge",
        "rf-edge--range",
        data.usageOverride && "rf-edge--override",
        hovered && "is-hovered",
        data.dimmed && "is-dimmed"
      )
    }),
    h(
      EdgeLabelRenderer,
      null,
      h(
        "div",
        {
          className: cx("rf-edgelabel", data.dimmed && "is-dimmed"),
          style: {
            transform:
              "translate(-50%, -50%) translate(" + geom.labelX + "px," + geom.labelY + "px)"
          }
        },
        h("span", { className: "rf-edgelabel__slot" }, data.slot),
        data.card ? h("span", { className: "rf-edgelabel__card" }, data.card) : null,
        data.usageOverride
          ? h("span", { className: "rf-badge rf-badge--warn", title: "slot_usage range override" }, "~")
          : null,
        badges.map(function (b) {
          return h(
            "span",
            { key: b, className: cx("rf-badge", b === "R" && "rf-badge--req") },
            b
          );
        })
      )
    )
  );
});

function structuralEdge(className, marker) {
  return memo(function StructuralEdge(props) {
    const geom = edgePath(props);
    const data = props.data || {};
    return h(BaseEdge, {
      path: geom.path,
      markerStart: marker ? "url(#" + marker + ")" : undefined,
      className: cx("rf-edge", className, data.dimmed && "is-dimmed")
    });
  });
}

// Source is the parent for is_a and mixin, so the hollow triangle sits at the
// parent end — the UML reading of "child points at parent".
const edgeTypes = {
  range: RangeEdge,
  is_a: structuralEdge("rf-edge--isa", "lm-arrow-hollow"),
  mixin: structuralEdge("rf-edge--mixin", "lm-arrow-hollow"),
  union_of: structuralEdge("rf-edge--union", null)
};

function EdgeMarkers() {
  return h(
    "svg",
    { className: "rf-markers", "aria-hidden": "true" },
    h(
      "defs",
      null,
      h(
        "marker",
        {
          id: "lm-arrow-filled",
          markerWidth: "10",
          markerHeight: "7",
          refX: "9",
          refY: "3.5",
          orient: "auto"
        },
        h("polygon", { points: "0 0, 10 3.5, 0 7", className: "rf-marker--filled" })
      ),
      h(
        "marker",
        {
          id: "lm-arrow-hollow",
          markerWidth: "12",
          markerHeight: "10",
          refX: "10",
          refY: "5",
          orient: "auto-start-reverse"
        },
        h("polygon", { points: "0 0, 10 5, 0 10", className: "rf-marker--hollow" })
      )
    )
  );
}

/* ────────────────────────────────────────────────────────── diagram ───── */

function Toolbar(props) {
  return h(
    "div",
    { className: "diagram__bar" },
    h(
      "div",
      { className: "diagram__legend" },
      h("span", { className: "key key--isa" }, "inherits"),
      h("span", { className: "key key--mixin" }, "mixin"),
      h("span", { className: "key key--range" }, "slot")
    ),
    h(
      "div",
      { className: "diagram__actions" },
      h(
        "button",
        {
          type: "button",
          className: "diagram__btn",
          "aria-pressed": props.expanded ? "true" : "false",
          onClick: props.onToggleSlots
        },
        "Slots"
      ),
      h(
        "button",
        { type: "button", className: "diagram__btn", onClick: props.onRelayout },
        "Re-layout"
      ),
      h(
        "button",
        { type: "button", className: "diagram__btn", onClick: props.onFit },
        "Fit"
      ),
      h(
        "button",
        {
          type: "button",
          className: "diagram__btn",
          "aria-pressed": props.fullscreen ? "true" : "false",
          onClick: props.onToggleFullscreen
        },
        props.fullscreen ? "Collapse" : "Expand"
      )
    )
  );
}

function Canvas(props) {
  const graph = props.graph;
  const figure = props.figure;
  const [expanded, setExpanded] = useState(!!graph.expanded);
  const [fullscreen, setFullscreen] = useState(false);
  const [hovered, setHovered] = useState(null);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const { fitView, setViewport } = useReactFlow();
  const seq = useRef(0);
  const flowRef = useRef(null);

  // React Flow's fitView depends on nodes having been measured, which has not
  // happened on the tick a fresh layout is applied. ELK already told us where
  // everything is, so the viewport is computed from that instead.
  const fitToBounds = useCallback(
    function (bounds) {
      const el = flowRef.current;
      if (!el || !bounds || !bounds.width || !bounds.height) return;
      const pad = 28;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h) return;
      const zoom = Math.min(
        (w - pad * 2) / bounds.width,
        (h - pad * 2) / bounds.height,
        1
      );
      setViewport({
        zoom: zoom,
        x: (w - bounds.width * zoom) / 2 - bounds.x * zoom,
        y: (h - bounds.height * zoom) / 2 - bounds.y * zoom
      });
    },
    [setViewport]
  );

  const runLayout = useCallback(
    function (isExpanded) {
      const token = ++seq.current;
      layoutGraph(graph, isExpanded).then(
        function (result) {
          if (token !== seq.current) return;
          const flow = toFlow(graph, isExpanded, result.positions, result.bends);
          setNodes(flow.nodes);
          setEdges(flow.edges);
          fitToBounds(result.bounds);
        },
        function () {
          // ELK failed; fall back to a plain grid so something still renders.
          const positions = {};
          graph.nodes.forEach(function (n, i) {
            positions[n.id] = { x: (i % 4) * 300, y: Math.floor(i / 4) * 220 };
          });
          const flow = toFlow(graph, isExpanded, positions, {});
          setNodes(flow.nodes);
          setEdges(flow.edges);
        }
      );
    },
    [graph, setNodes, setEdges, fitToBounds]
  );

  useEffect(
    function () {
      runLayout(expanded);
    },
    [expanded, runLayout]
  );

  useEffect(
    function () {
      figure.classList.toggle("is-expanded", fullscreen);
      if (!fullscreen) return undefined;
      function onKey(event) {
        if (event.key === "Escape") setFullscreen(false);
      }
      document.addEventListener("keydown", onKey);
      return function () {
        document.removeEventListener("keydown", onKey);
      };
    },
    [fullscreen, figure]
  );

  // Refit once the fullscreen transition has resized the container.
  useEffect(
    function () {
      const id = window.setTimeout(function () {
        fitView({ padding: 0.12, duration: 200 });
      }, 60);
      return function () {
        window.clearTimeout(id);
      };
    },
    [fullscreen, fitView]
  );

  const neighbours = useMemo(
    function () {
      if (!hovered) return null;
      const near = new Set([hovered]);
      edges.forEach(function (e) {
        if (e.source === hovered) near.add(e.target);
        if (e.target === hovered) near.add(e.source);
      });
      return near;
    },
    [hovered, edges]
  );

  // Dimming is applied to the rendered copies, never by mutating state.
  const displayNodes = useMemo(
    function () {
      if (!neighbours) return nodes;
      return nodes.map(function (n) {
        return neighbours.has(n.id)
          ? n
          : Object.assign({}, n, { className: cx(n.className, "is-dimmed") });
      });
    },
    [nodes, neighbours]
  );

  const displayEdges = useMemo(
    function () {
      if (!hovered) return edges;
      return edges.map(function (e) {
        const touches = e.source === hovered || e.target === hovered;
        return Object.assign({}, e, {
          data: Object.assign({}, e.data, { dimmed: !touches })
        });
      });
    },
    [edges, hovered]
  );

  const onNodeClick = useCallback(function (event, node) {
    // The title is a real link; let it handle its own clicks.
    if (event.target.closest && event.target.closest("a")) return;
    if (node.data.url && !node.data.focus) window.location.href = node.data.url;
  }, []);

  return h(
    Fragment,
    null,
    h(Toolbar, {
      expanded: expanded,
      fullscreen: fullscreen,
      onToggleSlots: function () {
        setExpanded(function (v) {
          return !v;
        });
      },
      onRelayout: function () {
        runLayout(expanded);
      },
      onFit: function () {
        fitView({ padding: 0.12, duration: 200 });
      },
      onToggleFullscreen: function () {
        setFullscreen(function (v) {
          return !v;
        });
      }
    }),
    h(
      "div",
      { className: "diagram__flow", ref: flowRef },
      h(EdgeMarkers),
      h(
        ReactFlow,
        {
          nodes: displayNodes,
          edges: displayEdges,
          nodeTypes: nodeTypes,
          edgeTypes: edgeTypes,
          onNodesChange: onNodesChange,
          onEdgesChange: onEdgesChange,
          onNodeClick: onNodeClick,
          onNodeMouseEnter: function (_, node) {
            setHovered(node.id);
          },
          onNodeMouseLeave: function () {
            setHovered(null);
          },
          minZoom: 0.1,
          maxZoom: 2,
          nodesConnectable: false,
          deleteKeyCode: null,
          // Wheel events belong to the page, not the diagram — use the zoom
          // buttons or a trackpad pinch instead.
          zoomOnScroll: false,
          panOnScroll: false,
          preventScrolling: false,
          zoomOnDoubleClick: false,
          proOptions: { hideAttribution: true }
        },
        h(Background, { gap: 18, size: 1, className: "rf-bg" }),
        h(Controls, { showInteractive: false }),
        graph.nodes.length > 8
          ? h(MiniMap, {
              className: "rf-minimap",
              pannable: true,
              zoomable: true,
              nodeClassName: function (n) {
                return "rf-minimap__node rf-minimap__node--" + (n.data.kind || "class");
              }
            })
          : null
      )
    )
  );
}

function Diagram(props) {
  return h(ReactFlowProvider, null, h(Canvas, props));
}

/* ─────────────────────────────────────────────────────────── mounting ─── */

export function mountDiagrams() {
  const figures = Array.prototype.slice.call(
    document.querySelectorAll("[data-diagram]")
  );
  figures.forEach(function (figure) {
    const mount = figure.querySelector("[data-diagram-mount]");
    const payload = figure.querySelector("[data-diagram-data]");
    if (!mount || !payload) return;

    let graph;
    try {
      graph = JSON.parse(payload.textContent);
    } catch (e) {
      return;
    }
    if (!graph.nodes || !graph.nodes.length) return;

    mount.textContent = "";
    createRoot(mount).render(h(Diagram, { graph: graph, figure: figure }));
  });
}
