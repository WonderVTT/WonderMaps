import { MODULE_ID, AREA_DEFAULTS, CROSSROAD_DEFAULTS } from "./constants.js";
import { Settings } from "./settings.js";

/**
 * Helpers to read and write the WonderMap stored in a Scene's flags.
 *
 * Everything lives in `scene.flags.wondermaps`:
 *   enabled     Whether the scene is a WonderMap.
 *   areas       [{id, name, x, y, radius, img, frameColor, frameWidth, frameImg, table, notes, tracks, hidden}]
 *   crossroads  [{id, name, x, y, dc, size}]
 *   edges       [{id, from, to, wrong, time, hidden}]
 *   activeArea  Id of the active area, or null.
 *   rotation    Current map rotation in radians.
 *   visited     Ids of the areas the party has already visited.
 *   checks      [{userId, survival, intelligence, arrow}] from the last activation.
 *   transition  Counter bumped every time the map must black out and rotate.
 *   defaults    {areaRadius, crossroadSize, pathTime} used for new areas, crossroads and paths on this map.
 * Area and crossroad coordinates are always in unrotated map space.
 */

/** Is this scene a WonderMap? */
export function isWonderMap(scene) {
  return !!scene?.getFlag(MODULE_ID, "enabled");
}

/**
 * Read a normalised copy of the map data from a scene.
 * @param {Scene} scene
 */
export function getMap(scene) {
  const f = foundry.utils.deepClone(scene?.flags?.[MODULE_ID] ?? {});
  return {
    enabled: !!f.enabled,
    areas: Array.isArray(f.areas) ? f.areas : [],
    crossroads: Array.isArray(f.crossroads) ? f.crossroads : [],
    edges: Array.isArray(f.edges) ? f.edges : [],
    activeArea: f.activeArea ?? null,
    rotation: Number(f.rotation) || 0,
    visited: Array.isArray(f.visited) ? f.visited : [],
    checks: Array.isArray(f.checks) ? f.checks : [],
    transition: Number(f.transition) || 0,
    defaults: {
      areaRadius: Number(f.defaults?.areaRadius) || AREA_DEFAULTS.radius,
      crossroadSize: Number(f.defaults?.crossroadSize) || CROSSROAD_DEFAULTS.size,
      // Travel time (minutes) of a newly drawn path; 0 leaves it unset.
      pathTime: Math.max(0, Math.round(Number(f.defaults?.pathTime) || 0))
    }
  };
}

/**
 * Write a subset of the map data back to the scene.
 * Arrays are replaced wholesale, which is what we want.
 * @param {Scene} scene
 * @param {object} changes   Partial map data.
 */
export function saveMap(scene, changes) {
  const update = {};
  for ( const [k, v] of Object.entries(changes) ) update[`flags.${MODULE_ID}.${k}`] = v;
  return scene.update(update);
}

/** Find any node (area or crossroad) by id. */
export function findNode(map, id) {
  const area = map.areas.find(a => a.id === id);
  if ( area ) return { type: "area", node: area };
  const cross = map.crossroads.find(c => c.id === id);
  if ( cross ) return { type: "crossroad", node: cross };
  return null;
}

/**
 * The areas one path away from the active area: every simple path that leaves
 * the active area and passes only through crossroads until it reaches another
 * area. Returns, for each such area, the paths and crossroads on the way.
 * @param {object} map
 * @param {(areaId: string) => boolean} [accept]   Only keep areas passing this test.
 * @returns {{areas: Set<string>, crossroads: Set<string>, edges: Set<string>}}
 */
export function neighbourhood(map, accept=() => true) {
  const result = { areas: new Set(), crossroads: new Set(), edges: new Set() };
  const start = map.activeArea;
  if ( !start ) return result;

  // Areas the GM hid from the players are never "next door" as far as players know.
  const areaIds = new Set(map.areas.filter(a => !a.hidden).map(a => a.id));
  const crossIds = new Set(map.crossroads.map(c => c.id));
  const adjacency = new Map();
  for ( const e of map.edges ) {
    // Wrong ways are where the party gets lost, not paths anybody can see or take.
    // Hidden paths are secret until the GM reveals them.
    if ( e.wrong || e.hidden ) continue;
    if ( !adjacency.has(e.from) ) adjacency.set(e.from, []);
    if ( !adjacency.has(e.to) ) adjacency.set(e.to, []);
    adjacency.get(e.from).push({ edge: e, other: e.to });
    adjacency.get(e.to).push({ edge: e, other: e.from });
  }

  const MAX_DEPTH = 32;
  const walk = (nodeId, onPath, edgePath, crossPath) => {
    if ( edgePath.length > MAX_DEPTH ) return;
    for ( const { edge, other } of adjacency.get(nodeId) ?? [] ) {
      if ( onPath.has(other) ) continue;
      if ( areaIds.has(other) ) {
        if ( (other !== start) && accept(other) ) {
          result.areas.add(other);
          for ( const id of [...edgePath, edge.id] ) result.edges.add(id);
          for ( const id of crossPath ) result.crossroads.add(id);
        }
      }
      else if ( crossIds.has(other) ) {
        onPath.add(other);
        walk(other, onPath, [...edgePath, edge.id], [...crossPath, other]);
        onPath.delete(other);
      }
    }
  };
  walk(start, new Set([start]), [], []);
  return result;
}

/** Visited areas next to the active one, with the paths to them (what INT lets players recall). */
export function rememberedNeighbourhood(map) {
  const visited = new Set(map.visited);
  return neighbourhood(map, id => visited.has(id));
}

/** The "always visible" areas next to the active one, with the paths to them. */
export function visibleLandmarks(map) {
  const landmarks = new Set(map.areas.filter(a => a.landmark).map(a => a.id));
  return neighbourhood(map, id => landmarks.has(id));
}

/** The party: the actors the GM dropped onto the party panel. */
export function partyMembers() {
  return (Settings.get("party") ?? []).map(id => game.actors.get(id)).filter(a => a);
}

/**
 * The party actor whose checks drive a player's arrow and memory: their
 * assigned character if it is in the party, otherwise the first party actor
 * they own.
 * @param {User} user
 * @param {Actor[]} party
 */
export function actorForUser(user, party) {
  if ( user.character && party.includes(user.character) ) return user.character;
  return party.find(a => a.testUserPermission(user, "OWNER")) ?? null;
}

/** Non-GM users who own at least one actor of the party, as the actor they play. */
export function playersOf(party) {
  return game.users.filter(u => !u.isGM)
    .map(user => ({ user, actor: actorForUser(user, party) }))
    .filter(p => p.actor);
}

const TAU = Math.PI * 2;

/** Edges touching a node, as [{edge, other}]. */
function incident(map, nodeId) {
  return map.edges
    .filter(e => (e.from === nodeId) || (e.to === nodeId))
    .map(e => ({ edge: e, other: e.from === nodeId ? e.to : e.from }));
}

/**
 * Number the paths leaving the active area: 1, 2, 3... clockwise from the
 * map's north, in unrotated map space. Everybody computes the same numbers
 * from the same scene data, so GM and players always agree. Wrong ways are
 * not branches (nobody can choose them), so they get no number. Neither do
 * paths hidden from the players (revealing one can renumber the others).
 * @returns {Map<string, number>}   edge id -> branch number
 */
export function branchNumbers(map) {
  const active = map.areas.find(a => a.id === map.activeArea);
  if ( !active ) return new Map();
  const list = [];
  for ( const { edge, other } of incident(map, active.id) ) {
    if ( edge.wrong || edge.hidden ) continue;
    const node = findNode(map, other)?.node;
    if ( !node ) continue;
    // Angle clockwise from north (-y).
    const angle = (Math.atan2(node.x - active.x, -(node.y - active.y)) + TAU) % TAU;
    list.push({ edge, angle });
  }
  list.sort((a, b) => (a.angle - b.angle) || a.edge.id.localeCompare(b.edge.id));
  return new Map(list.map((x, i) => [x.edge.id, i + 1]));
}

/**
 * Every simple route from one area to another that passes only through
 * crossroads, with its travel time. Routes through wrong ways are included
 * (that is how the party gets lost) and flagged.
 * @returns {Array<{edges: object[], minutes: number, branch: number|null}>}
 */
export function findRoutes(map, fromId, toId, { max=20 }={}) {
  const routes = [];
  if ( !fromId || !toId || (fromId === toId) ) return routes;
  const crossIds = new Set(map.crossroads.map(c => c.id));
  const branches = map.activeArea === fromId ? branchNumbers(map) : new Map();
  const walk = (nodeId, onPath, edges) => {
    if ( (routes.length >= max) || (edges.length > 32) ) return;
    for ( const { edge, other } of incident(map, nodeId) ) {
      if ( onPath.has(other) ) continue;
      const next = [...edges, edge];
      if ( other === toId ) {
        routes.push({
          edges: next,
          minutes: next.reduce((sum, e) => sum + (Number(e.time) || 0), 0),
          branch: branches.get(next[0].id) ?? null,
          wrong: next.some(e => e.wrong)
        });
      }
      else if ( crossIds.has(other) ) {
        onPath.add(other);
        walk(other, onPath, next);
        onPath.delete(other);
      }
    }
  };
  walk(fromId, new Set([fromId]), []);
  return routes.sort((a, b) => (a.minutes - b.minutes) || (a.edges.length - b.edges.length));
}

/**
 * Everything that goes when a path (or crossroad) is deleted: starting from
 * it, follow the paths through every crossroad reached. Areas are never
 * deleted and stop the spread.
 * @param {object} map
 * @param {{edgeId?: string, crossroadId?: string}} start
 * @returns {{edges: Set<string>, crossroads: Set<string>}}
 */
export function pathNetwork(map, { edgeId, crossroadId }) {
  const edges = new Set();
  const crossroads = new Set();
  const crossIds = new Set(map.crossroads.map(c => c.id));
  const queue = [];
  if ( edgeId ) {
    const edge = map.edges.find(e => e.id === edgeId);
    if ( edge ) {
      edges.add(edge.id);
      queue.push(edge.from, edge.to);
    }
  }
  if ( crossroadId ) queue.push(crossroadId);
  while ( queue.length ) {
    const id = queue.pop();
    if ( !crossIds.has(id) || crossroads.has(id) ) continue;
    crossroads.add(id);
    for ( const { edge, other } of incident(map, id) ) {
      if ( edges.has(edge.id) ) continue;
      edges.add(edge.id);
      queue.push(other);
    }
  }
  return { edges, crossroads };
}

/** "2d 5h", "5h 30m", "45m": days and hours for long spans. */
export function formatDuration(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  const d = Math.floor(total / 1440);
  if ( !d ) return formatMinutes(total);
  const h = Math.floor((total % 1440) / 60);
  return h ? `${d}d ${h}h` : `${d}d`;
}

/** "1h 30m", "45m", "0m". */
export function formatMinutes(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if ( h && m ) return `${h}h ${m}m`;
  if ( h ) return `${h}h`;
  return `${m}m`;
}
