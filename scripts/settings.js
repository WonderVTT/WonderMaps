import { MODULE_ID } from "./constants.js";

/**
 * Thin wrapper around game.settings for this module.
 */
export const Settings = {
  get(key) {
    return game.settings.get(MODULE_ID, key);
  },
  set(key, value) {
    return game.settings.set(MODULE_ID, key, value);
  }
};

/**
 * Register every module setting.
 * @param {Function} onPartyChange   Called whenever the party, its results, the DCs or the turns change.
 */
export function registerSettings(onPartyChange) {
  const reg = (key, data) => game.settings.register(MODULE_ID, key, {
    name: `WONDERMAPS.Settings.${key}.Name`,
    hint: `WONDERMAPS.Settings.${key}.Hint`,
    scope: "world",
    config: true,
    ...data
  });

  reg("baseSurvivalDC", { type: Number, default: 6 });

  // The running survival DC. It grows by one after every area activation and is
  // world-scoped so it persists across scene changes.
  reg("survivalDC", { type: Number, default: 6, config: false, onChange: onPartyChange });

  reg("intelligenceDC", { type: Number, default: 15, onChange: onPartyChange });

  // The party: ids of the world actors the checks are rolled for.
  reg("party", { type: Array, default: [], config: false, onChange: onPartyChange });
  // Last check results per actor: {actorId: {survival: {total, dc, success}, intelligence: {...}}}.
  reg("partyResults", { type: Object, default: {}, config: false, onChange: onPartyChange });
  // Number of area changes ("turns") since the GM last reset the counter.
  reg("turns", { type: Number, default: 0, config: false, onChange: onPartyChange });
  // Party actors who always know where north is, whatever their Survival check.
  reg("alwaysNorth", { type: Array, default: [], config: false, onChange: onPartyChange });
  // Minutes travelled per actor since their last long rest: {actorId: minutes}.
  reg("travel", { type: Object, default: {}, config: false, onChange: onPartyChange });
  // World time (seconds) when the exploration started; -1 = not started yet.
  reg("exploreStart", { type: Number, default: -1, config: false, onChange: onPartyChange });
  // Whether the GM party panel is collapsed on this client.
  reg("panelCollapsed", { type: Boolean, default: false, config: false, scope: "client" });
  reg("survivalFormula", { type: String, default: "1d20 + @skills.sur.total" });
  reg("intelligenceFormula", { type: String, default: "1d20 + @abilities.int.mod" });
  reg("randomRotation", { type: Boolean, default: true });
  reg("blackoutDuration", {
    type: Number,
    default: 800,
    range: { min: 100, max: 3000, step: 100 }
  });
}
