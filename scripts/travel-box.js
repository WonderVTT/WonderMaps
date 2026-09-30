import { MODULE_ID } from "./constants.js";
import { Settings } from "./settings.js";
import { isWonderMap, partyMembers, actorForUser, formatDuration, formatMinutes } from "./data.js";
import { longRest, addExhaustion, passTime } from "./engine.js";
import { playerColors, placeBesideSidebar } from "./panel.js";

const TEMPLATE = `modules/${MODULE_ID}/templates/travel-box.hbs`;

/** Travelling longer than this since the last long rest shows in red. */
const TIRED_MINUTES = 8 * 60;

/**
 * Box at the bottom right, for everybody on a WonderMap scene: how long the
 * party has been exploring, and how long each character travelled since their
 * last long rest. Players see their own character; the GM sees the whole party
 * with buttons to mark a long rest or add a level of exhaustion.
 */
export class TravelBox {
  constructor() {
    this.element = null;
    this.render = foundry.utils.debounce(this._render.bind(this), 50);
    this.position = this.position.bind(this);
    window.addEventListener("resize", this.position);
  }

  get shouldShow() {
    return isWonderMap(canvas?.scene);
  }

  getData() {
    const isGM = game.user.isGM;
    const start = Settings.get("exploreStart");
    const elapsed = start >= 0 ? Math.max(0, game.time.worldTime - start) / 60 : 0;
    const travel = Settings.get("travel") ?? {};
    const party = partyMembers();
    const actors = isGM ? party : [actorForUser(game.user, party)].filter(a => a);
    const members = actors.map(actor => {
      const minutes = Number(travel[actor.id]) || 0;
      return {
        id: actor.id,
        name: actor.name,
        colors: playerColors(actor, party),
        travel: formatMinutes(minutes),
        tired: minutes > TIRED_MINUTES,
        exhaustion: foundry.utils.getProperty(actor, "system.attributes.exhaustion") || 0
      };
    });
    return { isGM, areaTime: formatDuration(elapsed), members };
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
    node.addEventListener("click", this._onClick.bind(this));
    this.position();
  }

  close() {
    this.element?.remove();
    this.element = null;
  }

  position() {
    placeBesideSidebar(this.element);
  }

  async _onClick(event) {
    const target = event.target.closest("[data-action]");
    if ( !target || !game.user.isGM ) return;
    event.preventDefault();
    const actorId = target.closest("[data-actor-id]")?.dataset.actorId;
    const all = partyMembers().map(a => a.id);
    const confirm = key => Dialog.confirm({
      title: game.i18n.localize(`WONDERMAPS.Travel.${key}`),
      content: `<p>${game.i18n.localize(`WONDERMAPS.Travel.${key}Confirm`)}</p>`
    });
    switch ( target.dataset.action ) {
      case "rest": return longRest([actorId]);
      case "exhaust": return addExhaustion([actorId]);
      case "rest-all": return (await confirm("RestAll")) && longRest(all);
      case "exhaust-all": return (await confirm("ExhaustAll")) && addExhaustion(all);
      case "add-hour": return passTime(60);
      case "add-rest": return passTime(8 * 60);
      case "add-custom": return this._customTime();
    }
  }

  /** Dialog to let any amount of time pass, optionally counting it as travel. */
  async _customTime() {
    const L = key => game.i18n.localize(`WONDERMAPS.Travel.${key}`);
    const content = `
      <form class="wondermaps-time">
        <div class="form-group">
          <label>${L("Days")}</label>
          <input type="number" name="days" value="0" min="0" step="1">
        </div>
        <div class="form-group">
          <label>${game.i18n.localize("WONDERMAPS.Fields.Hours")}</label>
          <input type="number" name="hours" value="0" min="0" step="1">
        </div>
        <div class="form-group">
          <label>${game.i18n.localize("WONDERMAPS.Fields.Minutes")}</label>
          <input type="number" name="minutes" value="0" min="0" step="1">
        </div>
        <div class="form-group">
          <label>${L("CountAsTravel")}</label>
          <input type="checkbox" name="travel">
          <p class="hint">${L("CountAsTravelHint")}</p>
        </div>
      </form>`;
    const result = await Dialog.prompt({
      title: L("AddCustom"),
      content,
      label: L("PassTime"),
      rejectClose: false,
      callback: html => {
        const root = html[0] ?? html;
        const num = name => Math.max(0, Number(root.querySelector(`[name="${name}"]`).value) || 0);
        return {
          minutes: (num("days") * 1440) + (num("hours") * 60) + num("minutes"),
          travel: root.querySelector("[name=travel]").checked
        };
      }
    });
    if ( result?.minutes > 0 ) return passTime(result.minutes, { travel: result.travel });
  }
}
