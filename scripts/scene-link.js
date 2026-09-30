/**
 * Areas can be linked to another Scene; the GM activates it with one click.
 * If the SnapScene module is active and that scene has snapshots, the GM first
 * picks one to restore (or none). Everything SnapScene-related is optional:
 * without the module the scene is simply activated.
 */

/** The SnapScene API, or null when the module is missing or inactive. */
function snapScene() {
  const mod = game.modules.get("snapscene");
  if ( !mod?.active ) return null;
  const api = mod.api;
  return (typeof api?.listSnapshots === "function") && (typeof api?.restoreSnapshot === "function") ? api : null;
}

/** Snapshots of a scene, newest first, or [] when unavailable. */
function snapshotsOf(api, scene) {
  if ( !api ) return [];
  try {
    return api.listSnapshots(scene) ?? [];
  } catch(err) {
    console.warn("wondermaps | could not list SnapScene snapshots", err);
    return [];
  }
}

/**
 * Ask which snapshot to restore.
 * @returns {Promise<string|null|undefined>}  snapshot id, null for "none", undefined if cancelled.
 */
async function chooseSnapshot(scene, snapshots) {
  const esc = s => Handlebars.escapeExpression(s);
  const L = key => game.i18n.localize(`WONDERMAPS.SceneLink.${key}`);
  const options = snapshots.map(s => {
    const date = s.created ? new Date(s.created).toLocaleString() : "";
    return `<label class="snapshot"><input type="radio" name="snapshot" value="${esc(s.id)}">
      <span class="name">${esc(s.name)}</span><span class="date">${esc(date)}</span></label>`;
  }).join("");
  const content = `
    <form class="wondermaps-snapshots">
      <p>${game.i18n.format("WONDERMAPS.SceneLink.ChooseHint", { scene: esc(scene.name) })}</p>
      <label class="snapshot"><input type="radio" name="snapshot" value="" checked>
        <span class="name"><em>${L("NoRestore")}</em></span></label>
      ${options}
    </form>`;
  return Dialog.wait({
    title: `${L("Title")}: ${scene.name}`,
    content,
    buttons: {
      activate: {
        icon: '<i class="fas fa-bullseye"></i>',
        label: L("Activate"),
        callback: html => (html[0] ?? html).querySelector("input[name=snapshot]:checked")?.value || null
      },
      cancel: {
        icon: '<i class="fas fa-xmark"></i>',
        label: game.i18n.localize("Cancel"),
        callback: () => undefined
      }
    },
    default: "activate",
    close: () => undefined
  });
}

/**
 * Activate the scene linked to an area (GM only), optionally restoring a
 * SnapScene snapshot of it first.
 * @param {object} area   Area data with a `scene` id.
 */
export async function activateLinkedScene(area) {
  if ( !game.user.isGM ) return;
  const scene = game.scenes.get(area?.scene);
  if ( !scene ) {
    ui.notifications.warn(game.i18n.localize("WONDERMAPS.SceneLink.Missing"));
    return;
  }

  const api = snapScene();
  const snapshots = snapshotsOf(api, scene);
  if ( snapshots.length ) {
    const choice = await chooseSnapshot(scene, snapshots);
    if ( choice === undefined ) return; // Cancelled.
    if ( choice ) {
      // Restore before activating, so players arrive on the restored scene.
      try {
        const report = await api.restoreSnapshot(scene, choice);
        if ( report?.errors?.length ) {
          console.warn("wondermaps | SnapScene restore problems", report.errors);
          ui.notifications.warn(game.i18n.format("WONDERMAPS.SceneLink.RestoreWarnings", { n: report.errors.length }));
        }
      } catch(err) {
        console.error("wondermaps | SnapScene restore failed", err);
        ui.notifications.error(game.i18n.format("WONDERMAPS.SceneLink.RestoreFailed", { error: err.message }));
        return;
      }
    }
  }
  await scene.activate();
}
