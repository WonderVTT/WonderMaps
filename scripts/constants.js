/**
 * Shared constants for the WonderMaps module.
 */
export const MODULE_ID = "wondermaps";

/** Name of the canvas layer (also the scene-control group name). */
export const LAYER_NAME = "wondermaps";

/** Defaults applied to a freshly created area. */
export const AREA_DEFAULTS = {
  name: "",
  radius: 90,
  img: "icons/svg/mystery-man.svg",
  frameColor: "#c9a25a",
  frameWidth: 8,
  frameImg: "",
  table: "",
  notes: "",
  landmark: false,
  hidden: false,
  scene: "",
  tracks: []
};

/** Defaults applied to a freshly created crossroad. */
export const CROSSROAD_DEFAULTS = {
  name: "",
  dc: 12,
  size: 34
};

/** Defaults applied to a freshly created track. */
export const TRACK_DEFAULTS = {
  name: "",
  dc: 10,
  formula: "",
  img: "icons/svg/pawprint.svg"
};

/** Colours used on the canvas. */
export const COLORS = {
  path: 0xe8dcc0,
  pathWrong: 0xff5722,
  pathRight: 0x6cc070,
  pathVisited: 0x8a8a8a,
  active: 0xffd166,
  crossroad: 0x2f4858,
  crossroadLine: 0xe8dcc0,
  track: 0x7a3e9d,
  trackLine: 0xffffff,
  arrow: 0xffd166,
  arrowLine: 0x1a1a1a,
  selection: 0x4fc3f7,
  travelTime: 0xff9800,
  highlight: 0x2e7d32
};

/** Minimum angular distance (radians) between a failed arrow and true north. */
export const MIN_WRONG_ANGLE = Math.PI / 4;
