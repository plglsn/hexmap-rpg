/*
 * hexmap-render.js
 * Shared renderer for the hexcrawl map. Used identically by the GM and
 * public builds — the only difference between those two builds is which
 * data.js is loaded and whether editor UI is wired up around this module.
 *
 * Grid: flat-top hexagons (flat edge top & bottom), "odd-q" offset columns.
 *
 * Performance note: with 2500+ hexes, re-drawing every hex's fill/border/fog
 * pattern on every mousemove during a pan/zoom is too slow. Instead the full
 * map is rendered once to an offscreen "bitmap" canvas in world space; pan
 * and zoom just blit that bitmap with a single drawImage() call. The bitmap
 * is only re-rendered when the underlying hex data actually changes (an
 * edit, a reveal toggle) or on first load. Per-frame work on top of the
 * blit is limited to the hover/selection outline and, when zoomed in far
 * enough to read them, text labels for the handful of hexes on screen.
 */

(function (global) {
  "use strict";

  const SQRT3 = Math.sqrt(3);

  // Sand fill for the land-facing side of a coast hex's shoreline (see
  // _paintCoastHex) — a rendering constant rather than a configurable
  // terrainColors entry, same as the river's blue elsewhere in this file.
  const BEACH_COLOR = "#e8d9a8";

  const ENTITY_STYLES = {
    npc: { color: "#4a90e2", label: "♟" }, // chess pawn — a character/agent
    event: { color: "#e2794a", label: "‼" }, // double exclamation — something's happening
    location: { color: "#a24ae2", label: "⚑" }, // black flag — waypoint
    item: { color: "#c9a227", label: "◈" }, // gem — artefacts, keys, treasure
  };

  // Plain-text Unicode symbols only (no color emoji) so they render as a
  // single flat color via ctx.fillStyle everywhere, offline, with no font
  // dependency beyond a normal system sans-serif.
  const TERRAIN_ICONS = {
    unknown: "◌", // dotted circle — undetermined
    desert: "ψ", // psi (moved here from grassland)
    arctic: "✳", // eight-spoked asterisk — frost
    swamp: "☵", // broken bars (trigram for water) — murky wetland
    forest: "♣", // club — tree canopy
    jungle: "♧", // white club — denser canopy
    lake: "∿", // sine wave — still water
    coast: "≈", // double wave
    ocean: "≋", // triple wave — open water
    mountain: "▲", // triangle — peak
  };

  const POI_ICONS = {
    Settlement: "⌂", // house
    Ruins: "▦", // square with fill — rubble
    Dungeon: "☠", // skull and crossbones
    Shrine: "†", // dagger — traditional map symbol for a shrine/chapel
    Landmark: "◆", // diamond
    Fortress: "♜", // chess rook — stronghold
    "Camp or Lair": "△", // open triangle — tent
    "Natural Wonder": "✦", // four-pointed star
    Other: "●", // filled circle — generic marker
  };

  function axialToOddq(q, r) {
    const col = q;
    const row = r + (q - (q & 1)) / 2;
    return { col, row };
  }

  function axialRound(q, r) {
    let s = -q - r;
    let rq = Math.round(q);
    let rr = Math.round(r);
    let rs = Math.round(s);

    const qDiff = Math.abs(rq - q);
    const rDiff = Math.abs(rr - r);
    const sDiff = Math.abs(rs - s);

    if (qDiff > rDiff && qDiff > sDiff) {
      rq = -rr - rs;
    } else if (rDiff > sDiff) {
      rr = -rq - rs;
    }
    return { q: rq, r: rr };
  }

  // Neighbor direction table for "odd-q" offset coordinates (flat-top
  // hexes, odd columns shoved down) — matches the y-shift in hexCenter()
  // below. Used to constrain river-drawing to hex-to-hex adjacency.
  const ODDQ_DIRS = [
    // even columns
    [[+1, 0], [+1, -1], [0, -1], [-1, -1], [-1, 0], [0, +1]],
    // odd columns
    [[+1, +1], [+1, 0], [0, -1], [-1, 0], [-1, +1], [0, +1]],
  ];

  class HexMap {
    constructor(canvas, data, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.data = data;
      this.opts = opts || {};
      this.cols = data.meta.cols;
      this.rows = data.meta.rows;
      this.size = data.meta.hexSize || 20;
      this.terrainColors = data.terrainColors || {};

      // NPCs / events / locations — a movable layer on top of the hex
      // grid, keyed by id. { id: { type, name, notes, secret, hex, revealed } }
      this.entities = data.entities || {};
      this._entityIndex = null; // hexKey -> [entityId, ...]
      this._entityIndexDirty = true;

      // Rivers — a named path of adjacent hex keys, drawn as a line across
      // the hexes it crosses (independent of each hex's own terrain).
      // { id: { name, notes, secret, path: ["col,row", ...] } }
      this.data.rivers = this.data.rivers || {};

      // Roads — same shape and mechanics as rivers (see _paintPathNetwork)
      // but snapping to points of interest instead of open water, and
      // drawn as a dashed brown line instead of solid blue.
      this.data.roads = this.data.roads || {};

      // When set, the next canvas click moves this entity instead of
      // selecting a hex. See armPlacement()/cancelPlacement().
      this._placement = null;

      // Resolution of the cached world bitmap, in bitmap-pixels per world
      // unit. Higher = crisper at max zoom, more memory/render time.
      this.bitmapScale = this.opts.bitmapScale || 2.5;
      this.bitmapCanvas = null;
      this._bitmapDirty = true;

      // view transform: screen = world * scale + offset
      this.scale = 1;
      this.offsetX = 40;
      this.offsetY = 40;

      this.selected = null; // {col,row}
      this.hoverKey = null;

      this._drawScheduled = false;

      this._computeWorldBounds();
      this._bindEvents();
      this._resize();
      window.addEventListener("resize", () => this._resize());
    }

    // ---- coordinate helpers ----

    hexKey(col, row) {
      return col + "," + row;
    }

    hexCenter(col, row) {
      const s = this.size;
      const x = s * 1.5 * col;
      const y = s * SQRT3 * (row + 0.5 * (col & 1));
      return { x, y };
    }

    worldToScreen(x, y) {
      return {
        x: x * this.scale + this.offsetX,
        y: y * this.scale + this.offsetY,
      };
    }

    screenToWorld(x, y) {
      return {
        x: (x - this.offsetX) / this.scale,
        y: (y - this.offsetY) / this.scale,
      };
    }

    pixelToHex(screenX, screenY) {
      const w = this.screenToWorld(screenX, screenY);
      const s = this.size;
      const q = ((2 / 3) * w.x) / s;
      const r = ((-1 / 3) * w.x + (SQRT3 / 3) * w.y) / s;
      const rounded = axialRound(q, r);
      const { col, row } = axialToOddq(rounded.q, rounded.r);
      if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) {
        return null;
      }
      return { col, row };
    }

    hexCorners(cx, cy) {
      const pts = [];
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 180) * (60 * i);
        pts.push({
          x: cx + this.size * Math.cos(angle),
          y: cy + this.size * Math.sin(angle),
        });
      }
      return pts;
    }

    _computeWorldBounds() {
      const corners = [
        [0, 0],
        [this.cols - 1, 0],
        [0, this.rows - 1],
        [this.cols - 1, this.rows - 1],
      ];
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      corners.forEach(([c, r]) => {
        const center = this.hexCenter(c, r);
        this.hexCorners(center.x, center.y).forEach((p) => {
          minX = Math.min(minX, p.x);
          maxX = Math.max(maxX, p.x);
          minY = Math.min(minY, p.y);
          maxY = Math.max(maxY, p.y);
        });
      });
      this.bounds = { minX, maxX, minY, maxY };
    }

    // ---- data access ----

    getHex(col, row) {
      return this.data.hexes[this.hexKey(col, row)];
    }

    setHex(col, row, fields) {
      const key = this.hexKey(col, row);
      this.data.hexes[key] = Object.assign(
        {},
        this.data.hexes[key],
        fields
      );
      this._bitmapDirty = true;
    }

    /** Call after mutating this.data directly (e.g. bulk reveal/hide, import). */
    invalidate() {
      this._bitmapDirty = true;
      this._entityIndexDirty = true;
    }

    // ---- entities (NPCs / events / locations) ----

    getEntity(id) {
      return this.entities[id];
    }

    listEntities() {
      return Object.keys(this.entities).map((id) => Object.assign({ id }, this.entities[id]));
    }

    /** Create (if id is new) or update an entity. Pass hex: null to unplace it. */
    setEntity(id, fields) {
      this.entities[id] = Object.assign(
        { type: "npc", name: "", notes: "", secret: "", hex: null, revealed: false },
        this.entities[id],
        fields
      );
      this._entityIndexDirty = true;
      return this.entities[id];
    }

    deleteEntity(id) {
      delete this.entities[id];
      this._entityIndexDirty = true;
    }

    entitiesAt(col, row) {
      this._ensureEntityIndex();
      const ids = this._entityIndex[this.hexKey(col, row)] || [];
      return ids.map((id) => Object.assign({ id }, this.entities[id]));
    }

    _ensureEntityIndex() {
      if (!this._entityIndexDirty && this._entityIndex) return;
      const index = {};
      Object.keys(this.entities).forEach((id) => {
        const e = this.entities[id];
        if (!e.hex) return;
        (index[e.hex] = index[e.hex] || []).push(id);
      });
      this._entityIndex = index;
      this._entityIndexDirty = false;
    }

    /**
     * Arm "click to place" mode: the next canvas click moves entity `id` to
     * whatever hex was clicked (instead of selecting that hex) and calls
     * onPlaced(hit) with the result. Press Escape or call cancelPlacement()
     * to back out without moving anything.
     */
    armPlacement(id, onPlaced) {
      this._placement = { id, onPlaced };
      this.canvas.style.cursor = "crosshair";
    }

    cancelPlacement() {
      this._placement = null;
      this.canvas.style.cursor = "";
    }

    // ---- rivers ----

    listRivers() {
      return Object.keys(this.data.rivers).map((id) => Object.assign({ id }, this.data.rivers[id]));
    }

    getRiver(id) {
      return this.data.rivers[id];
    }

    /** Create (if id is new) or update a river. */
    setRiver(id, fields) {
      this.data.rivers[id] = Object.assign(
        // edgeClipStart/edgeClipEnd and snapStartToWater/snapEndToWater all
        // default to true (extend a dangling boundary end to the map edge;
        // snap an end to nearby open water) so existing rivers saved before
        // these fields existed keep behaving exactly like they did before —
        // every river used to auto-snap to water unconditionally.
        {
          name: "",
          notes: "",
          secret: "",
          path: [],
          edgeClipStart: true,
          edgeClipEnd: true,
          snapStartToWater: true,
          snapEndToWater: true,
          // Off by default so existing rivers keep shipping in full
          // regardless of fog of war, same as before this field existed —
          // the GM opts a particular river into hiding its unexplored
          // stretches, rather than every river doing it unconditionally.
          hideUnexplored: false,
        },
        this.data.rivers[id],
        fields
      );
      this._bitmapDirty = true;
      return this.data.rivers[id];
    }

    deleteRiver(id) {
      delete this.data.rivers[id];
      this._bitmapDirty = true;
    }

    // ---- roads ----

    listRoads() {
      return Object.keys(this.data.roads).map((id) => Object.assign({ id }, this.data.roads[id]));
    }

    getRoad(id) {
      return this.data.roads[id];
    }

    /** Create (if id is new) or update a road. */
    setRoad(id, fields) {
      this.data.roads[id] = Object.assign(
        {
          name: "",
          notes: "",
          secret: "",
          path: [],
          edgeClipStart: true,
          edgeClipEnd: true,
          snapStartToPOI: true,
          snapEndToPOI: true,
          hideUnexplored: false,
        },
        this.data.roads[id],
        fields
      );
      this._bitmapDirty = true;
      return this.data.roads[id];
    }

    deleteRoad(id) {
      delete this.data.roads[id];
      this._bitmapDirty = true;
    }

    /** Up to 6 in-bounds neighbors of (col,row), for odd-q offset coords. */
    neighbors(col, row) {
      const parity = col & 1;
      return ODDQ_DIRS[parity]
        .map(([dc, dr]) => ({ col: col + dc, row: row + dr }))
        .filter((n) => n.col >= 0 && n.col < this.cols && n.row >= 0 && n.row < this.rows);
    }

    isAdjacent(colA, rowA, colB, rowB) {
      return this.neighbors(colA, rowA).some((n) => n.col === colB && n.row === rowB);
    }

    // Hex (great-circle-equivalent) distance between two hexes — the
    // number of hex-to-hex steps it'd take to walk from one to the other.
    // Converts odd-q offset coordinates to cube coordinates (the inverse
    // of axialToOddq above) since cube/axial distance has a simple closed
    // form that offset coordinates don't.
    hexDistance(colA, rowA, colB, rowB) {
      const toCube = (col, row) => {
        const x = col;
        const z = row - (col - (col & 1)) / 2;
        const y = -x - z;
        return { x, y, z };
      };
      const a = toCube(colA, rowA);
      const b = toCube(colB, rowB);
      return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
    }

    // Every in-bounds hex within `radius` hex-steps of (col,row), including
    // the center hex itself — a breadth-first expansion outward through
    // neighbors() rather than a distance check over the whole grid, so it
    // stays cheap even on a large map when the radius is small.
    hexesInRadius(col, row, radius) {
      const startKey = this.hexKey(col, row);
      const visited = new Map([[startKey, { col, row }]]);
      let frontier = [{ col, row }];
      for (let step = 0; step < radius; step++) {
        const next = [];
        frontier.forEach((h) => {
          this.neighbors(h.col, h.row).forEach((n) => {
            const key = this.hexKey(n.col, n.row);
            if (!visited.has(key)) {
              visited.set(key, n);
              next.push(n);
            }
          });
        });
        frontier = next;
      }
      return Array.from(visited.values());
    }

    // ---- rendering ----

    _resize() {
      const rect = this.canvas.parentElement.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = rect.width * dpr;
      this.canvas.height = rect.height * dpr;
      this.canvas.style.width = rect.width + "px";
      this.canvas.style.height = rect.height + "px";
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.cssWidth = rect.width;
      this.cssHeight = rect.height;
      this.draw();
    }

    /** Coalesce multiple draw() requests (e.g. rapid mousemove) into one per frame. */
    scheduleDraw() {
      if (this._drawScheduled) return;
      this._drawScheduled = true;
      requestAnimationFrame(() => {
        this._drawScheduled = false;
        this.draw();
      });
    }

    draw() {
      if (this._bitmapDirty || !this.bitmapCanvas) {
        this._renderBitmap();
      }

      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
      ctx.fillStyle = "#0d1117";
      ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);

      // Single blit for the whole map — this is the expensive-looking part
      // that's actually cheap, since it's raster scaling, not path drawing.
      const b = this.bounds;
      const destX = this.offsetX + b.minX * this.scale;
      const destY = this.offsetY + b.minY * this.scale;
      const destW = (b.maxX - b.minX) * this.scale;
      const destH = (b.maxY - b.minY) * this.scale;
      ctx.imageSmoothingEnabled = true;
      if ("imageSmoothingQuality" in ctx) ctx.imageSmoothingQuality = "high";
      ctx.drawImage(this.bitmapCanvas, destX, destY, destW, destH);

      this._drawDynamicOverlay();
    }

    // Renders fill/border/fog once per data change into an offscreen canvas
    // in world space. Pan/zoom never touches this.
    _renderBitmap() {
      const b = this.bounds;
      const bw = Math.max(1, Math.ceil((b.maxX - b.minX) * this.bitmapScale));
      const bh = Math.max(1, Math.ceil((b.maxY - b.minY) * this.bitmapScale));

      if (!this.bitmapCanvas) this.bitmapCanvas = document.createElement("canvas");
      if (this.bitmapCanvas.width !== bw || this.bitmapCanvas.height !== bh) {
        this.bitmapCanvas.width = bw;
        this.bitmapCanvas.height = bh;
      }

      const bctx = this.bitmapCanvas.getContext("2d");
      bctx.setTransform(1, 0, 0, 1, 0, 0);
      bctx.clearRect(0, 0, bw, bh);
      bctx.save();
      bctx.scale(this.bitmapScale, this.bitmapScale);
      bctx.translate(-b.minX, -b.minY);

      for (let col = 0; col < this.cols; col++) {
        for (let row = 0; row < this.rows; row++) {
          this._paintHex(bctx, col, row);
        }
      }

      // Roads first so a river crossing one draws on top of it — the
      // thicker, solid river reads more clearly than the thin dashed road
      // at the crossing point.
      this._paintRoads(bctx);
      this._paintRivers(bctx);

      bctx.restore();
      this._bitmapDirty = false;
    }

    // `style` is { color, widthFactor, minWidth, dashed } — shared by
    // rivers (solid blue) and roads (dashed brown), the two "path network"
    // features drawn this way. By default a river/road shows fully
    // regardless of fog of war (like a rumour, exempt), and a GM can opt a
    // particular one into hiding its unexplored stretches instead (see
    // _paintPathNetwork) — either way there's no separate "faded/fogged"
    // color/width treatment applied here; a hidden stretch is simply not
    // drawn at all, rather than drawn differently.
    _applyPathStrokeStyle(ctx, style) {
      if (style.dashed) {
        ctx.setLineDash([this.size * 0.22, this.size * 0.14]);
      }
      ctx.strokeStyle = style.color;
      ctx.lineWidth = Math.max(style.minWidth, this.size * style.widthFactor);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
    }

    // A short straight hex-center-to-hex-center connector — used only for
    // the stub joining a path's end to a neighboring hex it auto-connects
    // to (its snap target — open water for a river, a point of interest
    // for a road — or another path of the same kind's end). The path's own
    // course is a smooth curve instead (see _strokeSmoothPath); this stays
    // straight since it's always just one hop.
    _paintPathStub(ctx, keyA, keyB, style) {
      const a = this._keyToColRow(keyA);
      const b = this._keyToColRow(keyB);
      if (!a || !b) return;
      const hexA = this.getHex(a.col, a.row);
      const hexB = this.getHex(b.col, b.row);
      if (!hexA || !hexB) return;

      const centerA = this.hexCenter(a.col, a.row);
      const centerB = this.hexCenter(b.col, b.row);

      ctx.save();
      this._applyPathStrokeStyle(ctx, style);
      ctx.beginPath();
      ctx.moveTo(centerA.x, centerA.y);
      ctx.lineTo(centerB.x, centerB.y);
      ctx.stroke();
      ctx.restore();
    }

    // Smooth curve through an ordered list of {x,y} world points, using a
    // Catmull-Rom spline (converted to cubic beziers) — passes through
    // every point exactly, rather than hex-center-to-hex-center straight
    // segments, which kink sharply at every hex a path crosses. The two
    // hexes just outside each end of the run (if any) are used only to
    // shape the curve's tangent at the ends, in the standard "clamp by
    // duplicating the endpoint" way — they aren't extra points on the line
    // themselves.
    _strokeSmoothPath(ctx, points, style) {
      if (points.length < 2) return;
      ctx.save();
      this._applyPathStrokeStyle(ctx, style);
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      if (points.length === 2) {
        ctx.lineTo(points[1].x, points[1].y);
      } else {
        for (let i = 0; i < points.length - 1; i++) {
          const p0 = points[i - 1] || points[i];
          const p1 = points[i];
          const p2 = points[i + 1];
          const p3 = points[i + 2] || p2;
          ctx.bezierCurveTo(
            p1.x + (p2.x - p0.x) / 6,
            p1.y + (p2.y - p0.y) / 6,
            p2.x - (p3.x - p1.x) / 6,
            p2.y - (p3.y - p1.y) / 6,
            p2.x,
            p2.y
          );
        }
      }
      ctx.stroke();
      ctx.restore();
    }

    // True for a hex on the outermost ring of the grid — the only hexes a
    // path's dangling end can sensibly be extended out to the true map
    // edge from (see _pathEdgeExtension). An end in the interior has no
    // nearby edge to reach for; stretching it out to the border regardless
    // of distance would draw a long, unrelated-looking line across
    // territory the path never actually crosses.
    _isBoundaryHex(col, row) {
      return col === 0 || col === this.cols - 1 || row === 0 || row === this.rows - 1;
    }

    // Extends a path's dangling end at `boundaryPoint` out to the true
    // edge of the map, continuing in the direction it was already heading
    // (away from `awayFromPoint`, typically the next hex in from the end)
    // — so it reads as continuing off the map rather than stopping
    // abruptly a little short of the border. Returns null if there's no
    // direction to extend along (a single-hex path with no map center to
    // push away from either, degenerately) or the ray doesn't reach the
    // boundary.
    _pathEdgeExtension(boundaryPoint, awayFromPoint) {
      const dx = boundaryPoint.x - awayFromPoint.x;
      const dy = boundaryPoint.y - awayFromPoint.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) return null;
      const dir = { x: dx / len, y: dy / len };
      const b = this.bounds;
      let t = Infinity;
      if (dir.x > 0) t = Math.min(t, (b.maxX - boundaryPoint.x) / dir.x);
      else if (dir.x < 0) t = Math.min(t, (b.minX - boundaryPoint.x) / dir.x);
      if (dir.y > 0) t = Math.min(t, (b.maxY - boundaryPoint.y) / dir.y);
      else if (dir.y < 0) t = Math.min(t, (b.minY - boundaryPoint.y) / dir.y);
      if (!isFinite(t) || t <= 0) return null;
      return { x: boundaryPoint.x + dir.x * t, y: boundaryPoint.y + dir.y * t };
    }

    // Hex keys this path's end at `key` already auto-connects to (its snap
    // target, if `includeSnap` — the GM's per-end "snap to..." toggle — or
    // another path of the same kind's end, always). An end with any
    // connections gets a stub instead of an edge extension — the two are
    // mutually exclusive, since an end already visibly reaching a lake (or
    // a village, for a road) has nowhere else to terminate toward. Joining
    // another path of the same kind is left out of that toggle entirely —
    // snapping to the target terrain/feature and joining another path are
    // different things, and there's rarely a reason not to want two paths
    // that already meet to visibly connect.
    _pathEndConnections(id, path, key, endpointOwners, isSnapTarget, includeSnap) {
      const pos = this._keyToColRow(key);
      if (!pos) return [];
      const out = [];
      this.neighbors(pos.col, pos.row).forEach((n) => {
        const nKey = this.hexKey(n.col, n.row);
        if (path.indexOf(nKey) !== -1) return; // already part of this path's own course
        const nHex = this.getHex(n.col, n.row);
        const isSnap = includeSnap && isSnapTarget(nHex);
        const otherPathHere =
          endpointOwners[nKey] && Array.from(endpointOwners[nKey]).some((otherId) => otherId !== id);
        if (isSnap || otherPathHere) out.push(nKey);
      });
      return out;
    }

    // Splits `path` (an ordered array of hex keys) into the maximal
    // contiguous runs of revealed hexes, as {start, end} index pairs
    // (inclusive) into `path`. Only used when a river/road has opted into
    // "hide on unexplored hexes" and the current viewer respects fog (see
    // _paintPathNetwork) — an unrevealed hex along the course simply isn't
    // part of any run, splitting the drawn course around it the same way
    // hexes/entities are already hidden elsewhere.
    _revealedPathRuns(path) {
      const runs = [];
      let runStart = null;
      for (let i = 0; i < path.length; i++) {
        const pos = this._keyToColRow(path[i]);
        const hex = pos && this.getHex(pos.col, pos.row);
        const revealed = !!(hex && hex.revealed !== false);
        if (revealed) {
          if (runStart === null) runStart = i;
        } else if (runStart !== null) {
          runs.push({ start: runStart, end: i - 1 });
          runStart = null;
        }
      }
      if (runStart !== null) runs.push({ start: runStart, end: path.length - 1 });
      return runs;
    }

    // Where a visible run gets cut off by fog rather than ending for real,
    // this is the point the curve should actually stop at: the midpoint of
    // the physical edge (keyA)'s hex shares with (keyB)'s hex, not either
    // hex's own center — stopping dead at a hex's center would look like
    // the river/road just gives up in the middle of that hex, rather than
    // continuing on past what's currently been explored. For a regular hex
    // grid, the line connecting two adjacent hexes' centers is bisected by
    // their shared edge, so that midpoint needs no extra corner geometry —
    // it's just the midpoint of the two centers.
    _pathFogEdgePoint(keyA, keyB) {
      const a = this._keyToColRow(keyA);
      const b = this._keyToColRow(keyB);
      if (!a || !b) return null;
      const centerA = this.hexCenter(a.col, a.row);
      const centerB = this.hexCenter(b.col, b.row);
      return { x: (centerA.x + centerB.x) / 2, y: (centerA.y + centerB.y) / 2 };
    }

    // Shared by rivers and roads: each entry in `this.data[dataKey]` is
    // drawn as one smooth curve passing through every hex center on its
    // course, plus:
    //   - where a dangling end sits on the outer ring of the map, a short
    //     extension out to the true map edge (unless the GM has unchecked
    //     "clips to map edge" for that particular end);
    //   - where an end instead borders its snap target (open water for a
    //     river, a point of interest for a road) or another path of the
    //     same kind, a short straight stub connecting the two.
    // By default a river/road is a landscape feature exempt from fog of
    // war, the same way a rumour is — it ships and draws in full
    // regardless of which hexes along it are revealed. A GM can opt a
    // particular one into `hideUnexplored` instead, which — only for a
    // viewer that respects fog at all (the public build, or the GM's own
    // "Preview as player" toggle; the GM's regular view always sees
    // everything) — draws only the stretches sitting on revealed hexes,
    // splitting the course at every unrevealed hex it crosses (see
    // _revealedPathRuns). Where a stretch gets cut short by fog rather than
    // ending for real, it's extended to the shared edge with the
    // unrevealed hex beyond it (_pathFogEdgePoint) instead of stopping
    // abruptly at the last revealed hex's center — auto-connect stubs and
    // map-edge extensions still only ever apply at the path's true start/
    // end, never at a fog cut, since a fog cut isn't a logical endpoint of
    // the river/road, just where the viewer's knowledge of it stops.
    // `isSnapTarget(hex)` decides what a dangling end auto-connects to;
    // `snapStartField`/`snapEndField` are the per-path boolean fields
    // gating that per end (e.g. "snapStartToWater"); `style` controls how
    // it's drawn (see _applyPathStrokeStyle).
    _paintPathNetwork(ctx, dataKey, isSnapTarget, snapStartField, snapEndField, style) {
      const paths = this.data[dataKey] || {};
      const ids = Object.keys(paths);
      const gridCenter = {
        x: (this.bounds.minX + this.bounds.maxX) / 2,
        y: (this.bounds.minY + this.bounds.maxY) / 2,
      };

      // hexKey -> set of path ids that start or end there, so a
      // neighboring path's end can be found in O(1) instead of rescanning
      // every other path for every endpoint.
      const endpointOwners = {};
      ids.forEach((id) => {
        const path = paths[id].path || [];
        if (!path.length) return;
        [path[0], path[path.length - 1]].forEach((key) => {
          (endpointOwners[key] = endpointOwners[key] || new Set()).add(id);
        });
      });

      const drawnStubs = new Set(); // dedupe shared endpoint<->neighbor pairs

      ids.forEach((id) => {
        const entry = paths[id];
        const path = entry.path || [];
        if (!path.length) return;

        const fogAware = entry.hideUnexplored && this.opts.respectFog;
        const runs = fogAware ? this._revealedPathRuns(path) : [{ start: 0, end: path.length - 1 }];

        runs.forEach((run) => {
          const isTrueStart = run.start === 0;
          const isTrueEnd = run.end === path.length - 1;
          const startKey = path[run.start];
          const endKey = path[run.end];
          const startPos = this._keyToColRow(startKey);
          const endPos = this._keyToColRow(endKey);
          const startCenter = this.hexCenter(startPos.col, startPos.row);
          const endCenter = this.hexCenter(endPos.col, endPos.row);

          const startConnections = isTrueStart
            ? this._pathEndConnections(id, path, startKey, endpointOwners, isSnapTarget, entry[snapStartField] !== false)
            : [];
          const endConnections =
            isTrueEnd && path.length > 1
              ? this._pathEndConnections(id, path, endKey, endpointOwners, isSnapTarget, entry[snapEndField] !== false)
              : [];

          const wantsStartExtend =
            isTrueStart &&
            entry.edgeClipStart !== false &&
            !startConnections.length &&
            this._isBoundaryHex(startPos.col, startPos.row);
          const wantsEndExtend =
            isTrueEnd &&
            path.length > 1 &&
            entry.edgeClipEnd !== false &&
            !endConnections.length &&
            this._isBoundaryHex(endPos.col, endPos.row);

          const secondPos = run.end > run.start ? this._keyToColRow(path[run.start + 1]) : null;
          const secondPoint = secondPos ? this.hexCenter(secondPos.col, secondPos.row) : null;
          const secondLastPos = run.end > run.start ? this._keyToColRow(path[run.end - 1]) : null;
          const secondLastPoint = secondLastPos ? this.hexCenter(secondLastPos.col, secondLastPos.row) : null;

          const startExtension = wantsStartExtend
            ? this._pathEdgeExtension(startCenter, secondPoint || gridCenter)
            : null;
          const endExtension = wantsEndExtend
            ? this._pathEdgeExtension(endCenter, secondLastPoint || gridCenter)
            : null;

          const startFogCut = !isTrueStart ? this._pathFogEdgePoint(path[run.start - 1], startKey) : null;
          const endFogCut = !isTrueEnd ? this._pathFogEdgePoint(endKey, path[run.end + 1]) : null;

          // ---- main path curve (just this run, when fog-split) ----
          const points = [];
          for (let i = run.start; i <= run.end; i++) {
            const p = this._keyToColRow(path[i]);
            points.push(this.hexCenter(p.col, p.row));
          }
          if (startExtension) points.unshift(startExtension);
          if (startFogCut) points.unshift(startFogCut);
          if (endExtension) points.push(endExtension);
          if (endFogCut) points.push(endFogCut);
          this._strokeSmoothPath(ctx, points, style);

          // ---- auto-connect stubs (true endpoints only) ----
          [
            { key: startKey, connections: startConnections },
            { key: endKey, connections: endConnections },
          ].forEach(({ key, connections }) => {
            connections.forEach((nKey) => {
              const dedupeKey = [key, nKey].sort().join("|");
              if (drawnStubs.has(dedupeKey)) return;
              drawnStubs.add(dedupeKey);
              this._paintPathStub(ctx, key, nKey, style);
            });
          });
        });
      });
    }

    _paintRivers(ctx) {
      const WATER_TERRAINS = { ocean: true, coast: true, lake: true };
      this._paintPathNetwork(
        ctx,
        "rivers",
        (hex) => !!(hex && WATER_TERRAINS[hex.terrain]),
        "snapStartToWater",
        "snapEndToWater",
        { color: "#4fa3d1", widthFactor: 0.16, minWidth: 1.5, dashed: false }
      );
    }

    // Roads connect points of interest — any hex with a poi set — instead
    // of open water, drawn thinner, dashed, and in a dirt-brown rather
    // than river-blue so the two path networks stay visually distinct even
    // where they cross.
    _paintRoads(ctx) {
      this._paintPathNetwork(
        ctx,
        "roads",
        (hex) => !!(hex && hex.poi),
        "snapStartToPOI",
        "snapEndToPOI",
        { color: "#8a6a3d", widthFactor: 0.07, minWidth: 1, dashed: true }
      );
    }

    // Every other hex sharing the same physical point as corner `cornerIndex`
    // of (col,row) — up to 2 of them in the interior of the grid, fewer at
    // the map's edge. Found geometrically (by matching corner coordinates)
    // rather than by reasoning about direction indices, so it's correct
    // regardless of how corner/neighbor ordering happens to line up.
    _hexesAtCorner(col, row, cornerIndex) {
      const center = this.hexCenter(col, row);
      const target = this.hexCorners(center.x, center.y)[cornerIndex];
      const eps = this.size * 0.01;
      const found = [];
      this.neighbors(col, row).forEach((n) => {
        const nCenter = this.hexCenter(n.col, n.row);
        const match = this.hexCorners(nCenter.x, nCenter.y).some(
          (p) => Math.abs(p.x - target.x) < eps && Math.abs(p.y - target.y) < eps
        );
        if (match) found.push(n);
      });
      return found;
    }

    // True if (col,row) is open water (ocean or lake), purely from
    // whatever terrain data this HexMap actually has for it. Deliberately
    // NOT fog-aware — a revealed coast hex's shoreline shape is allowed to
    // hint at what an adjacent unrevealed hex is (that's not treated as a
    // spoiler here), so build.py ships the `terrain` field for a hex
    // whenever a revealed coast hex neighbors it, specifically so this can
    // render the correct shoreline shape on the public build too, not just
    // in the GM's own view. Nothing else about that neighbor (name, notes,
    // secret, population, POI) is shipped early — only its terrain type,
    // and only when a revealed coast hex actually borders it.
    _isWaterNeighbor(col, row) {
      const hex = this.getHex(col, row);
      return !!hex && (hex.terrain === "ocean" || hex.terrain === "lake");
    }

    // A corner "borders water" if any hex meeting at that exact physical
    // point (this hex's own neighbors that share the vertex) reads as
    // water to this viewer (see _isWaterNeighbor). Because this only
    // depends on the vertex's location and what the hexes touching it look
    // like to THIS viewer — never on which hex is asking — two coast hexes
    // that share a corner and see the same fog state always agree on its
    // classification, which is what lets their shorelines meet exactly
    // without any extra coordination.
    _isWaterCorner(col, row, cornerIndex) {
      return this._hexesAtCorner(col, row, cornerIndex).some((n) => this._isWaterNeighbor(n.col, n.row));
    }

    // Longest run of `true` in a cyclic boolean array (wrap-around allowed),
    // as { start, len }. Returns null if none are true.
    _largestCyclicArc(bools) {
      const n = bools.length;
      if (!bools.some(Boolean)) return null;
      if (bools.every(Boolean)) return { start: 0, len: n };
      const scanFrom = bools.indexOf(false);
      let best = null,
        curStart = null,
        curLen = 0;
      for (let step = 0; step < n; step++) {
        const idx = (scanFrom + step) % n;
        if (bools[idx]) {
          if (curStart === null) curStart = idx;
          curLen++;
          if (!best || curLen > best.len) best = { start: curStart, len: curLen };
        } else {
          curStart = null;
          curLen = 0;
        }
      }
      return best;
    }

    // A coast hex gets a two-tone fill — beach on the land-facing side,
    // water on the water-facing side — split by a smooth curve, instead of
    // the flat single-color fill every other terrain gets. The curve's two
    // endpoints are the hex's own corners that border open water in a
    // neighboring tile (see _isWaterCorner); everything between them,
    // going around whichever way stays on water corners, is water — the
    // rest of the hex is beach. Since neighboring coast hexes classify a
    // shared corner identically, their curves always meet at the same
    // point, so the waterline reads as one continuous shoreline across the
    // whole coastal band instead of looking stitched together hex by hex.
    _paintCoastHex(ctx, col, row, center, corners) {
      const waterCorner = [];
      let waterTerrainSeen = null;
      for (let i = 0; i < 6; i++) {
        const hexesHere = this._hexesAtCorner(col, row, i);
        // _isWaterNeighbor(), not a raw terrain check — a neighbor the
        // current viewer hasn't discovered yet (fog of war permitting)
        // never counts as water for them, so a coast hex's shoreline curve
        // only ever reflects what that viewer could actually know.
        const waterHex = hexesHere.find((n) => this._isWaterNeighbor(n.col, n.row));
        waterCorner.push(!!waterHex);
        if (waterHex && !waterTerrainSeen) waterTerrainSeen = this.getHex(waterHex.col, waterHex.row).terrain;
      }

      const waterColor = this.terrainColors[waterTerrainSeen] || this.terrainColors.coast || "#5aa9d6";
      const arc = this._largestCyclicArc(waterCorner);

      // No neighboring water at all, or water on every side (an all-water
      // "coast" hex, e.g. mid-strait) — just a flat fill, no curve needed.
      if (!arc) {
        ctx.fillStyle = BEACH_COLOR;
        ctx.fill();
        return;
      }
      if (arc.len === 6) {
        ctx.fillStyle = waterColor;
        ctx.fill();
        return;
      }

      ctx.fillStyle = BEACH_COLOR;
      ctx.fill();

      const startIdx = arc.start;
      const endIdx = (arc.start + arc.len - 1) % 6;
      const A = corners[startIdx];
      const B = corners[endIdx];

      ctx.save();
      ctx.beginPath();
      if (arc.len === 1) {
        // A single water corner has no second boundary corner to curve
        // toward — carve a small water notch out of that one corner
        // instead, bounded by the midpoints of its two adjacent edges.
        const prev = corners[(startIdx + 5) % 6];
        const next = corners[(startIdx + 1) % 6];
        const midPrev = { x: (A.x + prev.x) / 2, y: (A.y + prev.y) / 2 };
        const midNext = { x: (A.x + next.x) / 2, y: (A.y + next.y) / 2 };
        const ctrl = {
          x: (midPrev.x + midNext.x) / 2 + (center.x - (midPrev.x + midNext.x) / 2) * 0.5,
          y: (midPrev.y + midNext.y) / 2 + (center.y - (midPrev.y + midNext.y) / 2) * 0.5,
        };
        ctx.moveTo(midPrev.x, midPrev.y);
        ctx.lineTo(A.x, A.y);
        ctx.lineTo(midNext.x, midNext.y);
        ctx.quadraticCurveTo(ctrl.x, ctrl.y, midPrev.x, midPrev.y);
      } else {
        // Real hex boundary through any water corners between the two
        // ends of the arc — those edges genuinely border more water tiles,
        // so there's nothing to smooth over there.
        ctx.moveTo(A.x, A.y);
        for (let step = 1; step < arc.len; step++) {
          const idx = (startIdx + step) % 6;
          ctx.lineTo(corners[idx].x, corners[idx].y);
        }
        // Smooth curve back from B to A, cutting through the interior —
        // this is the actual "invented" shoreline, so it's the one part
        // that gets bulged toward the hex center rather than following a
        // straight edge.
        const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
        const ctrl = { x: mid.x * 0.55 + center.x * 0.45, y: mid.y * 0.55 + center.y * 0.45 };
        ctx.quadraticCurveTo(ctrl.x, ctrl.y, A.x, A.y);
      }
      ctx.closePath();
      // Every point on this sub-path is a corner, edge-midpoint, or
      // interior blend of the hex's own corners/center — all inside the
      // (convex) hex — so this fill can never spill past the hex's own
      // boundary and doesn't need an explicit clip.
      ctx.fillStyle = waterColor;
      ctx.fill();
      ctx.restore();

      // ctx.save()/restore() only cover drawing state, not the current
      // path — beginPath() above replaced the hex's own outline as the
      // active path with this water sub-path, and restore() doesn't bring
      // it back. _paintHex still needs the actual hex outline as the
      // active path afterward (for the fog overlay's clip and the border
      // stroke), so it has to be rebuilt here before returning.
      ctx.beginPath();
      corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
    }

    _paintHex(ctx, col, row) {
      const hex = this.getHex(col, row);
      if (!hex) return;
      const center = this.hexCenter(col, row);
      const corners = this.hexCorners(center.x, center.y);
      const revealed = hex.revealed !== false;
      const hideFromViewer = this.opts.respectFog && !revealed;

      ctx.beginPath();
      corners.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();

      if (hideFromViewer) {
        // Public build only: don't draw the hex at all (no fill, no fog
        // block, no border) unless it has a rumour to show. Filling every
        // unrevealed hex as a solid fog tile would still trace out the
        // full grid — showing players exactly how big the map is even
        // though they've only explored a corner of it. Leaving unexplored,
        // rumour-less hexes fully untouched means only the explored area
        // and rumoured hexes are visible at all; everything else is just
        // blank background, panable forever with no edge to find.
        if (hex.rumours) this._paintRumourMarker(ctx, center);
        return;
      }

      if (hex.terrain === "coast") {
        this._paintCoastHex(ctx, col, row, center, corners);
      } else {
        ctx.fillStyle = this.terrainColors[hex.terrain] || "#555";
        ctx.fill();
      }

      // Subtle terrain icon, tinted to blend with the fill — a second,
      // colorblind/print-friendly way to tell terrain apart beyond color.
      const terrainIcon = TERRAIN_ICONS[hex.terrain];
      if (terrainIcon) {
        ctx.save();
        ctx.font = `${this.size * 0.85}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "rgba(0,0,0,0.22)";
        ctx.fillText(terrainIcon, center.x, center.y);
        ctx.restore();
      }

      // "Unknown" is a real, selectable terrain — not fog of war — for
      // building the map live at the table: mark a hex revealed as the
      // party enters it, leave terrain as unknown until you and the
      // players decide what's actually there. A light hatch distinguishes
      // it from both real terrain (solid fill) and fog (opaque near-black).
      if (hex.terrain === "unknown") {
        this._paintFogHatch(ctx, corners, center, "rgba(255,255,255,0.3)");
      }

      // GM-only overlay: tint + hatch to flag hexes hidden from players,
      // without hiding the GM's own view of the true terrain.
      if (!this.opts.respectFog && !revealed) {
        ctx.save();
        ctx.clip();
        ctx.fillStyle = "rgba(10, 12, 16, 0.45)";
        ctx.fill();
        this._paintFogHatch(ctx, corners, center, "rgba(255,255,255,0.18)");
        ctx.restore();
        if (hex.rumours) this._paintRumourMarker(ctx, center);
      }

      ctx.lineWidth = 0.6;
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.stroke();

      // Marker for hexes with a point of interest, using an icon for the
      // category instead of a plain dot. A name on its own doesn't earn a
      // marker — most hexes don't need a name at all; it's the POI
      // category that flags a hex as worth marking. A "major" location's
      // name never renders as map text (see _drawDynamicOverlay), so its
      // marker is made a bit bigger with a gold ring instead — something
      // recognizable at a glance, without needing to zoom in or click to
      // know it's important. A "minor" location keeps the plain marker;
      // its name still surfaces on hover/select.
      if (hex.poi) {
        const isMajor = hex.locationTier !== "minor";
        const r = this.size * (isMajor ? 0.27 : 0.22);
        const icon = POI_ICONS[hex.poi] || "●";
        ctx.beginPath();
        ctx.arc(center.x, center.y, r, 0, Math.PI * 2);
        ctx.fillStyle = isMajor ? "rgba(40,32,8,0.9)" : "rgba(20,20,20,0.85)";
        ctx.fill();
        ctx.strokeStyle = isMajor ? "#e2c94a" : "#fff";
        ctx.lineWidth = isMajor ? 1.6 : 0.6;
        ctx.stroke();
        ctx.font = `${r * 1.3}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = isMajor ? "#e2c94a" : "#fff";
        ctx.fillText(icon, center.x, center.y + r * 0.05);
      }
    }

    // Small marker on a fogged hex that has rumour text recorded, so
    // there's a visible hint (for GM and — since rumours are exempt from
    // fog of war — for players too) that this unexplored hex has
    // something to read.
    _paintRumourMarker(ctx, center) {
      const r = this.size * 0.16;
      ctx.save();
      ctx.beginPath();
      ctx.arc(center.x, center.y, r, 0, Math.PI * 2);
      ctx.fillStyle = "#e2c94a";
      ctx.fill();
      ctx.strokeStyle = "#1c2128";
      ctx.lineWidth = 0.6;
      ctx.stroke();
      ctx.font = `bold ${r * 1.3}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#1c2128";
      ctx.fillText("?", center.x, center.y + r * 0.05);
      ctx.restore();
    }

    _paintFogHatch(ctx, corners, center, strokeStyle) {
      ctx.save();
      ctx.beginPath();
      corners.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.clip();

      const xs = corners.map((p) => p.x);
      const ys = corners.map((p) => p.y);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minY = Math.min(...ys), maxY = Math.max(...ys);

      ctx.strokeStyle = strokeStyle || "rgba(255,255,255,0.06)";
      ctx.lineWidth = 0.6;
      const step = Math.max(2, this.size * 0.35);
      for (let x = minX - (maxY - minY); x < maxX; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, minY);
        ctx.lineTo(x + (maxY - minY), maxY);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Cheap per-frame work drawn live on top of the blitted bitmap: the
    // hover/selection outline, and — only when zoomed in enough to read
    // them — coordinate/name labels for the (small) set of visible hexes.
    _drawDynamicOverlay() {
      const ctx = this.ctx;
      const showLabels = this.scale > 1.6;
      this._ensureEntityIndex();
      const hasEntities = Object.keys(this._entityIndex).length > 0;

      const hoverHex = this._keyToColRow(this.hoverKey);
      const needsHighlight = this.selected || hoverHex;

      if (!showLabels && !needsHighlight && !hasEntities) return;

      const s = this.size;
      const topLeft = this.screenToWorld(0, 0);
      const bottomRight = this.screenToWorld(this.cssWidth, this.cssHeight);
      const colMin = Math.max(0, Math.floor(topLeft.x / (s * 1.5)) - 1);
      const colMax = Math.min(this.cols - 1, Math.ceil(bottomRight.x / (s * 1.5)) + 1);
      const rowMin = Math.max(0, Math.floor(topLeft.y / (s * SQRT3)) - 1);
      const rowMax = Math.min(this.rows - 1, Math.ceil(bottomRight.y / (s * SQRT3)) + 1);

      for (let col = colMin; col <= colMax; col++) {
        for (let row = rowMin; row <= rowMax; row++) {
          const key = this.hexKey(col, row);
          const isSelected = this.selected && this.selected.col === col && this.selected.row === row;
          const isHover = this.hoverKey === key;
          const hexEntityIds = this._entityIndex[key];
          if (!isSelected && !isHover && !showLabels && !hexEntityIds) continue;

          const hex = this.getHex(col, row);
          if (!hex) continue;
          const revealed = hex.revealed !== false;
          const hideFromViewer = this.opts.respectFog && !revealed;

          const center = this.hexCenter(col, row);
          const screen = this.worldToScreen(center.x, center.y);

          const screenCorners =
            isSelected || isHover || (showLabels && !hideFromViewer)
              ? this.hexCorners(center.x, center.y).map((p) => this.worldToScreen(p.x, p.y))
              : null;

          // Skip the hover/selection outline on a hex that isn't otherwise
          // drawn at all (public build, unrevealed, no rumour) — an
          // outline appearing under the cursor over "empty" space would
          // itself reveal the hex grid out there, undermining the point of
          // not painting it in the first place.
          if ((isSelected || isHover) && (!hideFromViewer || hex.rumours)) {
            ctx.beginPath();
            screenCorners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
            ctx.closePath();
            ctx.lineWidth = isSelected ? 3 : 1.5;
            ctx.strokeStyle = isSelected ? "#ffdd55" : "#ffffff";
            ctx.stroke();
          }

          // Coordinates are only shown for the one hex under the cursor or
          // selected, not every hex in view — labeling all of them at once
          // was the main source of clutter/overlap between neighbors.
          if ((isSelected || isHover) && !hideFromViewer) {
            this._fillHaloText(
              ctx,
              `${col},${row}`,
              screen.x,
              screen.y - s * this.scale * 0.5,
              `${Math.min(16, Math.max(8, 9 * this.scale))}px sans-serif`,
              "rgba(0,0,0,0.8)"
            );
          }

          // A location's name (major or minor alike) only ever shows as
          // map text once you've actually selected or hovered that hex —
          // otherwise every named hex in view would clutter the map at
          // once. That part is the same for both tiers. What differs is
          // the passive, un-selected state: a "major" location also gets a
          // visually distinct icon (see _paintHex) so it reads as a
          // landmark at a glance without being clicked, while a "minor"
          // location's icon is the plain marker and its name is only ever
          // available by selecting/hovering it.
          const highlighted = isSelected || isHover;
          const showName = hex.poi && !hideFromViewer && highlighted;
          const showPopulation = showLabels && !hideFromViewer && hex.population !== undefined && hex.population !== null;

          if (showName || showPopulation) {
            // Text used to be geometrically clipped to the hex's own
            // outline to stop a long name bleeding into a neighbor — but
            // that clip cut straight through the bottom of the letters
            // themselves, so the name looked like it was vanishing under
            // the hex below it. Horizontal bleed is kept in check instead
            // by truncating text wider than the hex, and the halo behind
            // it keeps it legible over whatever it ends up sitting near.
            // The hex's on-screen footprint (and so the room available for
            // its name) keeps growing the further in you zoom — but the
            // font size used to grow right along with it, uncapped, so the
            // number of characters that actually fit never improved no
            // matter how far you zoomed in. Capping the font size here
            // means maxWidth keeps outpacing it at high zoom, so zooming
            // in on a long name now actually reveals more of it, the way
            // you'd expect.
            const maxWidth = s * this.scale * 1.7;
            let lineY = screen.y + s * this.scale * 0.55;
            if (showName) {
              const nameFont = `bold ${Math.min(20, Math.max(9, 10 * this.scale))}px sans-serif`;
              this._fillHaloText(
                ctx,
                this._truncateToWidth(ctx, hex.name || hex.poi, nameFont, maxWidth),
                screen.x,
                lineY,
                nameFont,
                "#111"
              );
              lineY += s * this.scale * 0.42;
            }

            if (showPopulation) {
              this._fillHaloText(
                ctx,
                hex.population === 0 ? "Uninhabited" : `Pop ${hex.population}`,
                screen.x,
                lineY,
                `${Math.min(16, Math.max(8, 8.5 * this.scale))}px sans-serif`,
                "rgba(0,0,0,0.8)"
              );
            }
          }

          if (hexEntityIds && !hideFromViewer) {
            this._drawEntityMarkers(ctx, hexEntityIds, screen);
          }
        }
      }
    }

    _drawEntityMarkers(ctx, entityIds, screen) {
      const shown = entityIds.slice(0, 4);
      const overflow = entityIds.length - shown.length;
      const r = Math.max(4, Math.min(9, 5 + 2 * this.scale));
      const spacing = r * 2.1;
      const totalWidth = (shown.length - 1) * spacing;
      const startX = screen.x - totalWidth / 2;
      const y = screen.y - r * 1.9;

      shown.forEach((id, i) => {
        const e = this.entities[id];
        if (!e) return;
        const style = ENTITY_STYLES[e.type] || ENTITY_STYLES.npc;
        const revealed = e.revealed !== false;
        const x = startX + i * spacing;

        ctx.save();
        if (!this.opts.respectFog && !revealed) {
          // GM-only: fainter + dashed so it's clear players don't know yet.
          ctx.globalAlpha = 0.55;
          ctx.setLineDash([2, 2]);
        }

        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = style.color;
        ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = "#fff";
        ctx.stroke();

        ctx.setLineDash([]);
        ctx.font = `bold ${Math.max(7, r)}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#fff";
        ctx.fillText(style.label, x, y + 0.5);
        ctx.restore();
      });

      if (overflow > 0) {
        ctx.save();
        ctx.font = `bold ${Math.max(7, r - 1)}px sans-serif`;
        ctx.textAlign = "center";
        ctx.fillStyle = "rgba(0,0,0,0.7)";
        ctx.fillText(`+${overflow}`, screen.x + totalWidth / 2 + spacing, y);
        ctx.restore();
      }
    }

    // Renders the whole map — terrain, coasts, roads, rivers, plus every
    // location name, population, and entity marker always shown, not just
    // the ones near the cursor or under the current hover/selection — to a
    // fresh offscreen canvas at `opts.maxDimension` (default 3000px on the
    // long edge), and returns that canvas for the caller to turn into a
    // PNG download. Independent of whatever's currently on screen — pan,
    // zoom, and hover state have no effect on the output, and calling this
    // never mutates or redraws the live map.
    //
    // Fog of war still applies exactly as it does everywhere else: on a
    // `respectFog: true` (public) instance, a hex not yet revealed is
    // skipped the same way _paintHex already skips it (nothing painted
    // unless it has a rumour). On a GM instance nothing is hidden, same as
    // the GM's own live view.
    exportImage(opts) {
      opts = opts || {};
      const targetLongEdge = opts.maxDimension || 3000;
      const b = this.bounds;
      const worldW = Math.max(1, b.maxX - b.minX);
      const worldH = Math.max(1, b.maxY - b.minY);
      const exportScale = targetLongEdge / Math.max(worldW, worldH);

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(worldW * exportScale));
      canvas.height = Math.max(1, Math.round(worldH * exportScale));
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#0d1117";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.save();
      ctx.scale(exportScale, exportScale);
      ctx.translate(-b.minX, -b.minY);

      for (let col = 0; col < this.cols; col++) {
        for (let row = 0; row < this.rows; row++) {
          this._paintHex(ctx, col, row);
        }
      }
      this._paintRoads(ctx);
      this._paintRivers(ctx);
      this._paintExportLabels(ctx);

      ctx.restore();
      return canvas;
    }

    // Always-on version of the name/population/entity-marker overlay that
    // _drawDynamicOverlay only draws for the hovered/selected hex (and only
    // when zoomed in) — an exported image has no cursor and no zoom level,
    // so everything that would ever be visible gets drawn every time. Runs
    // directly in world space (same convention as _paintHex/_renderBitmap):
    // font sizes and marker radii are expressed as fractions of `this.size`
    // rather than screen pixels, so they come out consistently sized
    // regardless of the export canvas's resolution.
    _paintExportLabels(ctx) {
      const s = this.size;
      this._ensureEntityIndex();

      for (let col = 0; col < this.cols; col++) {
        for (let row = 0; row < this.rows; row++) {
          const hex = this.getHex(col, row);
          if (!hex) continue;
          const revealed = hex.revealed !== false;
          const hideFromViewer = this.opts.respectFog && !revealed;
          if (hideFromViewer) continue;

          const center = this.hexCenter(col, row);
          const hasPopulation = hex.population !== undefined && hex.population !== null;

          if (hex.poi || hasPopulation) {
            const maxWidth = s * 1.7;
            let lineY = center.y + s * 0.55;
            if (hex.poi) {
              const nameFont = `bold ${s * 0.32}px sans-serif`;
              this._fillHaloText(
                ctx,
                this._truncateToWidth(ctx, hex.name || hex.poi, nameFont, maxWidth),
                center.x,
                lineY,
                nameFont,
                "#111"
              );
              lineY += s * 0.42;
            }
            if (hasPopulation) {
              this._fillHaloText(
                ctx,
                hex.population === 0 ? "Uninhabited" : `Pop ${hex.population}`,
                center.x,
                lineY,
                `${s * 0.22}px sans-serif`,
                "rgba(0,0,0,0.8)"
              );
            }
          }

          const key = this.hexKey(col, row);
          const hexEntityIds = this._entityIndex[key];
          if (hexEntityIds && hexEntityIds.length) {
            const visibleIds = this.opts.respectFog
              ? hexEntityIds.filter((id) => this.entities[id] && this.entities[id].revealed !== false)
              : hexEntityIds;
            if (visibleIds.length) this._paintExportEntityMarkers(ctx, visibleIds, center);
          }
        }
      }
    }

    // World-space counterpart to _drawEntityMarkers — same layout (up to 4
    // markers in a row above the hex center, "+N" overflow badge), sized in
    // fractions of `this.size` instead of the live view's `this.scale`,
    // since export has no zoom level of its own.
    _paintExportEntityMarkers(ctx, entityIds, center) {
      const shown = entityIds.slice(0, 4);
      const overflow = entityIds.length - shown.length;
      const s = this.size;
      const r = s * 0.22;
      const spacing = r * 2.1;
      const totalWidth = (shown.length - 1) * spacing;
      const startX = center.x - totalWidth / 2;
      const y = center.y - r * 1.9;

      shown.forEach((id, i) => {
        const e = this.entities[id];
        if (!e) return;
        const style = ENTITY_STYLES[e.type] || ENTITY_STYLES.npc;
        const x = startX + i * spacing;

        ctx.save();
        if (!this.opts.respectFog && e.revealed === false) {
          // GM-only: fainter, so it's clear at a glance the players don't
          // know about this one yet — same convention as the live map.
          ctx.globalAlpha = 0.55;
          ctx.setLineDash([s * 0.02, s * 0.02]);
        }
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = style.color;
        ctx.fill();
        ctx.lineWidth = s * 0.025;
        ctx.strokeStyle = "#fff";
        ctx.stroke();

        ctx.setLineDash([]);
        ctx.font = `bold ${Math.max(s * 0.14, r * 0.9)}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#fff";
        ctx.fillText(style.label, x, y + s * 0.01);
        ctx.restore();
      });

      if (overflow > 0) {
        ctx.save();
        ctx.font = `bold ${r * 0.85}px sans-serif`;
        ctx.textAlign = "center";
        ctx.fillStyle = "rgba(0,0,0,0.7)";
        ctx.fillText(`+${overflow}`, center.x + totalWidth / 2 + spacing, y);
        ctx.restore();
      }
    }

    _keyToColRow(key) {
      if (!key) return null;
      const [col, row] = key.split(",").map(Number);
      return { col, row };
    }

    // Text with a light halo stroked behind it, so a label stays legible
    // over any terrain color and reads as clearly belonging to its own hex
    // rather than blurring into a neighboring hex's label sitting nearby.
    _fillHaloText(ctx, text, x, y, font, fillStyle) {
      ctx.save();
      ctx.font = font;
      ctx.textAlign = "center";
      ctx.lineJoin = "round";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.strokeText(text, x, y);
      ctx.fillStyle = fillStyle;
      ctx.fillText(text, x, y);
      ctx.restore();
    }

    // Shortens text with a trailing "…" if it would render wider than
    // maxWidth, so an unusually long name is bounded horizontally without
    // resorting to a hard geometric clip (which chops through the middle
    // of letters rather than just shortening the word).
    _truncateToWidth(ctx, text, font, maxWidth) {
      ctx.save();
      ctx.font = font;
      const full = ctx.measureText(text);
      if (!full || full.width <= maxWidth) {
        ctx.restore();
        return text;
      }
      let lo = 0,
        hi = text.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const candidate = text.slice(0, mid) + "…";
        if (ctx.measureText(candidate).width <= maxWidth) lo = mid;
        else hi = mid - 1;
      }
      ctx.restore();
      return lo > 0 ? text.slice(0, lo) + "…" : "…";
    }

    // ---- interaction ----

    _bindEvents() {
      let dragging = false;
      let lastX = 0,
        lastY = 0;
      let moved = false;

      this.canvas.addEventListener("mousedown", (e) => {
        dragging = true;
        moved = false;
        lastX = e.clientX;
        lastY = e.clientY;
      });

      window.addEventListener("mouseup", () => {
        dragging = false;
      });

      this.canvas.addEventListener("mousemove", (e) => {
        const rect = this.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        if (dragging) {
          const dx = e.clientX - lastX;
          const dy = e.clientY - lastY;
          if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
          this.offsetX += dx;
          this.offsetY += dy;
          lastX = e.clientX;
          lastY = e.clientY;
          this.scheduleDraw();
        } else {
          const hit = this.pixelToHex(mx, my);
          const key = hit ? this.hexKey(hit.col, hit.row) : null;
          if (key !== this.hoverKey) {
            this.hoverKey = key;
            this.scheduleDraw();
          }
        }
      });

      this.canvas.addEventListener("mouseleave", () => {
        this.hoverKey = null;
        this.scheduleDraw();
      });

      this.canvas.addEventListener("click", (e) => {
        if (moved) return; // was a drag, not a click
        const rect = this.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const hit = this.pixelToHex(mx, my);

        if (this._placement) {
          const { id, onPlaced } = this._placement;
          this._placement = null;
          this.canvas.style.cursor = "";
          if (hit) onPlaced(hit);
          return;
        }

        this.selected = hit;
        this.scheduleDraw();
        if (this.opts.onSelect) this.opts.onSelect(hit);
      });

      window.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && this._placement) this.cancelPlacement();
      });

      this.canvas.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          const rect = this.canvas.getBoundingClientRect();
          const mx = e.clientX - rect.left;
          const my = e.clientY - rect.top;
          const before = this.screenToWorld(mx, my);

          const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
          this.scale = Math.min(4, Math.max(0.25, this.scale * factor));

          const after = this.worldToScreen(before.x, before.y);
          this.offsetX += mx - after.x;
          this.offsetY += my - after.y;
          this.scheduleDraw();
        },
        { passive: false }
      );

      // touch support: one finger pans/taps, two fingers pinch-zoom. Both
      // call preventDefault() (and the canvas has touch-action: none in
      // CSS) so the browser's own pinch-to-zoom/scroll never takes over —
      // without that, a pinch zooms the whole page instead of the map,
      // taking fixed-position UI like the toolbar along with it.
      let touchStart = null;
      let pinch = null;

      const touchDist = (t0, t1) => Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      const touchMid = (t0, t1) => ({ x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 });

      this.canvas.addEventListener(
        "touchstart",
        (e) => {
          if (e.touches.length === 1) {
            touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, moved: false };
            pinch = null;
          } else if (e.touches.length === 2) {
            touchStart = null;
            const rect = this.canvas.getBoundingClientRect();
            const mid = touchMid(e.touches[0], e.touches[1]);
            pinch = {
              startDist: touchDist(e.touches[0], e.touches[1]) || 1,
              startScale: this.scale,
              worldMid: this.screenToWorld(mid.x - rect.left, mid.y - rect.top),
            };
          }
        },
        { passive: false }
      );
      this.canvas.addEventListener(
        "touchmove",
        (e) => {
          if (e.touches.length === 2 && pinch) {
            e.preventDefault();
            const rect = this.canvas.getBoundingClientRect();
            const dist = touchDist(e.touches[0], e.touches[1]);
            const mid = touchMid(e.touches[0], e.touches[1]);
            this.scale = Math.min(4, Math.max(0.25, pinch.startScale * (dist / pinch.startDist)));
            const screenMid = { x: mid.x - rect.left, y: mid.y - rect.top };
            const after = this.worldToScreen(pinch.worldMid.x, pinch.worldMid.y);
            this.offsetX += screenMid.x - after.x;
            this.offsetY += screenMid.y - after.y;
            this.scheduleDraw();
          } else if (touchStart && e.touches.length === 1) {
            e.preventDefault();
            const dx = e.touches[0].clientX - touchStart.x;
            const dy = e.touches[0].clientY - touchStart.y;
            if (Math.abs(dx) > 2 || Math.abs(dy) > 2) touchStart.moved = true;
            this.offsetX += dx;
            this.offsetY += dy;
            touchStart.x = e.touches[0].clientX;
            touchStart.y = e.touches[0].clientY;
            this.scheduleDraw();
          }
        },
        { passive: false }
      );
      this.canvas.addEventListener("touchend", (e) => {
        if (e.touches.length === 0) {
          pinch = null;
          if (touchStart && !touchStart.moved) {
            const rect = this.canvas.getBoundingClientRect();
            const mx = touchStart.x - rect.left;
            const my = touchStart.y - rect.top;
            const hit = this.pixelToHex(mx, my);
            this.selected = hit;
            this.scheduleDraw();
            if (this.opts.onSelect) this.opts.onSelect(hit);
          }
          touchStart = null;
        } else if (e.touches.length === 1) {
          // Lifted one of two fingers — resume single-finger panning from
          // here rather than treating this moment as a tap.
          pinch = null;
          touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, moved: true };
        }
      });
    }

    centerOn(col, row) {
      const c = this.hexCenter(col, row);
      this.offsetX = this.cssWidth / 2 - c.x * this.scale;
      this.offsetY = this.cssHeight / 2 - c.y * this.scale;
      this.draw();
    }

    selectHex(col, row) {
      this.selected = { col, row };
      this.centerOn(col, row);
      if (this.opts.onSelect) this.opts.onSelect(this.selected);
    }
  }

  // Exposed statically so index.html can reuse the same icon set for the
  // legend / entity directory instead of duplicating the mapping.
  HexMap.TERRAIN_ICONS = TERRAIN_ICONS;
  HexMap.POI_ICONS = POI_ICONS;
  HexMap.ENTITY_STYLES = ENTITY_STYLES;

  global.HexMap = HexMap;
})(window);
