import { MODULE_ID, LAYER_NAME } from "./constants.js";
import { Settings, registerSettings } from "./settings.js";
import { isWonderMap } from "./data.js";
import { WonderMapsLayer } from "./layer.js";
import { walkTo, crossroadCheck, trackCheck, resetJourney, survivalDCDialog } from "./engine.js";
import { blackout } from "./transition.js";
import { PartyPanel } from "./panel.js";
import { TravelBox } from "./travel-box.js";
import { longRest } from "./engine.js";

/**
 * WonderMaps — a gridless exploration scene made of areas, paths and crossroads.
 *
 * A WonderMap is an ordinary Scene flagged with `flags.wondermaps.enabled`. The
 * map itself lives in the scene flags and is drawn by WonderMapsLayer. Only GM
 * clients ever write to it; every client redraws from the flags.
 */

/** Scene fields whose change makes core redraw the whole canvas. */
const CORE_REDRAW = [
  "foreground", "fog.overlay", "width", "height", "padding",
  "grid.type", "grid.size", "grid.distance", "grid.units", "background.src"
];

const layer = () => canvas?.[LAYER_NAME];

/** GM-only party panel, created on ready. */
let panel = null;
/** Travel box (bottom right), for everybody, created on ready. */
let travelBox = null;

Hooks.once("init", () => {
  registerSettings(() => {
    if ( game.user?.isGM ) ui.controls?.initialize();
    panel?.render();
    travelBox?.render();
  });

  CONFIG.Canvas.layers[LAYER_NAME] = { layerClass: WonderMapsLayer, group: "interface" };
  unlockZoom();

  loadTemplates([
    `modules/${MODULE_ID}/templates/area-config.hbs`,
    `modules/${MODULE_ID}/templates/party-panel.hbs`,
    `modules/${MODULE_ID}/templates/travel-box.hbs`
  ]);

  game.modules.get(MODULE_ID).api = {
    walkTo, crossroadCheck, trackCheck, resetJourney, survivalDCDialog, isWonderMap, createScene
  };
});

/** Smallest zoom allowed on a WonderMap (core stops where the whole scene fits the window). */
const WONDERMAP_MIN_ZOOM = 0.05;

/**
 * On WonderMap scenes, let the view zoom out past the "whole scene fits the
 * window" limit, and let it pan anywhere around what is on the map instead of
 * the scene rectangle: the bounds follow the areas and crossroads the user can
 * see, so they grow as the GM places things further out and follow the map
 * when it rotates. Other scenes keep core behaviour.
 */
function unlockZoom() {
  const original = Canvas.prototype._constrainView;
  Canvas.prototype._constrainView = function(view) {
    if ( !isWonderMap(this.scene) ) return original.call(this, view);
    let { x, y, scale } = view;
    if ( !Number.isNumeric(x) ) x = this.stage.pivot.x;
    if ( !Number.isNumeric(y) ) y = this.stage.pivot.y;
    if ( !Number.isNumeric(scale) ) scale = this.stage.scale.x;
    scale = Math.clamp(scale, WONDERMAP_MIN_ZOOM, CONFIG.Canvas.maxZoom);
    // An empty map falls back to the scene rectangle.
    const d = this.dimensions;
    const bounds = layer()?.contentBounds() ?? new PIXI.Rectangle(d.sceneX, d.sceneY, d.sceneWidth, d.sceneHeight);
    // Allow panning a full screen past every edge of the content.
    const padX = window.innerWidth / scale;
    const padY = window.innerHeight / scale;
    x = Math.clamp(x, bounds.left - padX, bounds.right + padX);
    y = Math.clamp(y, bounds.top - padY, bounds.bottom + padY);
    return { x, y, scale };
  };
}

/* -------------------------------------------- */
/*  Scene controls                              */
/* -------------------------------------------- */

Hooks.on("getSceneControlButtons", controls => {
  if ( !game.user.isGM ) return;
  const L = key => `WONDERMAPS.Controls.${key}`;
  controls.push({
    name: LAYER_NAME,
    title: L("Title"),
    icon: "fas fa-compass",
    layer: LAYER_NAME,
    visible: isWonderMap(canvas?.scene),
    activeTool: "select",
    tools: [
      { name: "select", title: L("Select"), icon: "fas fa-expand" },
      { name: "area", title: L("Area"), icon: "far fa-circle" },
      { name: "crossroad", title: L("Crossroad"), icon: "fas fa-hexagon" },
      { name: "connect", title: L("Connect"), icon: "fas fa-bezier-curve" },
      {
        name: "survivalDC",
        title: game.i18n.format("WONDERMAPS.Controls.SurvivalDC", { dc: Settings.get("survivalDC") }),
        icon: "fas fa-dice-d20",
        button: true,
        onClick: () => survivalDCDialog()
      },
      {
        name: "reset",
        title: L("Reset"),
        icon: "fas fa-route",
        button: true,
        onClick: async () => {
          const ok = await Dialog.confirm({
            title: game.i18n.localize("WONDERMAPS.Controls.Reset"),
            content: `<p>${game.i18n.localize("WONDERMAPS.Controls.ResetConfirm")}</p>`
          });
          if ( ok ) resetJourney(canvas.scene);
        }
      }
    ]
  });
});

/* -------------------------------------------- */
/*  Canvas lifecycle                            */
/* -------------------------------------------- */

Hooks.once("ready", () => {
  travelBox = new TravelBox();
  travelBox.render();
  if ( !game.user.isGM ) return;
  panel = new PartyPanel();
  panel.render();
});

// Keep the boxes in sync with the actors they show, the clock and the sidebar width.
for ( const hook of ["updateActor", "deleteActor", "updateUser"] ) {
  Hooks.on(hook, () => {
    panel?.render();
    travelBox?.render();
  });
}
Hooks.on("updateWorldTime", () => travelBox?.render());

// Branch votes (players) and highlights (GM) live in user flags: redraw the badges.
Hooks.on("updateUser", (user, changes) => {
  const l = layer();
  if ( changes.flags?.[MODULE_ID] && l?.map ) l._drawBranches(l.map);
});
Hooks.on("collapseSidebar", () => {
  // The sidebar animates its width; follow it and settle at the end.
  for ( const delay of [0, 150, 400] ) {
    window.setTimeout(() => {
      panel?.position();
      travelBox?.position();
    }, delay);
  }
});

// A long rest taken on a D&D 5e character sheet also resets its travel counter.
// Only a GM may write the counters, so players forward it over the socket.
const SOCKET = `module.${MODULE_ID}`;
Hooks.on("dnd5e.restCompleted", (actor, result) => {
  if ( !result?.longRest || !actor?.id || actor.isToken ) return;
  if ( game.user.isGM ) longRest([actor.id]);
  else game.socket.emit(SOCKET, { type: "longRest", actorId: actor.id });
});
// Players' long rests also reach the GM as dnd5e "rest" chat cards. This works
// even before the world has been relaunched with the module socket enabled.
Hooks.on("createChatMessage", message => {
  if ( game.users.activeGM !== game.user ) return;
  if ( (message.type !== "rest") || (message.system?.type !== "long") ) return;
  const actorId = message.speaker?.actor;
  if ( actorId && game.actors.has(actorId) ) longRest([actorId]);
});

Hooks.once("ready", () => {
  game.socket.on(SOCKET, data => {
    // Only the first active GM handles it, so it is not applied twice.
    if ( (data?.type !== "longRest") || (game.users.activeGM !== game.user) ) return;
    if ( game.actors.has(data.actorId) ) longRest([data.actorId]);
  });
});

Hooks.on("canvasReady", () => {
  panel?.render();
  travelBox?.render();
  if ( !isWonderMap(canvas.scene) ) return;
  const l = layer();
  if ( game.user.isGM ) l.activate();
  l.panToActive();
});

Hooks.on("updateScene", (scene, changes) => {
  if ( scene !== canvas.scene ) return;
  if ( changes.flags?.[MODULE_ID]?.defaults ) panel?.render();
  const flags = changes.flags?.[MODULE_ID];
  const changedKeys = Object.keys(foundry.utils.flattenObject(changes));
  // Core already redraws the canvas for these; our layer is redrawn with it.
  if ( CORE_REDRAW.some(k => changedKeys.includes(k)) || ("background" in changes) ) return;
  if ( !flags ) return;

  const l = layer();
  if ( !l ) return;
  if ( ("enabled" in flags) && (!!flags.enabled !== l.drawnEnabled) ) {
    canvas.draw();
    return;
  }
  if ( "transition" in flags ) {
    blackout(async () => {
      await l.refresh();
      l.panToActive();
    });
    return;
  }
  l.refresh();
});

/* -------------------------------------------- */
/*  Scene creation & configuration              */
/* -------------------------------------------- */

/** Scene settings every WonderMap needs. */
function wonderMapSceneData() {
  return {
    grid: { type: CONST.GRID_TYPES.GRIDLESS },
    tokenVision: false,
    fog: { exploration: false }
  };
}

/** Create a new, empty WonderMap scene and open its configuration. */
async function createScene() {
  const scene = await Scene.create(foundry.utils.mergeObject({
    name: game.i18n.localize("WONDERMAPS.NewScene"),
    width: 4000,
    height: 3000,
    padding: 0.1,
    backgroundColor: "#000000",
    flags: {
      [MODULE_ID]: {
        enabled: true, areas: [], crossroads: [], edges: [],
        activeArea: null, rotation: 0, visited: [], checks: [], transition: 0
      }
    }
  }, wonderMapSceneData()));
  scene?.sheet.render(true);
  return scene;
}

// Turning a scene into a WonderMap makes it gridless and switches off vision.
Hooks.on("preUpdateScene", (scene, changes) => {
  const enabling = foundry.utils.getProperty(changes, `flags.${MODULE_ID}.enabled`);
  if ( enabling === true ) foundry.utils.mergeObject(changes, wonderMapSceneData());
});

Hooks.on("renderSceneConfig", (app, html) => {
  const root = html[0] ?? html;
  const tab = root.querySelector('.tab[data-tab="basic"]');
  if ( !tab || tab.querySelector(".wondermaps-scene") ) return;
  const enabled = isWonderMap(app.document);
  const fieldset = document.createElement("fieldset");
  fieldset.classList.add("wondermaps-scene");
  fieldset.innerHTML = `
    <legend><i class="fas fa-compass"></i> WonderMaps</legend>
    <div class="form-group">
      <label>${game.i18n.localize("WONDERMAPS.SceneConfig.Enable")}</label>
      <div class="form-fields">
        <input type="checkbox" name="flags.${MODULE_ID}.enabled" data-dtype="Boolean" ${enabled ? "checked" : ""}>
      </div>
      <p class="hint">${game.i18n.localize("WONDERMAPS.SceneConfig.EnableHint")}</p>
    </div>`;
  const nameGroup = tab.querySelector('input[name="name"]')?.closest(".form-group");
  if ( nameGroup ) nameGroup.after(fieldset);
  else tab.prepend(fieldset);
  app.setPosition({ height: "auto" });
});

/** Compass icon in front of the names of WonderMap scenes. */
function markWonderMapNames(root, itemSelector, idAttribute, nameSelector) {
  for ( const li of root.querySelectorAll(itemSelector) ) {
    const scene = game.scenes.get(li.dataset[idAttribute]);
    const name = li.querySelector(nameSelector);
    if ( !name || !isWonderMap(scene) || name.querySelector(".wondermaps-scene-icon") ) continue;
    const icon = document.createElement("i");
    icon.className = "fas fa-compass wondermaps-scene-icon";
    icon.dataset.tooltip = "WonderMap";
    name.prepend(icon);
  }
}

Hooks.on("renderSceneNavigation", (app, html) => {
  markWonderMapNames(html[0] ?? html, "li.scene[data-scene-id]", "sceneId", ".scene-name");
});

Hooks.on("renderSceneDirectory", (app, html) => {
  const root = html[0] ?? html;
  markWonderMapNames(root, "li.directory-item[data-document-id]", "documentId", ".document-name a");
  if ( !game.user.isGM ) return;
  const actions = root.querySelector(".header-actions");
  if ( !actions || actions.querySelector(".wondermaps-create") ) return;
  const button = document.createElement("button");
  button.type = "button";
  button.classList.add("wondermaps-create");
  button.innerHTML = `<i class="fas fa-compass"></i> ${game.i18n.localize("WONDERMAPS.CreateScene")}`;
  button.addEventListener("click", event => {
    event.preventDefault();
    createScene();
  });
  actions.append(button);
});
