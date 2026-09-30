import { Settings } from "./settings.js";

/**
 * Full-screen blackout used to hide the map while it rotates.
 * Transitions are queued so that quick successive moves never overlap.
 */
let queue = Promise.resolve();

function overlay() {
  let el = document.getElementById("wondermaps-blackout");
  if ( !el ) {
    el = document.createElement("div");
    el.id = "wondermaps-blackout";
    const board = document.getElementById("board");
    if ( board?.parentElement ) board.after(el);
    else document.body.append(el);
  }
  return el;
}

const wait = ms => new Promise(resolve => window.setTimeout(resolve, ms));

/**
 * Fade to black, run the callback while the screen is dark, then fade back in.
 * @param {Function} whileDark   Sync or async function that changes the map.
 */
export function blackout(whileDark) {
  queue = queue.then(async () => {
    const el = overlay();
    const duration = Math.max(100, Settings.get("blackoutDuration") ?? 800);
    el.style.transitionDuration = `${duration}ms`;
    el.classList.add("active");
    await wait(duration);
    try {
      await whileDark();
    } catch(err) {
      console.error("wondermaps | transition failed", err);
    }
    // Keep it fully dark for a moment so nothing of the rotation is visible.
    await wait(Math.round(duration / 2));
    el.classList.remove("active");
    await wait(duration);
  });
  return queue;
}
