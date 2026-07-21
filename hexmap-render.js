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
    desert: "☰", // dunes (trigram for heaven)
    arctic: "✳", // eight-spoked asterisk — frost
    swamp: "☵", // broken bars (trigram for water) — murky wetland
    grassland: "ψ", // psi — a tuft of grass
    forest: "♣", // club — tree canopy
    jungle: "♧", // white club — denser canopy
    river: "∿", // sine wave — flowing water
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

      bctx.restore();
      this._bitmapDirty = false;
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
        ctx.fillStyle = "#1c2128";
        ctx.fill();
        this._paintFogHatch(ctx, corners, center);
        ctx.lineWidth = 0.6;
        ctx.strokeStyle = "rgba(0,0,0,0.45)";
        ctx.stroke();
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

          if (isSelected || isHover) {
            const corners = this.hexCorners(center.x, center.y).map((p) => this.worldToScreen(p.x, p.y));
            ctx.beginPath();
            corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
            ctx.closePath();
            ctx.lineWidth = isSelected ? 3 : 1.5;
            ctx.strokeStyle = isSelected ? "#ffdd55" : "#ffffff";
            ctx.stroke();
          }

          if (showLabels && !hideFromViewer) {
            ctx.font = `${Math.max(8, 9 * this.scale)}px sans-serif`;
            ctx.fillStyle = "rgba(0,0,0,0.55)";
            ctx.textAlign = "center";
            ctx.fillText(`${col},${row}`, screen.x, screen.y - s * this.scale * 0.5);

            // A name only gets shown alongside a point of interest — a
            // POI with no custom name yet just falls back to its category
            // ("Ruins") so the map isn't blank for it.
            let lineY = screen.y + s * this.scale * 0.7;
            if (hex.poi) {
              ctx.font = `bold ${Math.max(9, 10 * this.scale)}px sans-serif`;
              ctx.fillStyle = "#111";
              ctx.fillText(hex.name || hex.poi, screen.x, lineY);
              lineY += s * this.scale * 0.42;
            }

            // Population is independent of name/POI — even a plain,
            // unnamed hex can carry a small population figure.
            if (hex.population !== undefined && hex.population !== null) {
              ctx.font = `${Math.max(8, 8.5 * this.scale)}px sans-serif`;
              ctx.fillStyle = "rgba(0,0,0,0.7)";
              ctx.fillText(
                hex.population === 0 ? "Uninhabited" : `Pop ${hex.population}`,
                screen.x,
                lineY
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

      // touch support (basic pan + tap)
      let touchStart = null;
      this.canvas.addEventListener("touchstart", (e) => {
        if (e.touches.length === 1) {
          touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, moved: false };
        }
      });
      this.canvas.addEventListener("touchmove", (e) => {
        if (touchStart && e.touches.length === 1) {
          const dx = e.touches[0].clientX - touchStart.x;
          const dy = e.touches[0].clientY - touchStart.y;
          if (Math.abs(dx) > 2 || Math.abs(dy) > 2) touchStart.moved = true;
          this.offsetX += dx;
          this.offsetY += dy;
          touchStart.x = e.touches[0].clientX;
          touchStart.y = e.touches[0].clientY;
          this.scheduleDraw();
        }
      });
      this.canvas.addEventListener("touchend", (e) => {
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
