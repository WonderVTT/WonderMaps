import { MODULE_ID, MIN_WRONG_ANGLE } from "./constants.js";
import { Settings } from "./settings.js";
import { getMap, saveMap, partyMembers, playersOf, findRoutes, findNode, formatMinutes } from "./data.js";

/**
 * GM-side game logic: blind checks, area activation, crossroads and tracks.
 * Every function in here must only ever run on a GM client.
 */

const TAU = Math.PI * 2;

/**
 * Roll a formula for an actor. Missing roll data resolves to 0 so the default
 * dnd5e formulas degrade gracefully on other systems.
 * @returns {Promise<Roll>}
 */
async function rollFor(actor, formula) {
  const data = actor?.getRollData?.() ?? {};
  const resolved = Roll.replaceFormulaData(formula, data, { missing: "0", warn: false });
  try {
    return await new Roll(resolved).evaluate();
  } catch(err) {
    console.error(`${MODULE_ID} | Invalid formula "${formula}"`, err);
    ui.notifications.error(game.i18n.format("WONDERMAPS.Errors.BadFormula", { formula }));
    return new Roll("1d20").evaluate();
  }
}

/**
 * Roll a check against a DC for every party member.
 * @param {string} formula
 * @param {number} dc
 * @returns {Promise<Array<{actor: Actor, roll: Roll, success: boolean}>>}
 */
async function rollParty(formula, dc) {
  const results = [];
  for ( const actor of partyMembers() ) {
    const roll = await rollFor(actor, formula);
    results.push({ actor, roll, success: roll.total >= dc });
  }
  return results;
}

/**
 * Remember the last result of a check for each actor, for the party panel.
 * @param {"survival"|"intelligence"} key
 * @param {number} dc
 * @param {Array<{actor: Actor, roll: Roll, success: boolean}>} results
 */
async function recordResults(key, dc, results) {
  const all = foundry.utils.deepClone(Settings.get("partyResults") ?? {});
  for ( const r of results ) {
    all[r.actor.id] ??= {};
    all[r.actor.id][key] = { total: r.roll.total, dc, success: r.success };
  }
  return Settings.set("partyResults", all);
}

/** Names of the non-GM users who own an actor, for the chat card. */
function ownerNames(actor) {
  return game.users.filter(u => !u.isGM && actor.testUserPermission(u, "OWNER")).map(u => u.name).join(", ");
}

/**
 * Whisper a blind summary of one or more checks to the GMs.
 * @param {string} title
 * @param {Array<{label: string, dc: number, results: object[]}>} checks
 * @param {string} [footer]
 */
async function postSummary(title, checks, footer="") {
  const esc = s => Handlebars.escapeExpression(s);
  const users = new Map();
  for ( const check of checks ) {
    for ( const r of check.results ) {
      if ( !users.has(r.actor.id) ) users.set(r.actor.id, { actor: r.actor, cells: [] });
    }
  }
  for ( const row of users.values() ) {
    row.cells = checks.map(c => c.results.find(r => r.actor.id === row.actor.id) ?? null);
  }

  const head = checks.map(c => `<th>${esc(c.label)}<br><small>${game.i18n.localize("WONDERMAPS.Chat.DC")} ${c.dc}</small></th>`).join("");
  const body = [...users.values()].map(row => {
    const cells = row.cells.map(r => {
      if ( !r ) return "<td>-</td>";
      const cls = r.success ? "success" : "failure";
      const icon = r.success ? "fa-check" : "fa-xmark";
      const detail = esc(`${r.roll.formula} = ${r.roll.result}`);
      return `<td class="${cls}" data-tooltip="${detail}"><strong>${r.roll.total}</strong> <i class="fas ${icon}"></i></td>`;
    }).join("");
    const owners = ownerNames(row.actor);
    return `<tr><td class="who">${esc(row.actor.name)}${owners ? `<br><small>${esc(owners)}</small>` : ""}</td>${cells}</tr>`;
  }).join("");

  const table = users.size
    ? `<table><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table>`
    : `<p><em>${game.i18n.localize("WONDERMAPS.Chat.NoParty")}</em></p>`;
  const content = `<div class="wondermaps-chat"><h3>${esc(title)}</h3>${table}${footer}</div>`;

  const hasRolls = checks.some(c => c.results.length);
  return whisperToGM(content, { sound: hasRolls ? CONFIG.sounds.dice : undefined });
}

/**
 * Post a message only the GMs can see.
 * The rolls are deliberately NOT attached: Foundry shows every whispered
 * message that carries rolls to all players (as "???"). Without rolls the
 * message is a plain whisper and players get nothing at all.
 */
function whisperToGM(content, { sound }={}) {
  return ChatMessage.create({
    speaker: { alias: "WonderMaps" },
    content,
    whisper: ChatMessage.getWhisperRecipients("GM").map(u => u.id),
    sound
  });
}

/** A random direction that is at least MIN_WRONG_ANGLE away from the true one. */
function wrongAngle(truth) {
  return (truth + MIN_WRONG_ANGLE + (Math.random() * (TAU - (2 * MIN_WRONG_ANGLE)))) % TAU;
}

/**
 * Make an area the active one.
 * @param {Scene} scene
 * @param {string} areaId
 * @param {object} [options]
 * @param {boolean} [options.checks=true]   Roll the survival / intelligence checks and the roll table.
 * @param {boolean} [options.rotate=true]   Pick a new random rotation.
 * @param {boolean} [options.travel=true]   Advance the world time by the travel time of the route.
 * @param {boolean} [options.difficult=false]  Difficult terrain: the travel time is doubled.
 */
export async function walkTo(scene, areaId, { checks=true, rotate=true, travel=true, difficult=false }={}) {
  if ( !game.user.isGM ) return;
  const map = getMap(scene);
  const area = map.areas.find(a => a.id === areaId);
  if ( !area ) return;

  // Work out the route (and so the travel time) before anything changes.
  let journey = null;
  if ( travel && map.activeArea && (map.activeArea !== areaId) ) {
    const routes = findRoutes(map, map.activeArea, areaId);
    const route = routes.length > 1 ? await chooseRoute(map, routes) : (routes[0] ?? null);
    if ( routes.length && !route ) return; // The GM closed the route dialog.
    const minutes = (route?.minutes ?? 0) * (difficult ? 2 : 1);
    journey = { route, minutes, difficult };
  }

  const rotation = rotate
    ? (Settings.get("randomRotation") ? Math.random() * TAU : 0)
    : map.rotation;
  const visited = map.visited.includes(areaId) ? map.visited : [...map.visited, areaId];
  const changes = { activeArea: areaId, rotation, visited, transition: map.transition + 1 };

  let summary = null;
  if ( checks ) {
    const survivalDC = Settings.get("survivalDC");
    const intelligenceDC = Settings.get("intelligenceDC");
    const survival = await rollParty(Settings.get("survivalFormula"), survivalDC);
    const intelligence = await rollParty(Settings.get("intelligenceFormula"), intelligenceDC);

    // Each player sees the arrow and the memory of the party actor they play.
    changes.checks = playersOf(partyMembers()).map(({ user, actor }) => {
      const s = survival.find(r => r.actor === actor);
      const i = intelligence.find(r => r.actor === actor);
      return {
        userId: user.id,
        actorId: actor.id,
        survival: { total: s?.roll.total ?? 0, dc: survivalDC, success: !!s?.success },
        intelligence: { total: i?.roll.total ?? 0, dc: intelligenceDC, success: !!i?.success },
        arrow: (s?.success || knowsNorth(actor.id)) ? rotation : wrongAngle(rotation)
      };
    });

    summary = [
      { label: game.i18n.localize("WONDERMAPS.Chat.Survival"), dc: survivalDC, results: survival },
      { label: game.i18n.localize("WONDERMAPS.Chat.Intelligence"), dc: intelligenceDC, results: intelligence }
    ];
    await recordResults("survival", survivalDC, survival);
    await recordResults("intelligence", intelligenceDC, intelligence);
    await Settings.set("survivalDC", survivalDC + 1);
    await Settings.set("turns", (Settings.get("turns") ?? 0) + 1);
  }
  else changes.checks = turnArrows(map.checks, map.rotation, rotation);

  await saveMap(scene, changes);
  if ( journey?.minutes > 0 ) {
    if ( Settings.get("exploreStart") < 0 ) await Settings.set("exploreStart", game.time.worldTime);
    await addTravel(partyMembers().map(a => a.id), journey.minutes);
    await game.time.advance(journey.minutes * 60);
  }

  if ( summary ) {
    const title = game.i18n.format("WONDERMAPS.Chat.Arrived", { name: area.name || game.i18n.localize("WONDERMAPS.Area") });
    const footer = travelNote(journey)
      + `<p class="note">${game.i18n.format("WONDERMAPS.Chat.NextDC", { dc: Settings.get("survivalDC") })}</p>`;
    await postSummary(title, summary, footer);
    await drawTable(area);
  }
}

/** Does this actor always know where north is (GM toggle in the party panel)? */
function knowsNorth(actorId) {
  return (Settings.get("alwaysNorth") ?? []).includes(actorId);
}

/** Add travel minutes to each actor's "since last long rest" counter. */
async function addTravel(actorIds, minutes) {
  const travel = foundry.utils.deepClone(Settings.get("travel") ?? {});
  for ( const id of actorIds ) travel[id] = (Number(travel[id]) || 0) + minutes;
  return Settings.set("travel", travel);
}

/**
 * Toggle "always knows north" for a party actor and fix up the arrows of the
 * players of that actor on the current map right away.
 */
export async function toggleAlwaysNorth(actorId, scene) {
  if ( !game.user.isGM ) return;
  const list = new Set(Settings.get("alwaysNorth") ?? []);
  if ( list.has(actorId) ) list.delete(actorId);
  else list.add(actorId);
  await Settings.set("alwaysNorth", [...list]);
  if ( !scene ) return;
  const map = getMap(scene);
  let changed = false;
  const checks = map.checks.map(c => {
    if ( c.actorId !== actorId ) return c;
    const right = list.has(actorId) || c.survival?.success;
    const isRight = Math.abs(((c.arrow - map.rotation) % TAU + TAU) % TAU) < 1e-6;
    if ( right === isRight ) return c;
    changed = true;
    return { ...c, arrow: right ? map.rotation : wrongAngle(map.rotation) };
  });
  if ( changed ) await saveMap(scene, { checks });
}

/**
 * Let time pass outside of travelling (GM only): advances the world time, so
 * the "time in the area" grows. Only when `travel` is set does it also count
 * towards every party member's "travelled since the last long rest".
 * @param {number} minutes
 * @param {object} [options]
 * @param {boolean} [options.travel=false]
 */
export async function passTime(minutes, { travel=false }={}) {
  if ( !game.user.isGM ) return;
  minutes = Math.round(Number(minutes) || 0);
  if ( minutes <= 0 ) return;
  if ( Settings.get("exploreStart") < 0 ) await Settings.set("exploreStart", game.time.worldTime);
  if ( travel ) await addTravel(partyMembers().map(a => a.id), minutes);
  await game.time.advance(minutes * 60);
}

/** Mark a long rest as taken: the "travelled since long rest" counters go back to 0. */
export async function longRest(actorIds) {
  if ( !game.user.isGM ) return;
  const travel = foundry.utils.deepClone(Settings.get("travel") ?? {});
  for ( const id of actorIds ) delete travel[id];
  return Settings.set("travel", travel);
}

/** Give each actor one level of exhaustion (D&D 5e: system.attributes.exhaustion, max 6). */
export async function addExhaustion(actorIds) {
  if ( !game.user.isGM ) return;
  for ( const id of actorIds ) {
    const actor = game.actors.get(id);
    if ( !actor ) continue;
    const current = foundry.utils.getProperty(actor, "system.attributes.exhaustion");
    if ( typeof current !== "number" ) {
      ui.notifications.warn(game.i18n.format("WONDERMAPS.Errors.NoExhaustion", { name: actor.name }));
      continue;
    }
    if ( current >= 6 ) continue;
    await actor.update({ "system.attributes.exhaustion": current + 1 });
  }
}

/** One line for the chat card describing the route and the time it took. */
function travelNote(journey) {
  if ( !journey ) return "";
  const L = (key, data) => game.i18n.format(`WONDERMAPS.Chat.${key}`, data ?? {});
  if ( !journey.route ) return `<p class="note">${L("NoRoute")}</p>`;
  const parts = [];
  if ( journey.route.branch ) parts.push(L("Branch", { n: journey.route.branch }));
  if ( journey.route.wrong ) parts.push(game.i18n.localize("WONDERMAPS.Route.WrongWay"));
  parts.push(L("TravelTime", { time: formatMinutes(journey.minutes) }));
  if ( journey.difficult ) parts.push(L("Difficult"));
  return `<p class="note">${parts.join(" · ")}</p>`;
}

/** Let the GM pick between several routes to the same area. */
async function chooseRoute(map, routes) {
  const esc = s => Handlebars.escapeExpression(s);
  const nodeName = id => {
    const found = findNode(map, id);
    if ( !found ) return "?";
    return found.node.name || game.i18n.localize(found.type === "area" ? "WONDERMAPS.Area" : "WONDERMAPS.Crossroad");
  };
  const options = routes.map((r, i) => {
    // Names of the crossroads along the way.
    const via = [];
    let at = map.activeArea;
    for ( const e of r.edges.slice(0, -1) ) {
      at = e.from === at ? e.to : e.from;
      via.push(nodeName(at));
    }
    const label = [
      r.branch ? game.i18n.format("WONDERMAPS.Chat.Branch", { n: r.branch }) : null,
      r.wrong ? `<strong class="wrong-way">${game.i18n.localize("WONDERMAPS.Route.WrongWay")}</strong>` : null,
      via.length ? `${game.i18n.localize("WONDERMAPS.Route.Via")} ${via.map(esc).join(" → ")}` : null,
      formatMinutes(r.minutes)
    ].filter(x => x).join(" · ");
    return `<label class="route"><input type="radio" name="route" value="${i}" ${i ? "" : "checked"}> ${label}</label>`;
  }).join("");
  const index = await Dialog.prompt({
    title: game.i18n.localize("WONDERMAPS.Route.Title"),
    content: `<form class="wondermaps-routes"><p>${game.i18n.localize("WONDERMAPS.Route.Hint")}</p>${options}</form>`,
    label: game.i18n.localize("WONDERMAPS.Menu.WalkHere"),
    rejectClose: false,
    callback: html => Number(html[0].querySelector("input[name=route]:checked")?.value ?? 0)
  });
  return index == null ? null : routes[index];
}

/** Blindly draw from the area's roll table, if it has one. */
async function drawTable(area) {
  if ( !area.table ) return;
  const table = await fromUuid(area.table);
  if ( !(table instanceof RollTable) ) {
    ui.notifications.warn(game.i18n.format("WONDERMAPS.Errors.NoTable", { uuid: area.table }));
    return;
  }
  // Draw without Foundry's chat card (it would show "???" to players) and
  // report the result in a GM-only message instead.
  const { roll, results } = await table.draw({ displayChat: false });
  const esc = s => Handlebars.escapeExpression(s);
  const items = results.map(r => {
    const img = r.img ? `<img src="${esc(r.img)}" alt="">` : "";
    return `<li>${img}<span>${r.getChatText()}</span></li>`;
  }).join("");
  const content = `<div class="wondermaps-chat wondermaps-table">
    <h3>${esc(table.name)}</h3>
    <p class="note" data-tooltip="${esc(`${roll.formula} = ${roll.result}`)}">${game.i18n.localize("WONDERMAPS.Chat.Rolled")} <strong>${roll.total}</strong></p>
    <ul>${items || `<li>${game.i18n.localize("WONDERMAPS.Chat.NoResult")}</li>`}</ul>
  </div>`;
  return whisperToGM(content, { sound: CONFIG.sounds.dice });
}

/** Roll the survival check of a crossroad for the whole party. */
export async function crossroadCheck(scene, crossroadId) {
  if ( !game.user.isGM ) return;
  const cross = getMap(scene).crossroads.find(c => c.id === crossroadId);
  if ( !cross ) return;
  const dc = Number(cross.dc) || 0;
  const results = await rollParty(Settings.get("survivalFormula"), dc);
  await recordResults("survival", dc, results);
  const title = game.i18n.format("WONDERMAPS.Chat.Crossroad", { name: cross.name || game.i18n.localize("WONDERMAPS.Crossroad") });
  return postSummary(title, [{ label: game.i18n.localize("WONDERMAPS.Chat.Survival"), dc, results }]);
}

/** Roll the check to find a track for the whole party. */
export async function trackCheck(scene, areaId, trackId) {
  if ( !game.user.isGM ) return;
  const area = getMap(scene).areas.find(a => a.id === areaId);
  const track = area?.tracks?.find(t => t.id === trackId);
  if ( !track ) return;
  const dc = Number(track.dc) || 0;
  const formula = track.formula?.trim() || Settings.get("survivalFormula");
  const results = await rollParty(formula, dc);
  const title = game.i18n.format("WONDERMAPS.Chat.Track", {
    name: track.name || game.i18n.localize("WONDERMAPS.Track"),
    area: area.name || game.i18n.localize("WONDERMAPS.Area")
  });
  return postSummary(title, [{ label: game.i18n.localize("WONDERMAPS.Chat.Find"), dc, results }]);
}

/**
 * Turn every stored arrow along with the map, so that each arrow keeps the same
 * offset from true north (right arrows stay right, wrong ones stay wrong).
 */
function turnArrows(checks, from, to) {
  return checks.map(c => ({ ...c, arrow: (((c.arrow ?? 0) - from + to) % TAU + TAU) % TAU }));
}

/** Put north back up, with the usual blackout. */
export async function resetRotation(scene) {
  if ( !game.user.isGM ) return;
  const map = getMap(scene);
  return saveMap(scene, {
    rotation: 0,
    checks: turnArrows(map.checks, map.rotation, 0),
    transition: map.transition + 1
  });
}

/**
 * Reset everything: the journey on this map (active area, visited areas,
 * arrows, rotation), the Survival DC, the turn counter and the party's last
 * results. The party members themselves are kept.
 */
export async function resetAll(scene) {
  if ( !game.user.isGM ) return;
  await Settings.set("survivalDC", Settings.get("baseSurvivalDC"));
  await Settings.set("turns", 0);
  await Settings.set("partyResults", {});
  await Settings.set("travel", {});
  await Settings.set("exploreStart", game.time.worldTime);
  if ( scene ) await resetJourney(scene);
}

/**
 * Change the default size of new areas and crossroads on a map. Areas and
 * crossroads that still have the old default size follow the new one; the ones
 * the GM resized by hand keep their size.
 */
export async function setDefaultSizes(scene, { areaRadius, crossroadSize }) {
  if ( !game.user.isGM || !scene ) return;
  const map = getMap(scene);
  const defaults = { ...map.defaults };
  const changes = {};
  if ( Number.isFinite(areaRadius) && (areaRadius >= 20) && (areaRadius !== defaults.areaRadius) ) {
    const old = defaults.areaRadius;
    changes.areas = map.areas.map(a => ((Number(a.radius) || old) === old ? { ...a, radius: areaRadius } : a));
    defaults.areaRadius = areaRadius;
  }
  if ( Number.isFinite(crossroadSize) && (crossroadSize >= 10) && (crossroadSize !== defaults.crossroadSize) ) {
    const old = defaults.crossroadSize;
    changes.crossroads = map.crossroads.map(c => ((Number(c.size) || old) === old ? { ...c, size: crossroadSize } : c));
    defaults.crossroadSize = crossroadSize;
  }
  if ( !Object.keys(changes).length ) return;
  changes.defaults = defaults;
  return saveMap(scene, changes);
}

/** Forget the journey: no active area, nothing visited, north up. */
export async function resetJourney(scene) {
  if ( !game.user.isGM ) return;
  const map = getMap(scene);
  return saveMap(scene, { activeArea: null, visited: [], checks: [], rotation: 0, transition: map.transition + 1 });
}

/** Dialog to change or reset the running survival DC. */
export async function survivalDCDialog() {
  const current = Settings.get("survivalDC");
  const base = Settings.get("baseSurvivalDC");
  const content = `
    <form class="wondermaps-dc">
      <div class="form-group">
        <label>${game.i18n.localize("WONDERMAPS.DC.Current")}</label>
        <input type="number" name="dc" value="${current}" step="1">
      </div>
      <p class="notes">${game.i18n.format("WONDERMAPS.DC.Hint", { base })}</p>
    </form>`;
  return Dialog.wait({
    title: game.i18n.localize("WONDERMAPS.DC.Title"),
    content,
    buttons: {
      save: {
        icon: '<i class="fas fa-save"></i>',
        label: game.i18n.localize("WONDERMAPS.DC.Save"),
        callback: html => {
          const value = Number(html[0].querySelector("input[name=dc]").value);
          if ( Number.isFinite(value) ) return Settings.set("survivalDC", Math.round(value));
        }
      },
      reset: {
        icon: '<i class="fas fa-rotate-left"></i>',
        label: game.i18n.format("WONDERMAPS.DC.Reset", { base }),
        callback: () => Settings.set("survivalDC", base)
      }
    },
    default: "save",
    close: () => null
  });
}
