import { MODULE_ID, LAYER_NAME, COLORS, AREA_DEFAULTS, CROSSROAD_DEFAULTS, TRACK_DEFAULTS } from "./constants.js";
import {
  getMap, saveMap, isWonderMap, findNode, rememberedNeighbourhood, visibleLandmarks, branchNumbers, pathNetwork,
  formatMinutes
} from "./data.js";
import { walkTo, crossroadCheck, trackCheck } from "./engine.js";
import { AreaConfig, editCrossroad, editEdgeTime, copyTrackDialog } from "./apps.js";
import { activateLinkedScene } from "./scene-link.js";
import { CanvasMenu } from "./menu.js";

const TAU = Math.PI * 2;

/** Pixels the pointer may travel before a press becomes a drag. */
const DRAG_THRESHOLD = 6;

/**
 * The canvas layer that renders a WonderMap and lets the GM edit it.
 *
 * The scene background is a fixed backdrop that always covers the whole
 * screen and never rotates, pans or zooms. Areas, crossroads and paths are
 * placed at their rotated world positions but are drawn upright, so the area
 * circles never spin.
 */
export class WonderMapsLayer extends InteractionLayer {
  constructor() {
    super();
    /** Current map data, refreshed from the scene flags. */
    this.map = null;
    /** State of an in-progress drag. */
    this._drag = null;
    /** Guards against stale async refreshes. */
    this._refreshId = 0;
    this.menu = new CanvasMenu();
    this._onDragMove = this._onDragMove.bind(this);
    this._onDragEnd = this._onDragEnd.bind(this);
  }

  static get layerOptions() {
    return foundry.utils.mergeObject(super.layerOptions, {
      name: LAYER_NAME,
      // Above the other layers so areas stay clickable (full art) whatever layer
      // is active; below the controls layer (pings, rulers, cursors).
      zIndex: 950
    });
  }

  /** Is the current scene a WonderMap? */
  get enabled() {
    return isWonderMap(canvas.scene);
  }

  /** Is the GM editing (layer active)? */
  get editing() {
    return game.user.isGM && this.active;
  }

  get tool() {
    return ui.controls?.activeTool;
  }

  /* -------------------------------------------- */
  /*  Drawing                                     */
  /* -------------------------------------------- */

  /** @override */
  async _draw(options) {
    await super._draw(options);
    // Rotated content can leave the scene rectangle and must stay clickable.
    this.hitArea = new PIXI.Rectangle(-1e6, -1e6, 2e6, 2e6);
    // Areas are clickable for everybody (to see their art). Core layers start
    // with interactiveChildren = false and only switch it on when activated,
    // which never happens on a player's client.
    this.interactiveChildren = true;

    this.background = this.addChild(new PIXI.Container());
    // Fit the backdrop during the render pass itself, using the exact camera of
    // the frame being drawn. Doing it in a ticker lags one frame behind panning
    // and makes the backdrop shake.
    const layer = this;
    this.background.updateTransform = function() {
      layer._fitBackdrop();
      PIXI.Container.prototype.updateTransform.call(this);
    };
    this.edgesLayer = this.addChild(new PIXI.Container());
    this.crossroadsLayer = this.addChild(new PIXI.Container());
    // Arrows sit under the areas: only the part poking out of the circle shows.
    this.arrowsLayer = this.addChild(new PIXI.Container());
    this.branchesLayer = this.addChild(new PIXI.Container());
    this.areasLayer = this.addChild(new PIXI.Container());
    // Labels that keep the same size on screen at any zoom (travel times).
    this.labelsLayer = this.addChild(new PIXI.Container());
    this.labelsLayer.updateTransform = function() {
      const scale = 1 / (canvas.stage.scale.x || 1);
      for ( const child of this.children ) child.scale.set(scale, scale);
      PIXI.Container.prototype.updateTransform.call(this);
    };
    // Live preview while the GM drags a new path.
    this.previewLayer = this.addChild(new PIXI.Graphics());

    /** Whether the scene was a WonderMap when this layer was drawn. */
    this.drawnEnabled = this.enabled;
    if ( !this.enabled ) return;
    this._hideSceneBackground();
    this._drawBackground();
    // Never let a WonderMaps problem abort the whole canvas draw.
    try {
      await this.refresh();
    } catch(err) {
      console.error(`${MODULE_ID} | failed to draw the map`, err);
    }
  }

  /** @override */
  async _tearDown(options) {
    this.menu.close();
    this._cancelDrag();
    this.map = null;
    return super._tearDown(options);
  }

  /** @override */
  _activate() {
    this.refresh();
  }

  /** @override */
  _deactivate() {
    // Areas stay clickable for everybody (to see their art) even when inactive.
    this.interactiveChildren = true;
    this.menu.close();
    this._cancelDrag();
    this.refresh();
  }

  /**
   * Re-read the scene flags and redraw everything.
   */
  async refresh() {
    if ( !this.background || this.background.destroyed ) return;
    const id = ++this._refreshId;
    if ( !this.enabled ) {
      this.map = null;
      for ( const c of [this.edgesLayer, this.crossroadsLayer, this.areasLayer, this.arrowsLayer, this.branchesLayer,
        this.labelsLayer] ) {
        c.removeChildren().forEach(o => o.destroy({ children: true }));
      }
      return;
    }

    const map = getMap(canvas.scene);
    const textures = await this._loadTextures(map);
    if ( (id !== this._refreshId) || this.background.destroyed ) return;
    this.map = map;
    this.textures = textures;
    this.pivot0 = this._pivot(map);
    this.visibility = this._visibility(map);
    this.branches = branchNumbers(map);

    this._drawEdges(map);
    this._drawCrossroads(map);
    this._drawAreas(map);
    this._drawArrows(map);
    this._drawBranches(map);
  }

  /** Preload every texture the map needs. */
  async _loadTextures(map) {
    const srcs = new Set();
    for ( const a of map.areas ) {
      if ( a.img ) srcs.add(a.img);
      if ( a.frameImg ) srcs.add(a.frameImg);
      for ( const t of a.tracks ?? [] ) if ( t.img ) srcs.add(t.img);
    }
    const textures = new Map();
    await Promise.all([...srcs].map(async src => {
      try {
        const tex = await loadTexture(src);
        if ( tex ) textures.set(src, tex);
      } catch(err) {
        console.warn(`${MODULE_ID} | could not load ${src}`, err);
      }
    }));
    return textures;
  }

  /* -------------------------------------------- */
  /*  Geometry                                    */
  /* -------------------------------------------- */

  /** The point the map rotates around: the active area, or the scene centre. */
  _pivot(map) {
    const active = map.areas.find(a => a.id === map.activeArea);
    if ( active ) return { x: active.x, y: active.y };
    const d = canvas.dimensions;
    return { x: d.sceneX + (d.sceneWidth / 2), y: d.sceneY + (d.sceneHeight / 2) };
  }

  /** Convert an unrotated map point to a world (canvas) point. */
  toWorld(p) {
    const theta = this.map?.rotation ?? 0;
    const pv = this.pivot0 ?? { x: 0, y: 0 };
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const dx = p.x - pv.x;
    const dy = p.y - pv.y;
    return { x: pv.x + (dx * c) - (dy * s), y: pv.y + (dx * s) + (dy * c) };
  }

  /** Convert a world (canvas) point back to unrotated map space. */
  toMap(p) {
    const theta = -(this.map?.rotation ?? 0);
    const pv = this.pivot0 ?? { x: 0, y: 0 };
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const dx = p.x - pv.x;
    const dy = p.y - pv.y;
    return { x: Math.round(pv.x + (dx * c) - (dy * s)), y: Math.round(pv.y + (dx * s) + (dy * c)) };
  }

  /**
   * World-space box around every area and crossroad the current user can see,
   * or null when there is none (or the map is not drawn yet).
   * @returns {PIXI.Rectangle|null}
   */
  contentBounds() {
    const map = this.map;
    if ( !map || !this.visibility ) return null;
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    const add = (node, r) => {
      const p = this.toWorld(node);
      left = Math.min(left, p.x - r);
      top = Math.min(top, p.y - r);
      right = Math.max(right, p.x + r);
      bottom = Math.max(bottom, p.y + r);
    };
    for ( const a of map.areas ) {
      if ( this.visibility.areas.has(a.id) ) add(a, (Number(a.radius) || AREA_DEFAULTS.radius) + (Number(a.frameWidth) || 0));
    }
    for ( const c of map.crossroads ) {
      if ( this.visibility.crossroads.has(c.id) ) add(c, c.size ?? CROSSROAD_DEFAULTS.size);
    }
    if ( left > right ) return null;
    return new PIXI.Rectangle(left, top, right - left, bottom - top);
  }

  /** Radius used to trim path lines at a node. */
  _nodeRadius(id) {
    const found = findNode(this.map, id);
    if ( !found ) return 0;
    if ( found.type === "area" ) return (found.node.radius ?? AREA_DEFAULTS.radius) + ((found.node.frameWidth ?? 0) / 2);
    // A crossroad the user can't see must not leave a gap in the path.
    if ( this.visibility && !this.visibility.crossroads.has(id) ) return 0;
    return found.node.size ?? CROSSROAD_DEFAULTS.size;
  }

  /* -------------------------------------------- */
  /*  Visibility                                  */
  /* -------------------------------------------- */

  /**
   * Decide what the current user can see.
   * The GM sees everything. A player sees the active area and, if they passed
   * the intelligence check, the visited areas (and the paths to them) that are
   * adjacent to it, greyed out. Areas and paths the GM hid never show up this
   * way; the active area always does, since the party is standing in it.
   */
  _visibility(map) {
    if ( game.user.isGM ) {
      return {
        all: true,
        areas: new Set(map.areas.map(a => a.id)),
        crossroads: new Set(map.crossroads.map(c => c.id)),
        edges: new Set(map.edges.map(e => e.id)),
        dim: new Set(),
        dimEdges: new Set()
      };
    }
    // Players never see crossroads (nor DCs or travel times): paths run straight through them.
    const vis = { all: false, areas: new Set(), crossroads: new Set(), edges: new Set(), dim: new Set(), dimEdges: new Set() };
    if ( !map.activeArea ) return vis;
    vis.areas.add(map.activeArea);
    // "Always visible" areas next to the active one, and the paths to them, for
    // everybody and in full colour.
    const landmarks = visibleLandmarks(map);
    landmarks.areas.forEach(id => vis.areas.add(id));
    landmarks.edges.forEach(id => vis.edges.add(id));
    const mine = map.checks.find(c => c.userId === game.user.id);
    if ( mine?.intelligence?.success ) {
      const near = rememberedNeighbourhood(map);
      for ( const id of near.areas ) {
        if ( vis.areas.has(id) ) continue; // A visible landmark stays in full colour.
        vis.areas.add(id);
        vis.dim.add(id);
      }
      for ( const id of near.edges ) {
        if ( vis.edges.has(id) ) continue; // Already bright as a path to a landmark.
        vis.edges.add(id);
        vis.dimEdges.add(id);
      }
    }
    return vis;
  }

  /* -------------------------------------------- */

  _clear(container) {
    container.removeChildren().forEach(o => o.destroy({ children: true }));
  }

  /** Build the backdrop sprite from the scene background texture. */
  _drawBackground() {
    this._clear(this.background);
    const tex = canvas.primary.background?.texture;
    if ( !tex || (tex === PIXI.Texture.EMPTY) || !tex.valid ) return;
    const sprite = this.background.addChild(new PIXI.Sprite(tex));
    sprite.anchor.set(0.5, 0.5);
    this._fitBackdrop();
  }

  /**
   * Keep the backdrop covering the whole screen, like CSS `background-size: cover`.
   * Called from the backdrop container's updateTransform, i.e. once per rendered frame.
   */
  _fitBackdrop() {
    const sprite = this.background?.children[0];
    if ( !sprite || sprite.destroyed || !sprite.texture?.valid ) return;
    const screen = canvas.app.screen;
    const stage = canvas.stage;
    // The stage is only translated and scaled (never rotated), so the visible
    // rectangle in canvas space is simple to compute from its current values.
    const scale = stage.scale.x || 1;
    const w = screen.width / scale;
    const h = screen.height / scale;
    const cx = stage.pivot.x + (((screen.width / 2) - stage.position.x) / scale);
    const cy = stage.pivot.y + (((screen.height / 2) - stage.position.y) / scale);
    const { width, height } = sprite.texture;
    const cover = Math.max(w / width, h / height);
    sprite.scale.set(cover, cover);
    sprite.position.set(cx, cy);
  }

  /**
   * The scene background is drawn by this layer, as a fixed backdrop, instead of core.
   * Use `renderable`: some modules make the mesh's `visible` a read-only getter.
   */
  _hideSceneBackground() {
    const bg = canvas.primary.background;
    if ( bg ) bg.renderable = false;
  }

  _drawEdges(map) {
    this._clear(this.edgesLayer);
    this._clear(this.labelsLayer);
    const gm = game.user.isGM;
    for ( const edge of map.edges ) {
      if ( !this.visibility.edges.has(edge.id) ) continue;
      const a = findNode(map, edge.from);
      const b = findNode(map, edge.to);
      if ( !a || !b ) continue;
      const pa = this.toWorld(a.node);
      const pb = this.toWorld(b.node);
      const len = Math.hypot(pb.x - pa.x, pb.y - pa.y);
      if ( len < 1 ) continue;
      const ux = (pb.x - pa.x) / len;
      const uy = (pb.y - pa.y) / len;
      const ra = this._nodeRadius(edge.from);
      const rb = this._nodeRadius(edge.to);
      if ( ra + rb >= len ) continue;
      const p0 = { x: pa.x + (ux * ra), y: pa.y + (uy * ra) };
      const p1 = { x: pb.x - (ux * rb), y: pb.y - (uy * rb) };

      const g = this.edgesLayer.addChild(new PIXI.Graphics());
      const dim = this.visibility.dimEdges.has(edge.id);
      let color = COLORS.path;
      if ( dim ) color = COLORS.pathVisited;
      else if ( gm && edge.wrong ) color = COLORS.pathWrong;
      const width = 6;
      g.lineStyle({ width: width + 4, color: 0x000000, alpha: 0.45, cap: PIXI.LINE_CAP.ROUND });
      g.moveTo(p0.x, p0.y).lineTo(p1.x, p1.y);
      g.lineStyle({ width, color, alpha: dim ? 0.75 : 1, cap: PIXI.LINE_CAP.ROUND });
      // Hidden from the players: the GM sees it faded, like a hidden token.
      if ( edge.hidden ) g.alpha = 0.4;
      if ( gm && edge.wrong ) this._dashed(g, p0, p1, 18, 12);
      else g.moveTo(p0.x, p0.y).lineTo(p1.x, p1.y);

      // Travel time, GM only, in the middle of the path, same size at any zoom.
      if ( gm && (Number(edge.time) > 0) ) {
        const label = this.labelsLayer.addChild(this._pill(formatMinutes(edge.time), COLORS.travelTime));
        label.position.set((p0.x + p1.x) / 2, (p0.y + p1.y) / 2);
      }

      if ( this.editing ) {
        const half = 12;
        const nx = -uy * half;
        const ny = ux * half;
        g.hitArea = new PIXI.Polygon([
          p0.x + nx, p0.y + ny, p1.x + nx, p1.y + ny,
          p1.x - nx, p1.y - ny, p0.x - nx, p0.y - ny
        ]);
        g.eventMode = "static";
        g.cursor = "pointer";
        g.on("pointerdown", event => this._onEdgePointerDown(event, edge));
      }
    }
  }

  /** A small text label on a dark rounded background, centred on its position. */
  _pill(text, color) {
    const c = new PIXI.Container();
    const style = this._textStyle(15);
    style.fill = color;
    style.fontWeight = "bold";
    const label = new PreciseText(text, style);
    label.anchor.set(0.5, 0.5);
    const w = label.width + 12;
    const h = label.height + 2;
    const bg = c.addChild(new PIXI.Graphics());
    bg.lineStyle({ width: 2, color }).beginFill(0x111111, 0.9).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2).endFill();
    c.addChild(label);
    return c;
  }

  _dashed(g, p0, p1, dash, gap) {
    const len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const ux = (p1.x - p0.x) / len;
    const uy = (p1.y - p0.y) / len;
    for ( let t = 0; t < len; t += dash + gap ) {
      const e = Math.min(t + dash, len);
      g.moveTo(p0.x + (ux * t), p0.y + (uy * t)).lineTo(p0.x + (ux * e), p0.y + (uy * e));
    }
  }

  _drawCrossroads(map) {
    this._clear(this.crossroadsLayer);
    const gm = game.user.isGM;
    for ( const cross of map.crossroads ) {
      if ( !this.visibility.crossroads.has(cross.id) ) continue;
      const p = this.toWorld(cross);
      const size = cross.size ?? CROSSROAD_DEFAULTS.size;
      const c = this.crossroadsLayer.addChild(new PIXI.Container());
      c.position.set(p.x, p.y);

      const g = c.addChild(new PIXI.Graphics());
      const pts = [];
      for ( let i = 0; i < 6; i++ ) {
        const ang = (Math.PI / 6) + (i * Math.PI / 3);
        pts.push(Math.cos(ang) * size, Math.sin(ang) * size);
      }
      g.lineStyle({ width: 4, color: gm ? COLORS.crossroadLine : COLORS.pathVisited });
      g.beginFill(COLORS.crossroad, gm ? 0.95 : 0.6).drawPolygon(pts).endFill();

      // Only the GM sees the DC.
      if ( gm ) {
        const text = c.addChild(new PreciseText(String(cross.dc ?? ""), this._textStyle(Math.round(size * 0.7))));
        text.anchor.set(0.5, 0.5);
        if ( cross.name ) {
          const label = c.addChild(new PreciseText(cross.name, this._textStyle(16)));
          label.anchor.set(0.5, 0);
          label.position.set(0, size + 4);
        }
      }

      if ( this.editing ) {
        c.eventMode = "static";
        c.cursor = "pointer";
        c.hitArea = new PIXI.Polygon(pts);
        c.on("pointerdown", event => this._onNodePointerDown(event, "crossroad", cross, c));
      }
    }
  }

  _drawAreas(map) {
    this._clear(this.areasLayer);
    const gm = game.user.isGM;
    for ( const area of map.areas ) {
      if ( !this.visibility.areas.has(area.id) ) continue;
      const c = this.areasLayer.addChild(this._drawArea(area, {
        active: area.id === map.activeArea,
        dim: this.visibility.dim.has(area.id),
        visited: map.visited.includes(area.id),
        gm
      }));
      if ( gm && area.hidden ) c.alpha = 0.5;
      const p = this.toWorld(area);
      c.position.set(p.x, p.y);

      // Everybody: hovering shows a magnifier, clicking opens the full art.
      const r = Number(area.radius) || AREA_DEFAULTS.radius;
      const overlay = c.addChild(this._artOverlay(r));
      c.eventMode = "static";
      c.cursor = "pointer";
      c.hitArea = new PIXI.Circle(0, 0, r);
      c.on("pointerover", () => overlay.visible = true);
      c.on("pointerout", () => overlay.visible = false);
      c.on("pointerdown", event => this._onNodePointerDown(event, "area", area, c));
    }
  }

  /** Dark veil with a magnifier icon, shown while hovering an area. */
  _artOverlay(r) {
    const overlay = new PIXI.Container();
    overlay.zIndex = 5;
    overlay.visible = false;
    const veil = overlay.addChild(new PIXI.Graphics());
    veil.beginFill(0x000000, 0.45).drawCircle(0, 0, r).endFill();
    const style = this._textStyle(Math.round(Math.max(18, r * 0.4)));
    style.fontFamily = "Font Awesome 6 Pro";
    style.fontWeight = "900";
    const icon = overlay.addChild(new PreciseText("\uf00e", style)); // magnifying-glass-plus
    icon.anchor.set(0.5, 0.5);
    return overlay;
  }

  /** Show the full art of an area in Foundry's image viewer. */
  showArt(area) {
    if ( !area.img ) return;
    new ImagePopout(area.img, {
      title: area.name || game.i18n.localize("WONDERMAPS.Area"),
      shareable: game.user.isGM
    }).render(true);
  }

  /** Build the upright container for one area. */
  _drawArea(area, { active, dim, visited, gm }) {
    const r = Number(area.radius) || AREA_DEFAULTS.radius;
    const frameWidth = Number(area.frameWidth) || 0;
    const frameColor = Color.from(area.frameColor || AREA_DEFAULTS.frameColor);
    const c = new PIXI.Container();
    c.sortableChildren = true;

    // Active glow
    if ( active ) {
      const glow = c.addChild(new PIXI.Graphics());
      for ( let i = 4; i > 0; i-- ) {
        glow.lineStyle({ width: 6, color: COLORS.active, alpha: 0.12 * (5 - i) });
        glow.drawCircle(0, 0, r + (frameWidth / 2) + (i * 6));
      }
    }

    // Circle backing + image
    const back = c.addChild(new PIXI.Graphics());
    back.beginFill(0x111111, 1).drawCircle(0, 0, r).endFill();
    const tex = this.textures.get(area.img);
    if ( tex ) {
      const sprite = c.addChild(new PIXI.Sprite(tex));
      sprite.anchor.set(0.5, 0.5);
      const scale = (2 * r) / Math.min(tex.width, tex.height);
      sprite.scale.set(scale, scale);
      const mask = c.addChild(new PIXI.Graphics());
      mask.beginFill(0xffffff).drawCircle(0, 0, r).endFill();
      sprite.mask = mask;
    }

    // Frame
    const frameTex = area.frameImg ? this.textures.get(area.frameImg) : null;
    if ( frameTex ) {
      const frame = c.addChild(new PIXI.Sprite(frameTex));
      frame.anchor.set(0.5, 0.5);
      const size = (2 * r) + (2 * Math.max(frameWidth, 8));
      frame.width = size;
      frame.height = size;
    }
    else if ( frameWidth > 0 ) {
      const ring = c.addChild(new PIXI.Graphics());
      ring.lineStyle({ width: frameWidth, color: frameColor, alignment: 0.5 });
      ring.drawCircle(0, 0, r);
    }

    // Name
    if ( area.name ) {
      const label = c.addChild(new PreciseText(area.name, this._textStyle(Math.max(16, Math.round(r / 4)))));
      label.anchor.set(0.5, 0);
      label.position.set(0, r + (frameWidth / 2) + 6);
    }

    // GM-only decorations
    if ( gm ) {
      const br = Math.max(10, r * 0.14);
      if ( area.landmark ) {
        // Eye at the bottom left: this area is always visible from next door.
        const eye = c.addChild(new PIXI.Graphics());
        const angle = (3 * Math.PI) / 4;
        const ex = Math.cos(angle) * r;
        const ey = Math.sin(angle) * r;
        eye.lineStyle({ width: 2, color: 0x000000 }).beginFill(0x2f6db5).drawCircle(ex, ey, br).endFill();
        eye.lineStyle({ width: 2, color: 0xffffff });
        eye.moveTo(ex - (br * 0.7), ey)
          .quadraticCurveTo(ex, ey - (br * 0.75), ex + (br * 0.7), ey)
          .quadraticCurveTo(ex, ey + (br * 0.75), ex - (br * 0.7), ey);
        eye.lineStyle(0).beginFill(0xffffff).drawCircle(ex, ey, br * 0.22).endFill();
      }
      if ( area.scene && game.scenes.has(area.scene) ) c.addChild(this._sceneBadge(area, r, br));
      if ( visited && !active ) {
        const badge = c.addChild(new PIXI.Graphics());
        const angle = Math.PI / 4;
        const bx = Math.cos(angle) * r;
        const by = Math.sin(angle) * r;
        badge.lineStyle({ width: 2, color: 0x000000 }).beginFill(0x6cc070).drawCircle(bx, by, br).endFill();
        badge.lineStyle({ width: 3, color: 0xffffff });
        badge.moveTo(bx - (br * 0.45), by).lineTo(bx - (br * 0.1), by + (br * 0.4)).lineTo(bx + (br * 0.5), by - (br * 0.4));
      }
      this._drawTracks(c, area, r);
    }

    if ( dim ) {
      const CMF = PIXI.ColorMatrixFilter ?? PIXI.filters.ColorMatrixFilter;
      const filter = new CMF();
      filter.desaturate();
      c.filters = [filter];
      c.alpha = 0.55;
    }
    return c;
  }

  /**
   * GM-only shortcut at the top left of an area linked to a scene: click it to
   * activate that scene (restoring a SnapScene snapshot first, if wanted).
   */
  _sceneBadge(area, r, br) {
    const angle = -(3 * Math.PI) / 4;
    const badge = new PIXI.Container();
    badge.position.set(Math.cos(angle) * r, Math.sin(angle) * r);
    badge.zIndex = 10;
    const size = br * 1.2;
    const g = badge.addChild(new PIXI.Graphics());
    g.lineStyle({ width: 2, color: 0x000000 }).beginFill(0xb5452f).drawCircle(0, 0, size).endFill();
    const style = this._textStyle(Math.round(size * 1.1));
    style.fontFamily = "Font Awesome 6 Pro";
    style.fontWeight = "900";
    style.fill = 0xffffff;
    const icon = badge.addChild(new PreciseText("\uf140", style)); // bullseye, like Foundry's active-scene mark
    icon.anchor.set(0.5, 0.5);
    const scene = game.scenes.get(area.scene);
    const label = badge.addChild(new PreciseText(
      game.i18n.format("WONDERMAPS.SceneLink.BadgeLabel", { scene: scene?.name ?? "?" }), this._textStyle(15)));
    label.anchor.set(1, 0.5);
    label.position.set(-size - 4, 0);
    label.visible = false;
    badge.eventMode = "static";
    badge.cursor = "pointer";
    badge.hitArea = new PIXI.Circle(0, 0, size);
    badge.on("pointerover", () => label.visible = true);
    badge.on("pointerout", () => label.visible = false);
    badge.on("pointerdown", event => {
      event.stopPropagation();
      if ( event.button === 0 ) activateLinkedScene(area);
    });
    return badge;
  }

  /** Tracks: small circles around the top-right of the area, GM only. */
  _drawTracks(container, area, r) {
    const tracks = area.tracks ?? [];
    if ( !tracks.length ) return;
    const tr = Math.max(14, r * 0.24);
    const ring = r + (tr * 0.35);
    const step = Math.min(Math.PI / 5, (2 * Math.asin(Math.min(1, (tr * 1.1) / ring))));
    tracks.forEach((track, i) => {
      // Fan out from the top-right: -45°, then alternate towards top and right.
      const k = Math.ceil(i / 2) * (i % 2 ? -1 : 1);
      const angle = (-Math.PI / 4) + (k * step);
      const t = container.addChild(new PIXI.Container());
      t.position.set(Math.cos(angle) * ring, Math.sin(angle) * ring);
      t.zIndex = 10;
      const g = t.addChild(new PIXI.Graphics());
      g.lineStyle({ width: 2, color: COLORS.trackLine }).beginFill(COLORS.track, 0.95).drawCircle(0, 0, tr).endFill();
      const dc = (track.dc !== "") && (track.dc != null) ? String(track.dc) : "?";
      const tex = track.img ? this.textures.get(track.img) : null;
      if ( tex ) {
        // Icon inside the circle, DC in a small tag at its bottom right.
        const icon = t.addChild(new PIXI.Sprite(tex));
        icon.anchor.set(0.5, 0.5);
        const size = tr * 1.5;
        const scale = size / Math.max(tex.width, tex.height);
        icon.scale.set(scale, scale);
        const tag = t.addChild(new PIXI.Container());
        tag.position.set(tr * 0.75, tr * 0.75);
        const tg = tag.addChild(new PIXI.Graphics());
        const tagRadius = Math.max(8, tr * 0.5);
        tg.lineStyle({ width: 1.5, color: COLORS.trackLine }).beginFill(0x111111, 0.95).drawCircle(0, 0, tagRadius).endFill();
        const text = tag.addChild(new PreciseText(dc, this._textStyle(Math.round(tagRadius * 1.1))));
        text.anchor.set(0.5, 0.5);
      }
      else {
        const text = t.addChild(new PreciseText(dc, this._textStyle(Math.round(tr * 0.95))));
        text.anchor.set(0.5, 0.5);
      }

      const name = track.name || game.i18n.localize("WONDERMAPS.Track");
      const label = t.addChild(new PreciseText(`${name} (${game.i18n.localize("WONDERMAPS.Chat.DC")} ${dc})`, this._textStyle(15)));
      label.anchor.set(0, 0.5);
      label.position.set(tr + 4, 0);
      label.visible = false;

      if ( this.editing ) {
        t.eventMode = "static";
        t.cursor = "pointer";
        t.hitArea = new PIXI.Circle(0, 0, tr);
        t.on("pointerover", () => label.visible = true);
        t.on("pointerout", () => label.visible = false);
        t.on("pointerdown", event => this._onTrackPointerDown(event, area, track));
      }
    });
  }

  /**
   * Compass arrows under the active area, poking out past its frame. Players
   * only see their own arrow; the GM sees every player's arrow in that
   * player's colour on top of a bigger arrow pointing to true north.
   */
  _drawArrows(map) {
    this._clear(this.arrowsLayer);
    const active = map.areas.find(a => a.id === map.activeArea);
    if ( !active ) return;
    const p = this.toWorld(active);
    const r = Number(active.radius) || AREA_DEFAULTS.radius;
    // Distance from the centre to the outer edge of the frame.
    const edge = r + ((Number(active.frameWidth) || 0) / 2);
    const place = (arrow, rotation) => {
      arrow.position.set(p.x, p.y);
      arrow.rotation = rotation;
    };

    if ( game.user.isGM ) {
      place(this._arrow(edge, { poke: r * 0.85, width: r * 0.16, color: COLORS.arrow, label: true }), map.rotation);
      for ( const check of map.checks ) {
        const user = game.users.get(check.userId);
        if ( !user ) continue;
        const color = Color.from(user.color ?? "#ffffff");
        place(this._arrow(edge, { poke: r * 0.5, width: r * 0.08, color }), check.arrow);
      }
      return;
    }

    const mine = map.checks.find(c => c.userId === game.user.id);
    if ( !mine ) return;
    place(this._arrow(edge, { poke: r * 0.6, width: r * 0.12, color: COLORS.arrow, label: true }), mine.arrow);
  }

  /**
   * Numbered branches around the active area, one per path leaving it.
   * Players only get a short line in the path's direction that fades away, so
   * they learn where paths start but not where they lead. The GM sees the real
   * paths; both get the same number badges, at the same spot.
   */
  _drawBranches(map) {
    this._clear(this.branchesLayer);
    const active = map.areas.find(a => a.id === map.activeArea);
    if ( !active || !this.branches.size ) return;
    const gm = game.user.isGM;
    const pa = this.toWorld(active);
    const r = Number(active.radius) || AREA_DEFAULTS.radius;
    const edge = r + ((Number(active.frameWidth) || 0) / 2);
    const stub = r * 1.4;
    const badgeRadius = Math.max(13, r * 0.15);
    const { votes, highlights } = this._readVotes(map);

    for ( const [edgeId, n] of this.branches ) {
      const path = map.edges.find(e => e.id === edgeId);
      const otherId = path.from === active.id ? path.to : path.from;
      const other = findNode(map, otherId);
      if ( !other ) continue;
      const pb = this.toWorld(other.node);
      const len = Math.hypot(pb.x - pa.x, pb.y - pa.y);
      if ( len < 1 ) continue;
      const ux = (pb.x - pa.x) / len;
      const uy = (pb.y - pa.y) / len;
      const at = d => ({ x: pa.x + (ux * d), y: pa.y + (uy * d) });

      if ( !gm ) {
        // A line that fades out as it leaves the circle.
        const g = this.branchesLayer.addChild(new PIXI.Graphics());
        const steps = 16;
        for ( const [width, color, strength] of [[11, 0x000000, 0.45], [7, COLORS.path, 0.95]] ) {
          for ( let i = 0; i < steps; i++ ) {
            const a = at(edge + (stub * i / steps));
            const b = at(edge + (stub * (i + 1) / steps));
            g.lineStyle({ width, color, alpha: strength * (1 - (i / steps)) });
            g.moveTo(a.x, a.y).lineTo(b.x, b.y);
          }
        }
      }

      // The badge sits on the path, close to the circle.
      const room = len - edge - this._nodeRadius(otherId);
      // Far enough out to clear the area's name label below the circle.
      const offset = Math.min(r * 0.75, Math.max(badgeRadius, room / 2));
      const pos = at(edge + offset);
      const badge = this.branchesLayer.addChild(new PIXI.Container());
      badge.position.set(pos.x, pos.y);
      const g = badge.addChild(new PIXI.Graphics());
      // Green when the GM highlights this branch.
      const fill = highlights.has(edgeId) ? COLORS.highlight : 0x1a1a1a;
      g.lineStyle({ width: 3, color: COLORS.path }).beginFill(fill, 0.95).drawCircle(0, 0, badgeRadius).endFill();
      const text = badge.addChild(new PreciseText(String(n), this._textStyle(Math.round(badgeRadius * 1.25))));
      text.anchor.set(0.5, 0.5);

      // Players' votes: a dot in each voter's colour, in a row above the badge.
      const voters = votes.get(edgeId) ?? [];
      const dotRadius = Math.max(5, badgeRadius * 0.32);
      const spacing = dotRadius * 2.4;
      voters.forEach((user, i) => {
        const dot = badge.addChild(new PIXI.Graphics());
        const x = (i - ((voters.length - 1) / 2)) * spacing;
        const y = -badgeRadius - dotRadius - 3;
        dot.lineStyle({ width: 2, color: 0x000000 }).beginFill(Color.from(user.color ?? "#ffffff")).drawCircle(x, y, dotRadius).endFill();
      });

      // Everybody can click a number: players vote, the GM highlights.
      badge.eventMode = "static";
      badge.cursor = "pointer";
      badge.hitArea = new PIXI.Circle(0, 0, badgeRadius);
      badge.on("pointerdown", event => {
        if ( event.button !== 0 ) return;
        event.stopPropagation();
        this._toggleVote(edgeId);
      });
    }
  }

  /* -------------------------------------------- */
  /*  Branch votes                                */
  /* -------------------------------------------- */

  /**
   * Votes only count for the current stay in the current area: the key changes
   * every time an area is activated, which resets all votes at once.
   */
  _voteKey(map) {
    return `${canvas.scene?.id}:${map.transition}`;
  }

  /**
   * Read every user's vote flag. Players' picks are votes; GM picks are highlights.
   * @returns {{votes: Map<string, User[]>, highlights: Set<string>}}
   */
  _readVotes(map) {
    const key = this._voteKey(map);
    const votes = new Map();
    const highlights = new Set();
    for ( const user of game.users ) {
      const flag = user.getFlag(MODULE_ID, "vote");
      if ( (flag?.key !== key) || !Array.isArray(flag.edges) ) continue;
      for ( const edgeId of flag.edges ) {
        if ( user.isGM ) highlights.add(edgeId);
        else {
          if ( !votes.has(edgeId) ) votes.set(edgeId, []);
          votes.get(edgeId).push(user);
        }
      }
    }
    return { votes, highlights };
  }

  /**
   * Toggle the current user's pick on a branch. Stored on the user's own User
   * document, which every user may update, so no GM round trip is needed.
   */
  async _toggleVote(edgeId) {
    if ( !this.map ) return;
    const key = this._voteKey(this.map);
    const flag = game.user.getFlag(MODULE_ID, "vote");
    const current = (flag?.key === key) && Array.isArray(flag.edges) ? flag.edges : [];
    const edges = current.includes(edgeId) ? current.filter(id => id !== edgeId) : [...current, edgeId];
    await game.user.update({ [`flags.${MODULE_ID}.vote`]: { key, edges } });
  }

  /**
   * Build an arrow pointing up (towards -y) from the centre of an area.
   * @param {number} edge          Distance from the centre to the edge of the circle.
   * @param {object} options
   * @param {number} options.poke  How far the tip reaches beyond the edge.
   * @param {number} options.width Width of the shaft.
   * @param {number} options.color
   * @param {boolean} [options.label=false]  Write an "N" past the tip.
   */
  _arrow(edge, { poke, width, color, label=false }) {
    const c = this.arrowsLayer.addChild(new PIXI.Container());
    const g = c.addChild(new PIXI.Graphics());
    const tip = edge + poke;
    const w = Math.max(4, width) / 2;
    const headLength = Math.max(14, poke * 0.65);
    const headWidth = Math.max(w * 2.6, headLength * 0.75);
    const base = -tip + headLength;
    g.lineStyle({ width: 3, color: COLORS.arrowLine, alpha: 1, join: PIXI.LINE_JOIN.MITER });
    g.beginFill(color, 1);
    g.drawPolygon([
      -w, 0,
      -w, base,
      -headWidth, base,
      0, -tip,
      headWidth, base,
      w, base,
      w, 0
    ]);
    g.endFill();
    if ( label ) {
      const n = c.addChild(new PreciseText("N", this._textStyle(Math.round(Math.max(18, headLength * 0.8)))));
      n.anchor.set(0.5, 1);
      n.position.set(0, -tip - 2);
    }
    return c;
  }

  _textStyle(size) {
    const style = CONFIG.canvasTextStyle.clone();
    style.fontSize = size;
    return style;
  }

  /* -------------------------------------------- */
  /*  Canvas interaction (empty space)            */
  /* -------------------------------------------- */

  /** @override */
  _canDragLeftStart(user, event) {
    return false;
  }

  /** @override */
  _onClickLeft(event) {
    this.menu.close();
    if ( !this.enabled || !game.user.isGM ) return;
    const world = event.getLocalPosition(this);
    const p = this.toMap(world);
    switch ( this.tool ) {
      case "area": return this._createArea(p);
      case "crossroad": return ui.notifications.info(game.i18n.localize("WONDERMAPS.Notify.CrossroadOnPath"));
    }
  }

  /** @override */
  _onClickRight(event) {
    this.menu.close();
  }

  async _createArea(p) {
    const map = getMap(canvas.scene);
    const area = {
      ...foundry.utils.deepClone(AREA_DEFAULTS),
      id: foundry.utils.randomID(),
      x: p.x,
      y: p.y,
      radius: map.defaults.areaRadius
    };
    area.name = game.i18n.format("WONDERMAPS.NewArea", { n: map.areas.length + 1 });
    await saveMap(canvas.scene, { areas: [...map.areas, area] });
    new AreaConfig(canvas.scene, area.id).render(true);
  }

  /**
   * Put a crossroad on a path, at the point closest to where the GM clicked.
   * The path is split in two; each half keeps the "wrong direction" mark and
   * gets its share of the travel time.
   */
  async _splitEdge(edgeId, world) {
    const map = getMap(canvas.scene);
    const edge = map.edges.find(e => e.id === edgeId);
    const a = edge && findNode(map, edge.from)?.node;
    const b = edge && findNode(map, edge.to)?.node;
    if ( !a || !b ) return;
    const p = this.toMap(world);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = (dx * dx) + (dy * dy);
    if ( !len2 ) return;
    const t = Math.clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0.05, 0.95);
    const cross = {
      ...CROSSROAD_DEFAULTS,
      size: map.defaults.crossroadSize,
      id: foundry.utils.randomID(),
      x: Math.round(a.x + (dx * t)),
      y: Math.round(a.y + (dy * t))
    };
    const time = Number(edge.time) || 0;
    const firstTime = Math.round(time * t);
    const halves = [
      { ...edge, id: foundry.utils.randomID(), to: cross.id, time: firstTime },
      { ...edge, id: foundry.utils.randomID(), from: cross.id, time: time - firstTime }
    ];
    const edges = map.edges.flatMap(e => (e.id === edgeId ? halves : [e]));
    await saveMap(canvas.scene, { crossroads: [...map.crossroads, cross], edges });
  }

  /* -------------------------------------------- */
  /*  Node interaction                            */
  /* -------------------------------------------- */

  _onNodePointerDown(event, type, node, container) {
    event.stopPropagation();
    this.menu.close();
    const client = { x: event.clientX, y: event.clientY };

    // Outside of editing (players, or the GM on another layer) an area only shows its art.
    if ( !this.editing ) {
      if ( (event.button === 0) && (type === "area") ) this.showArt(node);
      return;
    }

    if ( event.button === 2 ) return this._openNodeMenu(type, node, client);
    if ( event.button !== 0 ) return;

    this._drag = {
      mode: this.tool === "connect" ? "connect" : "move",
      type, node, container,
      start: { ...client },
      origin: { x: container.x, y: container.y },
      moved: false
    };
    window.addEventListener("pointermove", this._onDragMove);
    window.addEventListener("pointerup", this._onDragEnd);
  }

  _onDragMove(event) {
    const drag = this._drag;
    if ( !drag || drag.container.destroyed ) return this._cancelDrag();
    const dx = event.clientX - drag.start.x;
    const dy = event.clientY - drag.start.y;
    if ( !drag.moved && (Math.hypot(dx, dy) < DRAG_THRESHOLD) ) return;
    drag.moved = true;
    const world = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
    if ( drag.mode === "connect" ) return this._drawPreview(drag, world);
    drag.container.position.set(world.x, world.y);
  }

  /** Preview line of a path being dragged, snapping onto the node under the pointer. */
  _drawPreview(drag, world) {
    const g = this.previewLayer;
    g.clear();
    const from = { x: drag.container.x, y: drag.container.y };
    const target = this._nodeAt(world, drag.node.id);
    const to = target ? this.toWorld(target.node) : world;
    g.lineStyle({ width: 6, color: COLORS.selection, alpha: 0.9, cap: PIXI.LINE_CAP.ROUND });
    g.moveTo(from.x, from.y).lineTo(to.x, to.y);
    if ( target ) {
      const r = this._nodeRadius(target.node.id);
      g.lineStyle({ width: 4, color: COLORS.selection }).drawCircle(to.x, to.y, r + 6);
    }
  }

  /**
   * The area or crossroad under a world point, if any.
   * @param {{x: number, y: number}} world
   * @param {string} [exclude]   Id to ignore.
   */
  _nodeAt(world, exclude) {
    const map = this.map;
    if ( !map ) return null;
    const hit = (node, radius) => {
      const p = this.toWorld(node);
      return Math.hypot(world.x - p.x, world.y - p.y) <= radius;
    };
    for ( const c of map.crossroads ) {
      if ( (c.id !== exclude) && hit(c, c.size ?? CROSSROAD_DEFAULTS.size) ) return { type: "crossroad", node: c };
    }
    for ( const a of map.areas ) {
      if ( (a.id !== exclude) && hit(a, Number(a.radius) || AREA_DEFAULTS.radius) ) return { type: "area", node: a };
    }
    return null;
  }

  async _onDragEnd(event) {
    const drag = this._drag;
    this._cancelDrag();
    if ( !drag ) return;

    if ( !drag.moved ) {
      if ( drag.mode === "connect" ) return;
      if ( drag.type === "area" ) return this.showArt(drag.node);
      return crossroadCheck(canvas.scene, drag.node.id);
    }

    const world = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
    if ( drag.mode === "connect" ) {
      const target = this._nodeAt(world, drag.node.id);
      if ( target ) return this._connect(drag.node.id, target.node.id);
      return ui.notifications.info(game.i18n.localize("WONDERMAPS.Notify.PathEnds"));
    }
    const p = this.toMap(world);
    const map = getMap(canvas.scene);
    const key = drag.type === "area" ? "areas" : "crossroads";
    const list = map[key].map(n => (n.id === drag.node.id ? { ...n, x: p.x, y: p.y } : n));
    // Moving the active area moves the rotation pivot too; that is fine since
    // the new pivot is exactly where the GM dropped it.
    await saveMap(canvas.scene, { [key]: list });
  }

  _cancelDrag() {
    this._drag = null;
    if ( this.previewLayer && !this.previewLayer.destroyed ) this.previewLayer.clear();
    window.removeEventListener("pointermove", this._onDragMove);
    window.removeEventListener("pointerup", this._onDragEnd);
  }

  /**
   * Create a path between two nodes (areas or crossroads).
   * The path a crossroad was placed on is the right way; any path drawn from or
   * to a crossroad afterwards is a fork, so it starts as a wrong way (the GM can
   * still flip it from the path's menu). It gets the map's default travel time.
   */
  async _connect(from, to) {
    if ( from === to ) return;
    const map = getMap(canvas.scene);
    const exists = map.edges.some(e => ((e.from === from) && (e.to === to)) || ((e.from === to) && (e.to === from)));
    if ( exists ) return ui.notifications.info(game.i18n.localize("WONDERMAPS.Notify.PathExists"));
    const isCrossroad = id => map.crossroads.some(c => c.id === id);
    const wrong = isCrossroad(from) || isCrossroad(to);
    const edge = { id: foundry.utils.randomID(), from, to, wrong, time: map.defaults.pathTime };
    await saveMap(canvas.scene, { edges: [...map.edges, edge] });
  }

  _openNodeMenu(type, node, client) {
    const scene = canvas.scene;
    const L = key => game.i18n.localize(`WONDERMAPS.Menu.${key}`);
    if ( type === "area" ) {
      const map = getMap(scene);
      const visited = map.visited.includes(node.id);
      return this.menu.open(client, node.name || game.i18n.localize("WONDERMAPS.Area"), [
        { icon: "fas fa-person-walking", label: L("WalkHere"), callback: () => walkTo(scene, node.id) },
        {
          icon: "fas fa-person-hiking",
          label: L("WalkHereDifficult"),
          callback: () => walkTo(scene, node.id, { difficult: true })
        },
        { icon: "fas fa-location-dot", label: L("SetActive"), callback: () => walkTo(scene, node.id, { checks: false, rotate: false, travel: false }) },
        ...(node.scene && game.scenes.has(node.scene) ? [{
          icon: "fas fa-bullseye",
          label: game.i18n.format("WONDERMAPS.SceneLink.MenuActivate", { scene: game.scenes.get(node.scene).name }),
          callback: () => activateLinkedScene(node)
        }] : []),
        { icon: "fas fa-pen-to-square", label: L("EditArea"), callback: () => new AreaConfig(scene, node.id).render(true) },
        { icon: "fas fa-paw", label: L("AddTrack"), callback: () => this._addTrack(node.id) },
        {
          icon: visited ? "fas fa-eye-slash" : "fas fa-eye",
          label: visited ? L("MarkUnvisited") : L("MarkVisited"),
          callback: () => this._toggleVisited(node.id)
        },
        {
          icon: node.hidden ? "fas fa-eye" : "fas fa-eye-slash",
          label: node.hidden ? L("Reveal") : L("Hide"),
          callback: () => this._updateArea(node.id, { hidden: !node.hidden })
        },
        { icon: "fas fa-trash", label: L("Delete"), callback: () => this._deleteNode(node.id) }
      ]);
    }
    return this.menu.open(client, node.name || game.i18n.localize("WONDERMAPS.Crossroad"), [
      { icon: "fas fa-dice-d20", label: L("RollCrossroad"), callback: () => crossroadCheck(scene, node.id) },
      { icon: "fas fa-pen-to-square", label: L("EditCrossroad"), callback: () => editCrossroad(scene, node.id) },
      { icon: "fas fa-trash", label: L("Delete"), callback: () => this._deleteNode(node.id) }
    ]);
  }

  async _addTrack(areaId) {
    const map = getMap(canvas.scene);
    const areas = map.areas.map(a => {
      if ( a.id !== areaId ) return a;
      const tracks = [...(a.tracks ?? []), { ...TRACK_DEFAULTS, id: foundry.utils.randomID() }];
      return { ...a, tracks };
    });
    await saveMap(canvas.scene, { areas });
    new AreaConfig(canvas.scene, areaId).render(true);
  }

  async _updateArea(id, changes) {
    const map = getMap(canvas.scene);
    await saveMap(canvas.scene, { areas: map.areas.map(a => (a.id === id ? { ...a, ...changes } : a)) });
  }

  async _toggleVisited(areaId) {
    const map = getMap(canvas.scene);
    const visited = map.visited.includes(areaId)
      ? map.visited.filter(id => id !== areaId)
      : [...map.visited, areaId];
    await saveMap(canvas.scene, { visited });
  }

  /**
   * Delete an area or a crossroad. Paths can not dangle, so the paths and
   * crossroads hanging off it go too (never other areas).
   */
  async _deleteNode(id) {
    const map = getMap(canvas.scene);
    const found = findNode(map, id);
    if ( !found ) return;
    const doomed = { edges: new Set(), crossroads: new Set() };
    const merge = net => {
      net.edges.forEach(e => doomed.edges.add(e));
      net.crossroads.forEach(c => doomed.crossroads.add(c));
    };
    if ( found.type === "crossroad" ) merge(pathNetwork(map, { crossroadId: id }));
    else {
      for ( const e of map.edges ) {
        if ( (e.from === id) || (e.to === id) ) merge(pathNetwork(map, { edgeId: e.id }));
      }
    }
    // The node and the paths touching it obviously go; only ask when more goes.
    const own = map.edges.filter(e => (e.from === id) || (e.to === id)).length;
    const expected = { edges: own, crossroads: found.type === "crossroad" ? 1 : 0 };
    if ( !(await this._confirmCascade(doomed, expected)) ) return;
    const changes = {
      areas: map.areas.filter(a => a.id !== id),
      crossroads: map.crossroads.filter(c => !doomed.crossroads.has(c.id)),
      edges: map.edges.filter(e => !doomed.edges.has(e.id)),
      visited: map.visited.filter(v => v !== id)
    };
    if ( map.activeArea === id ) {
      changes.activeArea = null;
      changes.checks = [];
    }
    await saveMap(canvas.scene, changes);
  }

  /**
   * Ask before a delete that takes more with it than the clicked item.
   * @param {{edges: Set, crossroads: Set}} doomed
   * @param {{edges?: number, crossroads?: number}} expected   What the GM obviously expects to go.
   */
  async _confirmCascade(doomed, { edges=0, crossroads=0 }={}) {
    if ( (doomed.edges.size <= edges) && (doomed.crossroads.size <= crossroads) ) return true;
    return Dialog.confirm({
      title: game.i18n.localize("WONDERMAPS.Menu.Delete"),
      content: `<p>${game.i18n.format("WONDERMAPS.Notify.CascadeConfirm", {
        paths: doomed.edges.size,
        crossroads: doomed.crossroads.size
      })}</p>`
    });
  }

  /* -------------------------------------------- */
  /*  Edge & track interaction                    */
  /* -------------------------------------------- */

  _onEdgePointerDown(event, edge) {
    event.stopPropagation();
    this.menu.close();
    if ( ![0, 2].includes(event.button) ) return;
    if ( (event.button === 0) && (this.tool === "crossroad") ) {
      return this._splitEdge(edge.id, event.getLocalPosition(this));
    }
    const L = key => game.i18n.localize(`WONDERMAPS.Menu.${key}`);
    const hidden = edge.hidden ? ` · ${game.i18n.localize("WONDERMAPS.Hidden")}` : "";
    const title = `${game.i18n.localize("WONDERMAPS.Path")} · ${formatMinutes(edge.time)}${hidden}`;
    this.menu.open({ x: event.clientX, y: event.clientY }, title, [
      { icon: "fas fa-hourglass-half", label: L("TravelTime"), callback: () => editEdgeTime(canvas.scene, edge.id) },
      {
        icon: edge.wrong ? "fas fa-check" : "fas fa-xmark",
        label: edge.wrong ? L("MarkRight") : L("MarkWrong"),
        callback: () => this._updateEdge(edge.id, { wrong: !edge.wrong })
      },
      {
        icon: edge.hidden ? "fas fa-eye" : "fas fa-eye-slash",
        label: edge.hidden ? L("Reveal") : L("Hide"),
        callback: () => this._updateEdge(edge.id, { hidden: !edge.hidden })
      },
      { icon: "fas fa-trash", label: L("Delete"), callback: () => this._deleteEdge(edge.id) }
    ]);
  }

  async _updateEdge(id, changes) {
    const map = getMap(canvas.scene);
    await saveMap(canvas.scene, { edges: map.edges.map(e => (e.id === id ? { ...e, ...changes } : e)) });
  }

  /** Delete a path, and every crossroad and path connected to it (never areas). */
  async _deleteEdge(id) {
    const map = getMap(canvas.scene);
    const doomed = pathNetwork(map, { edgeId: id });
    if ( !(await this._confirmCascade(doomed, { edges: 1 })) ) return;
    await saveMap(canvas.scene, {
      edges: map.edges.filter(e => !doomed.edges.has(e.id)),
      crossroads: map.crossroads.filter(c => !doomed.crossroads.has(c.id))
    });
  }

  _onTrackPointerDown(event, area, track) {
    event.stopPropagation();
    this.menu.close();
    if ( event.button === 0 ) return trackCheck(canvas.scene, area.id, track.id);
    if ( event.button !== 2 ) return;
    const L = key => game.i18n.localize(`WONDERMAPS.Menu.${key}`);
    this.menu.open({ x: event.clientX, y: event.clientY }, track.name || game.i18n.localize("WONDERMAPS.Track"), [
      { icon: "fas fa-dice-d20", label: L("RollTrack"), callback: () => trackCheck(canvas.scene, area.id, track.id) },
      { icon: "fas fa-pen-to-square", label: L("EditArea"), callback: () => new AreaConfig(canvas.scene, area.id).render(true) },
      { icon: "fas fa-clone", label: L("CopyTrack"), callback: () => copyTrackDialog(canvas.scene, area.id, track) },
      { icon: "fas fa-trash", label: L("Delete"), callback: () => this._deleteTrack(area.id, track.id) }
    ]);
  }

  async _deleteTrack(areaId, trackId) {
    const map = getMap(canvas.scene);
    const areas = map.areas.map(a => (a.id === areaId
      ? { ...a, tracks: (a.tracks ?? []).filter(t => t.id !== trackId) }
      : a));
    await saveMap(canvas.scene, { areas });
  }

  /* -------------------------------------------- */

  /** Centre the view on the active area. */
  panToActive({ animate=false }={}) {
    const map = this.map;
    const active = map?.areas.find(a => a.id === map.activeArea);
    if ( !active ) return;
    const p = this.toWorld(active);
    if ( animate ) return canvas.animatePan({ x: p.x, y: p.y, duration: 500 });
    return canvas.pan({ x: p.x, y: p.y });
  }
}
