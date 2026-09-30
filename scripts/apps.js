import { MODULE_ID, AREA_DEFAULTS, CROSSROAD_DEFAULTS, TRACK_DEFAULTS } from "./constants.js";
import { Settings } from "./settings.js";
import { getMap, saveMap } from "./data.js";

/**
 * Configuration sheet for a single area: image, frame, roll table and tracks.
 */
export class AreaConfig extends FormApplication {
  constructor(scene, areaId, options={}) {
    super({}, options);
    this.scene = scene;
    this.areaId = areaId;
    const area = getMap(scene).areas.find(a => a.id === areaId) ?? {};
    /** Working copy, so that adding/removing tracks survives re-renders. */
    this.area = foundry.utils.mergeObject(foundry.utils.deepClone(AREA_DEFAULTS), area);
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["wondermaps", "sheet"],
      template: `modules/${MODULE_ID}/templates/area-config.hbs`,
      width: 520,
      height: "auto",
      closeOnSubmit: true,
      submitOnChange: false
    });
  }

  get id() {
    return `wondermaps-area-${this.areaId}`;
  }

  get title() {
    return `${game.i18n.localize("WONDERMAPS.AreaConfig")}: ${this.area.name || game.i18n.localize("WONDERMAPS.Area")}`;
  }

  getData() {
    const tables = {};
    for ( const t of game.tables ) tables[t.uuid] = t.name;
    // Keep a table from a compendium selectable if it was set by uuid.
    if ( this.area.table && !(this.area.table in tables) ) tables[this.area.table] = this.area.table;
    const scenes = {};
    for ( const s of game.scenes ) if ( s.id !== this.scene.id ) scenes[s.id] = s.name;
    return {
      area: this.area,
      tables,
      scenes,
      survivalFormula: Settings.get("survivalFormula")
    };
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find(".track-add").on("click", this._onAddTrack.bind(this));
    html.find(".track-delete").on("click", this._onDeleteTrack.bind(this));
    html.find(".track-copy").on("click", this._onCopyTrack.bind(this));
    // Show a newly picked track icon straight away.
    html.find(".track file-picker").on("change", event => {
      const img = event.currentTarget.closest(".track")?.querySelector(".track-icon");
      if ( img ) img.src = event.currentTarget.value;
    });
  }

  /** Copy the current form values into the working copy without saving. */
  _syncFromForm() {
    const data = foundry.utils.expandObject(this._getSubmitData());
    this.area = this._merge(data);
  }

  _merge(data) {
    const tracks = Object.values(data.tracks ?? {}).map(t => ({
      id: t.id || foundry.utils.randomID(),
      name: t.name ?? "",
      dc: Number.isFinite(t.dc) ? t.dc : null,
      formula: t.formula ?? "",
      img: t.img ?? ""
    }));
    delete data.tracks;
    const area = foundry.utils.mergeObject(foundry.utils.deepClone(this.area), data);
    area.tracks = tracks;
    area.radius = Math.max(20, Number(area.radius) || AREA_DEFAULTS.radius);
    area.frameWidth = Math.max(0, Number(area.frameWidth) || 0);
    area.landmark = !!area.landmark;
    area.hidden = !!area.hidden;
    return area;
  }

  async _onAddTrack(event) {
    event.preventDefault();
    this._syncFromForm();
    this.area.tracks.push({ ...TRACK_DEFAULTS, id: foundry.utils.randomID() });
    this.render();
  }

  async _onDeleteTrack(event) {
    event.preventDefault();
    const index = Number(event.currentTarget.dataset.index);
    this._syncFromForm();
    this.area.tracks.splice(index, 1);
    this.render();
  }

  /** Copy a track (as currently typed in the form) into other areas. */
  async _onCopyTrack(event) {
    event.preventDefault();
    const index = Number(event.currentTarget.dataset.index);
    this._syncFromForm();
    const track = this.area.tracks[index];
    if ( track ) await copyTrackDialog(this.scene, this.areaId, track);
  }

  async _updateObject(event, formData) {
    const area = this._merge(foundry.utils.expandObject(formData));
    const map = getMap(this.scene);
    if ( !map.areas.some(a => a.id === this.areaId) ) return;
    await saveMap(this.scene, { areas: map.areas.map(a => (a.id === this.areaId ? { ...a, ...area, id: a.id, x: a.x, y: a.y } : a)) });
  }
}

/**
 * Small dialog to edit a crossroad's name, survival DC and size.
 */
export async function editCrossroad(scene, crossroadId) {
  const cross = getMap(scene).crossroads.find(c => c.id === crossroadId);
  if ( !cross ) return;
  const esc = s => Handlebars.escapeExpression(s);
  const L = key => game.i18n.localize(`WONDERMAPS.Fields.${key}`);
  const content = `
    <form class="wondermaps-crossroad">
      <div class="form-group">
        <label>${L("Name")}</label>
        <input type="text" name="name" value="${esc(cross.name ?? "")}">
      </div>
      <div class="form-group">
        <label>${L("SurvivalDC")}</label>
        <input type="number" name="dc" value="${cross.dc ?? CROSSROAD_DEFAULTS.dc}" step="1">
      </div>
      <div class="form-group">
        <label>${L("Size")}</label>
        <input type="number" name="size" value="${cross.size ?? CROSSROAD_DEFAULTS.size}" min="10" step="1">
      </div>
    </form>`;
  const result = await Dialog.prompt({
    title: game.i18n.localize("WONDERMAPS.CrossroadConfig"),
    content,
    label: game.i18n.localize("WONDERMAPS.Save"),
    rejectClose: false,
    callback: html => {
      const value = name => html[0].querySelector(`[name="${name}"]`).value;
      return {
        name: value("name"),
        dc: Number(value("dc")) || 0,
        size: Math.max(10, Number(value("size")) || CROSSROAD_DEFAULTS.size)
      };
    }
  });
  if ( !result ) return;
  const map = getMap(scene);
  await saveMap(scene, { crossroads: map.crossroads.map(c => (c.id === crossroadId ? { ...c, ...result } : c)) });
}

/**
 * Small dialog to set how long it takes to walk a path.
 * The time is stored in minutes on the path.
 */
export async function editEdgeTime(scene, edgeId) {
  const edge = getMap(scene).edges.find(e => e.id === edgeId);
  if ( !edge ) return;
  const total = Math.max(0, Math.round(Number(edge.time) || 0));
  const L = key => game.i18n.localize(`WONDERMAPS.Fields.${key}`);
  const content = `
    <form class="wondermaps-travel">
      <p class="notes">${L("TravelTimeHint")}</p>
      <div class="form-group">
        <label>${L("Hours")}</label>
        <input type="number" name="hours" value="${Math.floor(total / 60)}" min="0" step="1">
      </div>
      <div class="form-group">
        <label>${L("Minutes")}</label>
        <input type="number" name="minutes" value="${total % 60}" min="0" step="1">
      </div>
    </form>`;
  const minutes = await Dialog.prompt({
    title: game.i18n.localize("WONDERMAPS.Menu.TravelTime"),
    content,
    label: game.i18n.localize("WONDERMAPS.Save"),
    rejectClose: false,
    callback: html => {
      const value = name => Math.max(0, Number(html[0].querySelector(`[name="${name}"]`).value) || 0);
      return Math.round((value("hours") * 60) + value("minutes"));
    }
  });
  if ( minutes == null ) return;
  const map = getMap(scene);
  await saveMap(scene, { edges: map.edges.map(e => (e.id === edgeId ? { ...e, time: minutes } : e)) });
}

/**
 * Copy a track into other areas of the same map, each with its own DC.
 * @param {Scene} scene
 * @param {string} sourceAreaId   The area the track comes from (not listed).
 * @param {object} track          The track to copy (name, img, formula, dc).
 */
export async function copyTrackDialog(scene, sourceAreaId, track) {
  const map = getMap(scene);
  const targets = map.areas.filter(a => a.id !== sourceAreaId);
  if ( !targets.length ) return ui.notifications.info(game.i18n.localize("WONDERMAPS.CopyTrack.NoAreas"));
  const esc = s => Handlebars.escapeExpression(s);
  const L = key => game.i18n.localize(`WONDERMAPS.CopyTrack.${key}`);
  const trackName = track.name || game.i18n.localize("WONDERMAPS.Track");
  const rows = targets.map(a => {
    const has = (a.tracks ?? []).some(t => t.name && (t.name === track.name));
    return `<tr>
      <td><input type="checkbox" name="area" value="${a.id}"></td>
      <td>${esc(a.name || game.i18n.localize("WONDERMAPS.Area"))}${has ? ` <em class="notes">(${L("AlreadyHas")})</em>` : ""}</td>
      <td><input type="number" name="dc-${a.id}" value="${track.dc ?? ""}" step="1"></td>
    </tr>`;
  }).join("");
  const content = `
    <form class="wondermaps-copy-track">
      <p>${game.i18n.format("WONDERMAPS.CopyTrack.Hint", { name: esc(trackName) })}</p>
      <table>
        <thead><tr><th><input type="checkbox" class="all"></th><th>${game.i18n.localize("WONDERMAPS.Area")}</th><th>${game.i18n.localize("WONDERMAPS.Fields.DC")}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </form>`;

  const picks = await Dialog.prompt({
    title: `${L("Title")}: ${trackName}`,
    content,
    label: L("Copy"),
    rejectClose: false,
    render: html => {
      const root = html[0] ?? html;
      root.querySelector("input.all")?.addEventListener("change", event => {
        for ( const box of root.querySelectorAll("input[name=area]") ) box.checked = event.currentTarget.checked;
      });
    },
    callback: html => {
      const root = html[0] ?? html;
      return [...root.querySelectorAll("input[name=area]:checked")].map(box => {
        const raw = root.querySelector(`input[name="dc-${box.value}"]`).value;
        return { areaId: box.value, dc: raw === "" ? null : Number(raw) };
      });
    }
  });
  if ( !picks?.length ) return;

  const fresh = getMap(scene);
  const byArea = new Map(picks.map(p => [p.areaId, p.dc]));
  const areas = fresh.areas.map(a => {
    if ( !byArea.has(a.id) ) return a;
    const copy = {
      id: foundry.utils.randomID(),
      name: track.name ?? "",
      img: track.img ?? "",
      formula: track.formula ?? "",
      dc: byArea.get(a.id)
    };
    return { ...a, tracks: [...(a.tracks ?? []), copy] };
  });
  await saveMap(scene, { areas });
  ui.notifications.info(game.i18n.format("WONDERMAPS.CopyTrack.Done", { name: trackName, n: picks.length }));
}
