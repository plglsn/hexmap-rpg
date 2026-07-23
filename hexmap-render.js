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

      // Cheap cached flag: does any hex have a "major" named location? Used
      // to decide whether the dynamic overlay pass can bail out early when
      // zoomed out with nothing selected/hovered — without it, a major
      // location's name would only ever get a chance to render once the
      // view happened to already be zoomed in or something else forced a
      // pass over the hexes.
      this._hasMajorNamed = false;
      this._namedFlagDirty = true;

      // Rivers — a named path of adjacent hex keys, drawn as a line across
      // the hexes it crosses (independent of each hex's own terrain).
      // { id: { name, notes, secret, path: ["col,row", ...] } }
      this.data.rivers = this.data.rivers || {};

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
      this._namedFlagDirty = true;
    }

    /** Call after mutating this.data directly (e.g. bulk reveal/hide, import). */
    invalidate() {
      this._bitmapDirty = true;
      this._entityIndexDirty = true;
      this._namedFlagDirty = true;
    }

    _ensureMajorNamedFlag() {
      if (!this._namedFlagDirty) return;
      this._hasMajorNamed = Object.values(this.data.hexes).some(
        (h) => h && h.poi && h.locationTier !== "minor"
      );
      this._namedFlagDirty = false;
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
        { name: "", notes: "", secret: "", path: [] },
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

      this._paintRivers(bctx);

      bctx.restore();
      this._bitmapDirty = false;
    }

    // One hex-center-to-hex-center segment of a river, on top of terrain.
    // Visibility is decided by the two endpoint hexes' revealed state — a
    // river crossing from explored into unexplored territory just fades
    // out at the boundary instead of leaking the unexplored portion's
    // shape.
    _paintRiverSegment(ctx, keyA, keyB) {
      const a = this._keyToColRow(keyA);
      const b = this._keyToColRow(keyB);
      if (!a || !b) return;
      const hexA = this.getHex(a.col, a.row);
      const hexB = this.getHex(b.col, b.row);
      if (!hexA || !hexB) return;
      const revealedA = hexA.revealed !== false;
      const revealedB = hexB.revealed !== false;
      if (this.opts.respectFog && (!revealedA || !revealedB)) return;

      const centerA = this.hexCenter(a.col, a.row);
      const centerB = this.hexCenter(b.col, b.row);

      ctx.save();
      if (!this.opts.respectFog && (!revealedA || !revealedB)) {
        // GM-only: fainter + dashed to flag it crosses fogged ground.
        ctx.globalAlpha = 0.5;
        ctx.setLineDash([this.size * 0.18, this.size * 0.12]);
      }
      ctx.strokeStyle = "#4fa3d1";
      ctx.lineWidth = Math.max(1.5, this.size * 0.16);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(centerA.x, centerA.y);
      ctx.lineTo(centerB.x, centerB.y);
      ctx.stroke();
      ctx.restore();
    }

    // Rivers are drawn as chains of _paintRiverSegment() calls, one
    // river-length pass after all hex fills are painted. On top of each
    // river's own path, an end that borders open water (ocean/coast/lake)
    // or another river's end gets an extra connecting segment out to that
    // neighboring hex — so a river visibly flows into the sea or joins a
    // tributary without the GM having to click that hex into its own path.
    _paintRivers(ctx) {
      const rivers = this.data.rivers || {};
      const ids = Object.keys(rivers);
      const WATER_TERRAINS = { ocean: true, coast: true, lake: true };

      // hexKey -> set of river ids that start or end there, so a
      // neighboring river's end can be found in O(1) instead of rescanning
      // every other river for every endpoint.
      const endpointOwners = {};
      ids.forEach((id) => {
        const path = rivers[id].path || [];
        if (!path.length) return;
        [path[0], path[path.length - 1]].forEach((key) => {
          (endpointOwners[key] = endpointOwners[key] || new Set()).add(id);
        });
      });

      const drawnConnections = new Set(); // dedupe shared endpoint<->neighbor pairs

      ids.forEach((id) => {
        const path = rivers[id].path || [];
        for (let i = 0; i < path.length - 1; i++) {
          this._paintRiverSegment(ctx, path[i], path[i + 1]);
        }
        if (!path.length) return;

        const endpoints = path.length > 1 ? [path[0], path[path.length - 1]] : [path[0]];
        endpoints.forEach((key) => {
          const pos = this._keyToColRow(key);
          if (!pos) return;
          this.neighbors(pos.col, pos.row).forEach((n) => {
            const nKey = this.hexKey(n.col, n.row);
            if (path.indexOf(nKey) !== -1) return; // already part of this river's own path

            const nHex = this.getHex(n.col, n.row);
            const isWater = !!(nHex && WATER_TERRAINS[nHex.terrain]);
            const otherRiverHere =
              endpointOwners[nKey] && Array.from(endpointOwners[nKey]).some((otherId) => otherId !== id);
            if (!isWater && !otherRiverHere) return;

            const dedupeKey = [key, nKey].sort().join("|");
            if (drawnConnections.has(dedupeKey)) return;
            drawnConnections.add(dedupeKey);
            this._paintRiverSegment(ctx, key, nKey);
          });
        });
      });
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

      ctx.fillStyle = this.terrainColors[hex.terrain] || "#555";
      ctx.fill();

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
      // category that flags a hex as worth marking.
      if (hex.poi) {
        const r = this.size * 0.22;
        const icon = POI_ICONS[hex.poi] || "●";
        ctx.beginPath();
        ctx.arc(center.x, center.y, r, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(20,20,20,0.85)";
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 0.6;
        ctx.stroke();
        ctx.font = `${r * 1.3}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#fff";
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
      this._ensureMajorNamedFlag();
      const hasEntities = Object.keys(this._entityIndex).length > 0;

      const hoverHex = this._keyToColRow(this.hoverKey);
      const needsHighlight = this.selected || hoverHex;

      if (!showLabels && !needsHighlight && !hasEntities && !this._hasMajorNamed) return;

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

          const hex = this.getHex(col, row);
          if (!hex) continue;
          // A "major" named location is drawn regardless of zoom level —
          // that's the whole point of the tier (see below) — so it needs
          // to opt back into the per-hex loop even when everything else
          // says "skip, nothing to draw here."
          const isMajorNamed = hex.poi && hex.locationTier !== "minor";
          if (!isSelected && !isHover && !showLabels && !hexEntityIds && !isMajorNamed) continue;

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
              `${Math.max(8, 9 * this.scale)}px sans-serif`,
              "rgba(0,0,0,0.8)"
            );
          }

          // A "major" location's name is meant to be a landmark you can
          // always read at a glance, so it shows regardless of zoom level.
          // A "minor" location's name would otherwise clutter the map with
          // every little village at once, so it only appears once you've
          // actually selected or hovered that hex.
          const highlighted = isSelected || isHover;
          const isMinor = hex.locationTier === "minor";
          const showName = hex.poi && !hideFromViewer && (!isMinor || highlighted);
          const showPopulation = showLabels && !hideFromViewer && hex.population !== undefined && hex.population !== null;

          if (showName || showPopulation) {
            // Text used to be geometrically clipped to the hex's own
            // outline to stop a long name bleeding into a neighbor — but
            // that clip cut straight through the bottom of the letters
            // themselves, so the name looked like it was vanishing under
            // the hex below it. Horizontal bleed is kept in check instead
            // by truncating text wider than the hex, and the halo behind
            // it keeps it legible over whatever it ends up sitting near.
            const maxWidth = s * this.scale * 1.7;
            let lineY = screen.y + s * this.scale * 0.55;
            if (showName) {
              const nameFont = `bold ${Math.max(9, 10 * this.scale)}px sans-serif`;
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
                `${Math.max(8, 8.5 * this.scale)}px sans-serif`,
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
