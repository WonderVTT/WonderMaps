# WonderMaps

A gridless exploration scene type for Foundry VTT v12. The map is made of circular **areas** joined by **paths**. Paths can fork at **crossroads** (hexagons). The party is always in one **active** area. Every move blacks out the screen and rotates the map, and each player gets their own compass arrow.

## Setup

- **New scene:** in the Scenes sidebar, click **Create WonderMap**.
- **Existing scene:** open *Configure Scene* and tick **WonderMap scene**. This makes the scene gridless and turns off token vision and fog.
- Set the **background image** and **background music** in the normal scene configuration (*Basic* and *Ambience* tabs). The background is a fixed backdrop: it always covers the whole screen and does not rotate, pan or zoom.
- Build the **party**: drag actors (or a whole actor folder) from the Actors tab onto the **Party** panel at the top right. The panel is GM only and shows on WonderMap scenes. Checks are rolled only for these actors. Each player gets the arrow and memory of the party actor they play: their assigned character, or else the first party actor they own.

## Party panel (GM only)

- One row per party actor: a bar in the colour of the player(s) who play it (the colour of their arrow), portrait, name, owning players, a **compass** toggle, last **Survival** result and last **INT** result (green = passed, red = failed; hover for the DC). Crossroad checks also update the Survival result.
- **Compass** (gold when on): that character always knows where north is. Their arrow points north whatever their Survival check; switching it takes effect immediately.
- **✕** removes an actor from the party, after a confirmation.
- **Survival DC**: −/+, type a value, or ↺ to reset it to the starting DC. **INT DC**: −/+ or type a value.
- **Turns**: +1 on every *Walk here* (one area change). Like the DC it carries over between scenes until you reset it with ↺.
- **Reset rotation** turns the map back to north up (with the blackout). Players' arrows keep their angle from north, so correct ones stay correct.
- **Reset everything** clears the journey on this map (active area, visited areas, arrows, rotation) and resets the Survival DC, the turns, the last results, the time in the area and the travel counters. The party members are kept.
- **Area radius / Crossroad size**: default sizes on this map. New areas and crossroads use them; existing ones that still have the old default follow the change, resized ones keep their size.
- **New path time**: hours and minutes every path you draw on this map starts with (0 = no travel time, as before). Paths already drawn keep theirs.
- Click the chevron to collapse the panel.

## GM tools (compass icon in the scene controls)

| Tool | Use |
|---|---|
| Select | **Left-click** an area to see its full art (same as players). **Right-click** it for its menu (**Walk here**, **Walk here (difficult terrain)**, Set active, Edit, Add track, Mark visited, Hide/Reveal, Delete). Click a crossroad to roll its Survival check blindly for the party. Drag areas and crossroads to move them. Click a path for its menu: **travel time**, right/wrong direction, hide/reveal, delete. Right-click a track to copy it to other areas. |
| Add area | Click the map to place an area. Its configuration sheet opens: image, radius, frame colour/width or frame image, roll table, GM notes, tracks. |
| Add crossroad | Click **on a path** to split it with a hexagon crossroad (the travel time is split proportionally). Right-click it → Edit for its name and Survival DC. |
| Connect | Drag from an area or crossroad and release on another one to draw a path. Paths always start and end on an area or a crossroad. The path a crossroad was placed on is the **right way**; every path drawn from or to a crossroad afterwards starts as a **wrong way**, drawn orange-red and dashed for the GM only. A wrong way is where the party ends up when they get lost, not a real path: players never see it, it gets no branch number, and it doesn't make areas "next door". The GM can still walk the party along it (the route picker marks it). Flip it from the path's menu. |
| Survival DC | Shows the running DC. Set it or reset it to the starting value. |
| Reset journey | Clears the active area, the visited list and the arrows. |

## Hiding areas and paths

Right-click an area or a path → **Hide from players** (and **Reveal to players** to undo). Areas also have a **Hidden from players** checkbox in their sheet. The GM sees hidden things faded, like hidden tokens.

- A **hidden path** is secret: players get no branch line or number for it, and it doesn't make areas "next door" (for INT memory or always-visible areas). Branch numbers skip it, so revealing it can renumber the others. The GM can still walk the party along it.
- A **hidden area** never shows up for players as a remembered or always-visible neighbour, and neither do paths that only lead to it. Paths to it that aren't hidden still show as branches: hide them too to keep the way secret. If the party walks into a hidden area, players do see it while they're there.

## Area art

Everybody (players and GM) can hover an area they can see to get a magnifier, and click it to open the area's image full size in Foundry's image viewer. The GM also gets the viewer's *Show Players* button. This works whichever canvas layer is active.

## Linked scenes (and SnapScene)

In an area's sheet, pick a **Linked scene**. The GM then sees a red bullseye at the area's top left (hover for the scene name). Clicking it, or right-click → *Activate scene: …*, activates that scene for everybody.

If the [SnapScene](../SnapScene) module is active and the linked scene has snapshots, a dialog first asks which snapshot to restore, or none (the default). The restore happens before the scene is activated, so players arrive on the restored scene. If the restore fails the scene is not activated and the error is shown. Without SnapScene, or when the scene has no snapshots, the scene is activated straight away. WonderMaps only *recommends* SnapScene and works the same without it.

## Always-visible areas

Tick **Always visible from next door** in an area's sheet. Players then see that area in full colour, and the path to it, whenever the party is in an area connected to it by a path, whatever their checks. Players never see crossroads, travel times or DCs: the path runs straight through the crossroads. The GM sees an eye badge on its bottom left; the green "visited" badge is on the bottom right.

## Travel box (bottom right, everybody)

- **Time in the area**: world time passed since the exploration started (the first move with travel time, or the last *Reset everything*), in days and hours.
- **Travelled since the last long rest**: per character. Players see their own, the GM sees the whole party. It turns red above 8 hours.
- GM only, next to the total: **+** (1 hour), **moon** (8 hours, e.g. a long rest) and **hourglass** (any amount of days/hours/minutes). These advance the world time, so the total grows, but they don't count as travel. The hourglass dialog has a checkbox to count the time as travel too (it's then added to everybody's "travelled since the last long rest"). The moon only adds time: use the bed buttons to mark the rest itself.
- GM only: per character, a **bed** (long rest taken: back to 0) and a **tired face** (+1 exhaustion, D&D 5e), plus both for the whole party. A long rest taken on a D&D 5e character sheet also resets the counter (needs the world to be relaunched once so Foundry enables the module's socket).

## Deleting

Deleting a path also deletes every crossroad and path connected to it, following the network until it reaches areas. Areas are never deleted this way. Deleting a crossroad or an area does the same for the paths hanging off it. You are asked first whenever more goes than the item you clicked.

## Branches and travel time

- The paths leaving the active area are **numbered** 1, 2, 3... clockwise from the map's north. The numbers are the same for the GM and every player, so "we take 2" is unambiguous.
- Players don't see the paths themselves: only a short line in each path's direction that fades out, with its number.
- **Voting**: players click a branch number to vote for it. A dot in their player colour appears above the number, and clicking again removes it. A player can vote for several branches, and everyone sees everyone's votes. The GM doesn't vote: clicking a number turns it green to highlight that branch for everybody (click again to clear). Votes and highlights reset whenever an area is activated (walk, set active, reset). They're stored on each user's own User document, so no GM round trip is needed.
- Each path has a **travel time** (hours and minutes, shown to the GM in orange on the path, same size at any zoom). *Walk here* adds up the paths of the route and advances the world time (Simple Calendar follows it). *Walk here (difficult terrain)* doubles it. If several routes lead to the area, you're asked which one the party took (listed with their branch number, crossroads and time). The route and time appear on the GM chat card.

## What happens on "Walk here"

1. For every party member, a Survival check (against the running DC) and an Intelligence check (DC 15 by default) are rolled. The results go to a single chat card that only the GM sees; players get nothing at all, not even a "???" card (hover a result for its formula). Because of that, Dice So Nice doesn't animate these rolls. The running Survival DC then goes up by 1 and the turn counter goes up by 1. It is a world setting, so it carries over between scenes.
2. If the area has a roll table, it is drawn and the result goes to a GM-only chat card.
3. Every client fades to black. The map rotates by a random angle around the new area and the view recentres. The area circles stay upright.
4. Each player sees an arrow under the active area, poking out past its frame. If they passed Survival it points to true north; if not, it points at least 45° away from it. The GM sees a bigger gold arrow for true north, plus every player's arrow in that player's colour.
5. Players who passed Intelligence also see, greyed out, the areas they have already visited that are one path away from the active area (through crossroads), along with those paths. Everyone else sees only the active area.

**Tracks** are small circles on the top-right of an area, visible only to the GM, each with an icon and an optional DC (in the small tag; hover for the name). Click one to roll the party's check to find it blindly. To reuse a track elsewhere, use the copy button next to it in the area sheet (or right-click it on the map → Copy to other areas): tick the areas and set each copy's DC. The check uses Survival by default; you can set a custom formula per track.

## Settings

Starting Survival DC (6), Intelligence DC (15), the Survival and Intelligence roll formulas (D&D 5e defaults: `1d20 + @skills.sur.total` and `1d20 + @abilities.int.mod`; values missing on other systems count as 0), map rotation on/off, and blackout duration.

## Notes

- All map data is stored in the scene flags. A player who knows how can read it from the browser console. The hiding is presentational, the same way GM-only notes in many modules are.
- Macro API: `game.modules.get("wondermaps").api` exposes `walkTo(scene, areaId)`, `crossroadCheck`, `trackCheck`, `resetJourney`, `survivalDCDialog`, `createScene`.

## Install

`./install.sh` syncs this folder into `~/.local/share/FoundryVTT/Data/modules/wondermaps`. Run it after every change.
