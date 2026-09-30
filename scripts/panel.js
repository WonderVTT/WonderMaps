import { MODULE_ID } from "./constants.js";
import { Settings } from "./settings.js";
import { isWonderMap, partyMembers, getMap, playersOf } from "./data.js";
import { resetRotation, resetAll, setDefaultSizes, toggleAlwaysNorth } from "./engine.js";

const TEMPLATE = `modules/${MODULE_ID}/templates/party-panel.hbs`;

/** Colours of the players who play this party actor (as used for their arrows). */
export function playerColors(actor, party=partyMembers()) {
  return playersOf(party)
    .filter(p => p.actor === actor)
    .map(p => Color.from(p.user.color ?? "#ffffff").css);
}

/** Keep a floating box just left of the sidebar, whether it is expanded or collapsed. */
export function placeBesideSidebar(element) {
  if ( !element ) return;
  const sidebar = document.getElementById("sidebar");
  const width = sidebar ? sidebar.getBoundingClientRect().width : 300;
  element.style.right = `${Math.round(width) + 16}px`;
}

/**
 * GM-only panel at the top right of the screen, next to the sidebar.
 * It holds the party (actors dragged in from the Actors tab), each member's
 * last Survival and Intelligence results, the DC controls and the turn counter.
 */
export class PartyPanel {
  constructor() {
    this.element = null;
    this.render = foundry.utils.debounce(this._render.bind(this), 50);
    this.position = this.position.bind(this);
    window.addEventListener("resize", this.position);
  }

  get shouldShow() {
    return game.user.isGM && isWonderMap(canvas?.scene);
  }

  getData() {
    const results = Settings.get("partyResults") ?? {};
    const L = key => game.i18n.localize(`WONDERMAPS.Panel.${key}`);
    const describe = (r, label) => {
      if ( !r ) return { text: "–", cls: "none", tooltip: `${label}: ${L("NoRoll")}` };
      const outcome = r.success ? L("Passed") : L("Failed");
      return {
        text: r.total,
        cls: r.success ? "success" : "failure",
        tooltip: `${label} ${r.total} vs ${game.i18n.localize("WONDERMAPS.Chat.DC")} ${r.dc}: ${outcome}`
      };
    };
    const party = partyMembers();
    const alwaysNorth = new Set(Settings.get("alwaysNorth") ?? []);
    const members = party.map(actor => ({
      id: actor.id,
      colors: playerColors(actor, party),
      alwaysNorth: alwaysNorth.has(actor.id),
      name: actor.name,
      img: actor.img,
      owners: game.users.filter(u => !u.isGM && actor.testUserPermission(u, "OWNER")).map(u => u.name).join(", "),
      survival: describe(results[actor.id]?.survival, game.i18n.localize("WONDERMAPS.Chat.Survival")),
      intelligence: describe(results[actor.id]?.intelligence, game.i18n.localize("WONDERMAPS.Chat.Intelligence"))
    }));
    const base = Settings.get("baseSurvivalDC");
    return {
      members,
      collapsed: Settings.get("panelCollapsed"),
      survivalDC: Settings.get("survivalDC"),
      intelligenceDC: Settings.get("intelligenceDC"),
      turns: Settings.get("turns") ?? 0,
      defaults: getMap(canvas.scene).defaults,
      survivalResetTooltip: game.i18n.format("WONDERMAPS.DC.Reset", { base })
    };
  }

  async _render() {
    if ( !this.shouldShow ) return this.close();
    const html = await renderTemplate(TEMPLATE, this.getData());
    const wrapper = document.createElement("div");
    wrapper.innerHTML = html.trim();
    const node = wrapper.firstElementChild;
    if ( this.element?.isConnected ) this.element.replaceWith(node);
    else document.body.append(node);
    this.element = node;
    this._activateListeners(node);
    this.position();
  }

  close() {
    this.element?.remove();
    this.element = null;
  }

  /** Sit just left of the sidebar, whether it is expanded or collapsed. */
  position() {
    placeBesideSidebar(this.element);
  }

  /* -------------------------------------------- */

  _activateListeners(el) {
    el.addEventListener("click", this._onClick.bind(this));
    for ( const input of el.querySelectorAll("input[type=number]") ) {
      input.addEventListener("change", this._onChangeInput.bind(this));
    }
    el.addEventListener("dragover", event => {
      event.preventDefault();
      el.classList.add("drag-over");
    });
    el.addEventListener("dragleave", event => {
      if ( !el.contains(event.relatedTarget) ) el.classList.remove("drag-over");
    });
    el.addEventListener("drop", this._onDrop.bind(this));
  }

  async _onClick(event) {
    const target = event.target.closest("[data-action]");
    if ( !target ) return;
    event.preventDefault();
    const survival = Settings.get("survivalDC");
    const intelligence = Settings.get("intelligenceDC");
    switch ( target.dataset.action ) {
      case "toggle":
        await Settings.set("panelCollapsed", !Settings.get("panelCollapsed"));
        return this.render();
      case "remove":
        return this._removeMember(target.closest("[data-actor-id]")?.dataset.actorId);
      case "north":
        return toggleAlwaysNorth(target.closest("[data-actor-id]")?.dataset.actorId, canvas.scene);
      case "survival-down": return Settings.set("survivalDC", survival - 1);
      case "survival-up": return Settings.set("survivalDC", survival + 1);
      case "survival-reset": return Settings.set("survivalDC", Settings.get("baseSurvivalDC"));
      case "int-down": return Settings.set("intelligenceDC", intelligence - 1);
      case "int-up": return Settings.set("intelligenceDC", intelligence + 1);
      case "turns-reset": {
        const ok = await Dialog.confirm({
          title: game.i18n.localize("WONDERMAPS.Panel.ResetTurns"),
          content: `<p>${game.i18n.localize("WONDERMAPS.Panel.ResetTurnsConfirm")}</p>`
        });
        if ( ok ) return Settings.set("turns", 0);
      }
      case "reset-rotation": {
        const ok = await this._confirm("ResetRotation", "ResetRotationConfirm");
        if ( ok ) return resetRotation(canvas.scene);
        return;
      }
      case "reset-all": {
        const ok = await this._confirm("ResetAll", "ResetAllConfirm", { base: Settings.get("baseSurvivalDC") });
        if ( ok ) return resetAll(canvas.scene);
      }
    }
  }

  _confirm(titleKey, contentKey, data={}) {
    return Dialog.confirm({
      title: game.i18n.localize(`WONDERMAPS.Panel.${titleKey}`),
      content: `<p>${game.i18n.format(`WONDERMAPS.Panel.${contentKey}`, data)}</p>`
    });
  }

  async _onChangeInput(event) {
    const { name } = event.currentTarget;
    const value = Math.round(Number(event.currentTarget.value));
    if ( !Number.isFinite(value) ) return this.render();
    // Default sizes belong to the current map, the rest are world settings.
    if ( (name === "areaRadius") || (name === "crossroadSize") ) {
      await setDefaultSizes(canvas.scene, { [name]: value });
      return this.render();
    }
    return Settings.set(name, value);
  }

  async _onDrop(event) {
    event.preventDefault();
    this.element?.classList.remove("drag-over");
    const data = TextEditor.getDragEventData(event);
    let actors = [];
    if ( data?.type === "Actor" ) {
      const actor = data.uuid ? await fromUuid(data.uuid) : game.actors.get(data.id);
      if ( actor ) actors.push(actor);
    }
    else if ( data?.type === "Folder" ) {
      const folder = await fromUuid(data.uuid);
      if ( folder?.type === "Actor" ) actors = folder.contents;
    }
    // Only world actors: tokens and compendium entries have no stable world id.
    actors = actors.filter(a => (a instanceof Actor) && !a.pack && !a.isToken && game.actors.has(a.id));
    if ( !actors.length ) {
      if ( data?.type ) ui.notifications.warn(game.i18n.localize("WONDERMAPS.Panel.OnlyActors"));
      return;
    }
    const party = [...(Settings.get("party") ?? [])];
    for ( const actor of actors ) if ( !party.includes(actor.id) ) party.push(actor.id);
    return Settings.set("party", party);
  }

  async _removeMember(actorId) {
    const actor = game.actors.get(actorId);
    const name = actor?.name ?? actorId;
    const ok = await Dialog.confirm({
      title: game.i18n.localize("WONDERMAPS.Panel.Remove"),
      content: `<p>${game.i18n.format("WONDERMAPS.Panel.RemoveConfirm", { name: Handlebars.escapeExpression(name) })}</p>`
    });
    if ( !ok ) return;
    await Settings.set("party", (Settings.get("party") ?? []).filter(id => id !== actorId));
    const results = foundry.utils.deepClone(Settings.get("partyResults") ?? {});
    if ( actorId in results ) {
      delete results[actorId];
      await Settings.set("partyResults", results);
    }
  }
}
