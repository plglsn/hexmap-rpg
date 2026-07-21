# Hexcrawl Map

A 50×50 flat-top hexcrawl map (odd-q offset columns, flat edge on top/bottom)
rendered on a single `<canvas>`. Pan by dragging, zoom with the scroll wheel,
click a hex to see its details in the sidebar.

There are two builds:

- **`gm/`** — full map with an in-page editor. Every hex has a hidden
  "GM secret" field only this build can see or edit. Run this locally.
- **`public/`** — read-only viewer. Its `data.js` is generated from the same
  source but with every `secret` field stripped out entirely (not hidden by
  CSS — the data simply isn't there). Safe to publish online.

### Icons

Terrain, points of interest, and NPC/event/location pins all get a small
icon, drawn as plain Unicode symbols (not color emoji) so they render as a
single flat color everywhere, entirely offline, with no image files or font
dependency beyond a normal system sans-serif:

- Terrain gets a subtle, low-opacity watermark icon on top of its color
  (▲ mountain, ♣ forest, ≋ ocean, etc.) — a second way to tell terrain apart
  that doesn't rely on color alone.
- A point-of-interest hex gets its category's icon instead of a plain dot
  (⌂ Settlement, ☠ Dungeon, ♜ Fortress, † Shrine, and so on).
- NPC/event/location pins use ♟ / ‼ / ⚑ instead of letters.

The full icon set is in `TERRAIN_ICONS` / `POI_ICONS` / `ENTITY_STYLES` near
the top of `src/hexmap-render.js` if you want to swap any of them for
different symbols.

### Building the map live, at the table

`unknown` is a real terrain type (not fog of war) meant for generating the
map collaboratively as you play, instead of pre-deciding every hex up front.
Mark a hex revealed as the party enters it, leave its terrain as `unknown`,
then decide terrain together at the table and update it in the GM editor.
An `unknown` hex renders with a light hatch over its (gray) fill so it
reads clearly as "not decided yet," distinct from both real terrain (solid
color) and fog of war (opaque near-black).

To start a campaign this way, click **Set all to Unknown** in the GM
toolbar — it resets every hex's terrain in one go without touching names,
notes, reveal state, or entities, so you can begin from a blank slate.

### Fog of war

Every hex has a `revealed` flag. In the GM build, unrevealed hexes still show
their real terrain to you, just with a hatched overlay so you can see at a
glance what players haven't found yet. In the public build, unrevealed hexes
are rendered as solid fog — `build.py` strips their terrain, name, notes,
population, and point of interest out of `public/data.js` entirely, so
there's nothing in the page's source for a curious player to peek at.

To reveal a hex: click it in the GM build and check **Revealed to players**
in the sidebar (saves instantly). Use **Reveal all** / **Hide all** in the
toolbar for bulk changes. Then run `python3 build.py` to push the change to
the public build.

### Rumours

Every hex also has a **Rumours** field — the one deliberate exception to fog
of war. Use it for things NPCs have told the party about land they haven't
explored yet ("a trapper says lantern-light flickers atop the old tower some
nights"). Unlike terrain/name/notes, rumours ship to the public build
regardless of whether the hex is revealed, and work on already-explored
hexes too (handy for showing what the party *heard* before they arrived,
next to what they actually found). A gold "?" marker appears on fogged
hexes that have a rumour recorded, so players know there's something to
read even before they've been there.

### Population & point of interest

Most hexes are just terrain — no name needed. A hex only gets a **name**
once it has a **point of interest**: a category picked from a dropdown
(`Settlement`, `Ruins`, `Dungeon`, `Shrine`, `Landmark`, `Fortress`,
`Camp or Lair`, `Natural Wonder`, `Other` — edit the list under `poiTypes`
in `data.json` if you want different categories). Pick "— none —" in the GM
editor and the Name field disappears; the map only shows a marker and label
for hexes that have a POI. If a POI hex has no custom name yet, the map
falls back to showing its category ("Ruins") instead of leaving it blank.

**Population** is a separate, optional number — it's omitted from the data
entirely unless you set it (including for a settlement with population 0,
which is treated as "confirmed uninhabited" rather than "not tracked").
Population doesn't require a POI or a name; a plain hex can carry a small
population figure on its own (e.g. a nomadic camp you haven't bothered
naming), and it shows up as its own small line when zoomed in.

Both fields follow normal fog-of-war rules — hidden along with terrain/name/
notes until the hex is revealed and `build.py` has been re-run.

### NPCs, events & locations

Hexes hold static, per-tile info (terrain, a name, notes). For anything that
should be trackable separately from a specific hex — an NPC who travels, a
seasonal event, a point of interest you might relocate — use **entities**
instead. They live in `data.json` under `"entities"`, each with a `type`
(`npc`, `event`, or `location`), name, public notes, a GM secret, a `hex` it's
currently placed on (or `null` if unplaced), and its own `revealed` flag.

On the map, entities show up as small colored pins clustered near their hex
(blue **N** = NPC, orange **E** = event, purple **L** = location).

In the GM build:

- Click a hex to see the entities there, in the sidebar's **Entities here**
  section, alongside **+ NPC** / **+ Event** / **+ Location** buttons to add
  a new one on that hex.
- Click **NPCs & Events** in the toolbar for a searchable directory of every
  entity, including ones not currently placed anywhere.
- Each entity has **Move…** (or **Place on map…** if unplaced) — click it,
  then click the hex you want to move it to (Esc cancels). This is the "move
  as required" workflow: reassign an NPC's hex any time without touching the
  hex's own data.
- An entity only reaches the public build if **both** its own "Revealed to
  players" box is checked **and** the hex it's sitting on is revealed —
  otherwise you'd leak the existence of an unexplored hex through the NPC
  pinned to it.

In the public build, entities are read-only: click a hex to see who/what is
there, or use **NPCs & Locations** in the toolbar to browse everything your
players have discovered so far, with a name search and click-to-jump.

## Viewing locally

No server required. Just open the file directly:

```
gm/index.html
```

Double-click it, or drag it into a browser window. Works fully offline.

If you'd rather use a local server (optional, e.g. to test with the same
setup you'd use online):

```
cd hexmap-rpg
python3 -m http.server 8000
# then visit http://localhost:8000/gm/
```

## Editing hexes

1. Open `gm/index.html`.
2. Click any hex. The sidebar shows Terrain, Name, Public notes, and GM
   secret fields.
3. Edit and click **Save hex**. Changes are kept in your browser's
   `localStorage`, so they survive reloads on the same machine/browser.
4. When you're happy with your changes, click **Export data.json** in the
   toolbar. This downloads the full data set (including secrets). Save it
   over the `data.json` file at the project root.
5. Run the build script to regenerate both `gm/data.js` and the
   secret-stripped `public/data.js`:

   ```
   python3 build.py
   ```

`data.json` at the project root is the master file — treat it like a secret
file (don't upload it, don't commit it to a public repo). Everything under
`gm/` and `public/` is generated from it by `build.py`, except the two
`index.html` files, which you can edit directly if you want to change layout
or add features.

You can also click **Import…** in the GM toolbar to load a `data.json` file
back in (useful for restoring a backup or moving between machines).

## Publishing the public version online

Upload only the **`public/`** folder to any static host — GitHub Pages,
Netlify, Cloudflare Pages, a plain S3 bucket, etc. It is fully self-contained
(`index.html`, `hexmap.css`, `hexmap-render.js`, `data.js`) and contains no
GM secrets. Never upload `data.json` or the `gm/` folder anywhere public.

### GitHub Pages, kept in sync by build.py

`build.py --deploy` rebuilds `public/` and pushes just that folder to a
`gh-pages` branch with `git subtree push` — no separate repo, no manual
copying. `.gitignore` excludes `data.json` and `gm/data.js` (the only two
files that ever contain secrets), so even though the rest of the project
gets committed alongside `public/`, nothing sensitive can reach GitHub —
you could make the repo fully public and nothing would leak.

**One-time setup** (run in this folder, in a normal terminal — not needed
again after this):

```
git init
git add -A
git commit -m "Initial commit"
```

Then create an empty repository on GitHub (github.com → New repository —
public, no README/license) and connect it:

```
git remote add origin https://github.com/<you>/<repo>.git
python3 build.py --deploy
```

The first `--deploy` creates the `gh-pages` branch on GitHub. Turn Pages on
once: repo **Settings → Pages → Source: Deploy from a branch**, branch
`gh-pages`, folder `/ (root)`. Your map will be live at
`https://<you>.github.io/<repo>/` within a minute or two.

From then on, whenever you've updated `data.json` (revealed hexes, moved an
NPC, whatever), just run:

```
python3 build.py --deploy
```

and the live site updates. If it ever complains about a stuck
`.git/index.lock` file, delete that one file and try again — it's safe, it
just means a previous git command didn't exit cleanly.

## Map data format (`data.json`)

```json
{
  "meta": { "cols": 50, "rows": 50, "orientation": "flat-top", "offset": "odd-q", "hexSize": 20 },
  "terrainColors": {
    "desert": "#e0c068", "arctic": "#e8f0f2", "swamp": "#6b7a4f",
    "grassland": "#c9d97a", "forest": "#4f7942", "jungle": "#2f7a4f",
    "river": "#5aa9d6", "coast": "#8fd0d8", "ocean": "#3a6ea8", "mountain": "#8b8680"
  },
  "poiTypes": ["Settlement", "Ruins", "Dungeon", "Shrine", "Landmark", "Fortress", "Camp or Lair", "Natural Wonder", "Other"],
  "hexes": {
    "0,0": { "terrain": "grassland", "notes": "", "secret": "", "rumours": "", "revealed": false },
    "12,8": {
      "terrain": "forest",
      "poi": "Natural Wonder",
      "name": "The Hollow Oak",
      "population": 0,
      "rumours": "Shown to players even if revealed is false. Exempt from fog of war.",
      "notes": "Public-facing description players can see once revealed.",
      "secret": "GM-only info. Stripped out of public/data.js by build.py.",
      "revealed": true
    }
  },
  "entities": {
    "npc_greta": {
      "type": "npc",
      "name": "Greta Ashwood",
      "notes": "Public-facing description.",
      "secret": "GM-only info. Stripped out of public/data.js by build.py.",
      "hex": "2,22",
      "revealed": true
    }
  }
}
```

Hexes are keyed `"col,row"`. To add or change terrain types, edit
`terrainColors` in `data.json` (and re-run `build.py`) — the dropdown in the
GM editor and the legend both read from this object automatically.

Entities are keyed by an arbitrary id (the GM editor generates one when you
create an entity through the UI). Set `"hex": null` for an entity that
exists but isn't currently placed on the map.

## Adjusting map size

Change `meta.cols` / `meta.rows` in `data.json`, make sure every `"col,row"`
key in that range exists in `hexes` (you can regenerate defaults with a
small script similar to the one used to seed this project), then re-run
`build.py`.
