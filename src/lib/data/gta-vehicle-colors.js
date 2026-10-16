// GTA V vehicle colour palette, carcols.ymt indices 0-160 (update.rpf), with
// each colour's metallicID. Names follow the commonly published FiveM/native
// reference list. A carcols file that ships its own <Colors> list overrides
// these per index at runtime.
//
// The game multiplies paint by these values as linear colour, so a raw
// 0xFF5A5E66 "Metallic Silver" displays as #a0a3aa. `gameHex` is the raw
// value; `hex` is the sRGB colour the UI shows and the renderer decodes back
// to the game value.

export const UNKNOWN_COLOR_HEX = "#aaaaaa";

// carcols.ymt <MetallicSettings>, indexed by EVehicleModelColorMetallic
// (normal = 0, then 1-9): highlight strength, Blinn-Phong falloff, fresnel.
export const GTA_PAINT_FINISHES = [
  { id: 0, label: "Metallic", specInt: 0.8, specFalloff: 510, specFresnel: 0.96 },
  { id: 1, label: "Deep metallic", specInt: 0.5, specFalloff: 500, specFresnel: 0.96 },
  { id: 2, label: "Bright metallic", specInt: 1, specFalloff: 510, specFresnel: 0.95 },
  { id: 3, label: "Matte", specInt: 0.5, specFalloff: 5, specFresnel: 0.96 },
  { id: 4, label: "Util", specInt: 0.4, specFalloff: 500, specFresnel: 0.93 },
  { id: 5, label: "Worn", specInt: 1, specFalloff: 20, specFresnel: 0.96 },
  { id: 6, label: "Brushed", specInt: 1, specFalloff: 160, specFresnel: 0.78 },
  { id: 7, label: "Chrome", specInt: 1, specFalloff: 512, specFresnel: 0.05 },
  { id: 8, label: "Gold", specInt: 1, specFalloff: 300, specFresnel: 0.8 },
  { id: 9, label: "Satin gold", specInt: 1, specFalloff: 100, specFresnel: 0.8 },
];

export const DEFAULT_PAINT_FINISH = 0;

const TABLE = [
  [0, "Metallic Black", "#080808", 1],
  [1, "Metallic Graphite Black", "#0f0f0f", 1],
  [2, "Metallic Black Steel", "#1c1e21", 0],
  [3, "Metallic Dark Silver", "#292c2e", 0],
  [4, "Metallic Silver", "#5a5e66", 0],
  [5, "Metallic Blue Silver", "#777c87", 0],
  [6, "Metallic Steel Gray", "#515459", 0],
  [7, "Metallic Shadow Silver", "#323b47", 0],
  [8, "Metallic Stone Silver", "#333333", 0],
  [9, "Metallic Midnight Silver", "#1f2226", 0],
  [10, "Metallic Gun Metal", "#23292e", 0],
  [11, "Metallic Anthracite Grey", "#121110", 0],
  [12, "Matte Black", "#050505", 3],
  [13, "Matte Gray", "#121212", 3],
  [14, "Matte Light Grey", "#2f3233", 3],
  [15, "Util Black", "#080808", 4],
  [16, "Util Black Poly", "#121212", 4],
  [17, "Util Dark silver", "#202224", 4],
  [18, "Util Silver", "#575961", 4],
  [19, "Util Gun Metal", "#23292e", 4],
  [20, "Util Shadow Silver", "#323b47", 4],
  [21, "Worn Black", "#0f1012", 5],
  [22, "Worn Graphite", "#212121", 5],
  [23, "Worn Silver Grey", "#5b5d5e", 5],
  [24, "Worn Silver", "#888a99", 5],
  [25, "Worn Blue Silver", "#697187", 5],
  [26, "Worn Shadow Silver", "#3b4654", 5],
  [27, "Metallic Red", "#690000", 0],
  [28, "Metallic Torino Red", "#8a0b00", 0],
  [29, "Metallic Formula Red", "#6b0000", 0],
  [30, "Metallic Blaze Red", "#611009", 0],
  [31, "Metallic Graceful Red", "#4a0a0a", 0],
  [32, "Metallic Garnet Red", "#470e0e", 0],
  [33, "Metallic Desert Red", "#380c00", 0],
  [34, "Metallic Cabernet Red", "#26030b", 0],
  [35, "Metallic Candy Red", "#630012", 0],
  [36, "Metallic Sunrise Orange", "#802800", 0],
  [37, "Metallic Classic Gold", "#6e4f2d", 0],
  [38, "Metallic Orange", "#bd4800", 0],
  [39, "Matte Red", "#780000", 3],
  [40, "Matte Dark Red", "#360000", 3],
  [41, "Matte Orange", "#ab3f00", 3],
  [42, "Matte Yellow", "#de7e00", 3],
  [43, "Util Red", "#520000", 4],
  [44, "Util Bright Red", "#8c0404", 4],
  [45, "Util Garnet Red", "#4a1000", 0],
  [46, "Worn Red", "#592525", 5],
  [47, "Worn Golden Red", "#754231", 5],
  [48, "Worn Dark Red", "#210804", 5],
  [49, "Metallic Dark Green", "#001207", 0],
  [50, "Metallic Racing Green", "#001a0b", 0],
  [51, "Metallic Sea Green", "#00211e", 0],
  [52, "Metallic Olive Green", "#1f261e", 0],
  [53, "Metallic Green", "#003805", 0],
  [54, "Metallic Gasoline Blue Green", "#0b4145", 0],
  [55, "Matte Lime Green", "#418503", 3],
  [56, "Util Dark Green", "#0f1f15", 4],
  [57, "Util Green", "#023613", 4],
  [58, "Worn Dark Green", "#162419", 5],
  [59, "Worn Green", "#2a3625", 5],
  [60, "Worn Sea Wash", "#455c56", 5],
  [61, "Metallic Midnight Blue", "#000d14", 0],
  [62, "Metallic Dark Blue", "#001029", 0],
  [63, "Metallic Saxony Blue", "#1c2f4f", 0],
  [64, "Metallic Blue", "#001b57", 0],
  [65, "Metallic Mariner Blue", "#3b4e78", 0],
  [66, "Metallic Harbor Blue", "#272d3b", 0],
  [67, "Metallic Diamond Blue", "#95b2db", 2],
  [68, "Metallic Surf Blue", "#3e627a", 0],
  [69, "Metallic Nautical Blue", "#1c3140", 0],
  [70, "Metallic Bright Blue", "#0055c4", 0],
  [71, "Metallic Purple Blue", "#1a182e", 0],
  [72, "Metallic Spinnaker Blue", "#161629", 0],
  [73, "Metallic Ultra Blue", "#0e316d", 0],
  [74, "Metallic Bright Blue", "#395a83", 0],
  [75, "Util Dark Blue", "#09142e", 4],
  [76, "Util Midnight Blue", "#0f1021", 4],
  [77, "Util Blue", "#152a52", 4],
  [78, "Util Sea Foam Blue", "#324654", 4],
  [79, "Uil Lightning blue", "#152563", 4],
  [80, "Util Maui Blue Poly", "#223ba1", 4],
  [81, "Util Bright Blue", "#1f1fa1", 4],
  [82, "Matte Dark Blue", "#030e2e", 3],
  [83, "Matte Blue", "#0f1e73", 3],
  [84, "Matte Midnight Blue", "#001c32", 3],
  [85, "Worn Dark blue", "#2a3754", 5],
  [86, "Worn Blue", "#303c5e", 5],
  [87, "Worn Light blue", "#3b6796", 5],
  [88, "Metallic Taxi Yellow", "#f5890f", 0],
  [89, "Metallic Race Yellow", "#d9a600", 0],
  [90, "Metallic Bronze", "#4a341b", 0],
  [91, "Metallic Yellow Bird", "#a2a827", 0],
  [92, "Metallic Lime", "#568f00", 0],
  [93, "Metallic Champagne", "#57514b", 0],
  [94, "Metallic Pueblo Beige", "#291b06", 0],
  [95, "Metallic Dark Ivory", "#262117", 0],
  [96, "Metallic Choco Brown", "#120d07", 0],
  [97, "Metallic Golden Brown", "#332111", 0],
  [98, "Metallic Light Brown", "#3d3023", 0],
  [99, "Metallic Straw Beige", "#5e5343", 0],
  [100, "Metallic Moss Brown", "#37382b", 0],
  [101, "Metallic Biston Brown", "#221918", 0],
  [102, "Metallic Beechwood", "#575036", 0],
  [103, "Metallic Dark Beechwood", "#241309", 0],
  [104, "Metallic Choco Orange", "#3b1700", 0],
  [105, "Metallic Beach Sand", "#6e6246", 0],
  [106, "Metallic Sun Bleeched Sand", "#998d73", 0],
  [107, "Metallic Cream", "#cfc0a5", 0],
  [108, "Util Brown", "#1f1709", 4],
  [109, "Util Medium Brown", "#3d311d", 4],
  [110, "Util Light Brown", "#665847", 4],
  [111, "Metallic White", "#f0f0f0", 2],
  [112, "Metallic Frost White", "#b3b9c9", 0],
  [113, "Worn Honey Beige", "#615f55", 5],
  [114, "Worn Brown", "#241e1a", 5],
  [115, "Worn Dark Brown", "#171413", 5],
  [116, "Worn straw beige", "#3b372f", 5],
  [117, "Brushed Steel", "#3b4045", 6],
  [118, "Brushed Black steel", "#1a1e21", 6],
  [119, "Brushed Aluminium", "#5e646b", 6],
  [120, "Chrome", "#000000", 7],
  [121, "Worn Off White", "#b0b0b0", 5],
  [122, "Util Off White", "#999999", 4],
  [123, "Worn Orange", "#b56519", 5],
  [124, "Worn Light Orange", "#c45c33", 5],
  [125, "Metallic Securicor Green", "#47783c", 0],
  [126, "Worn Taxi Yellow", "#ba8425", 5],
  [127, "police car blue", "#2a77a1", 0],
  [128, "Matte Green", "#243022", 3],
  [129, "Matte Brown", "#6b5f54", 3],
  [130, "Worn Orange", "#c96e34", 5],
  [131, "Matte White", "#d9d9d9", 3],
  [132, "Worn White", "#f0f0f0", 5],
  [133, "Worn Olive Army Green", "#3f4228", 3],
  [134, "Pure White", "#ffffff", 0],
  [135, "Hot Pink", "#b01259", 0],
  [136, "Salmon pink", "#f69799", 0],
  [137, "Metallic Vermillion Pink", "#8f2f55", 0],
  [138, "Orange", "#c26610", 0],
  [139, "Green", "#69bd45", 0],
  [140, "Blue", "#00aeef", 0],
  [141, "Mettalic Black Blue", "#000108", 1],
  [142, "Metallic Black Purple", "#050008", 1],
  [143, "Metallic Black Red", "#080000", 1],
  [144, "hunter green", "#565751", 0],
  [145, "Metallic Purple", "#320642", 0],
  [146, "Metaillic V Dark Blue", "#00080f", 0],
  [147, "MODSHOP BLACK1", "#080808", 1],
  [148, "Matte Purple", "#320642", 3],
  [149, "Matte Dark Purple", "#050008", 3],
  [150, "Metallic Lava Red", "#6b0b00", 0],
  [151, "Matte Forest Green", "#121710", 3],
  [152, "Matte Olive Drab", "#323325", 3],
  [153, "Matte Desert Brown", "#3b352d", 3],
  [154, "Matte Desert Tan", "#706656", 3],
  [155, "Matte Foilage Green", "#2b302b", 3],
  [156, "Default Alloy", "#414347", 1],
  [157, "Epsilon Blue", "#6690b5", 2],
  [158, "Pure Gold", "#47391b", 8],
  [159, "Brushed Gold", "#47391b", 9],
  [160, "Spec Gold", "#ffd859", 8],
];

function encodeSrgb(byte) {
  const linear = byte / 255;
  const encoded = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, encoded)) * 255);
}

/** Display hex for a raw game colour ("#rrggbb" or "0xAARRGGBB"); null when malformed. */
export function gameColorToHex(raw) {
  const match = /^(?:#|0x)?(?:[0-9a-f]{2})?([0-9a-f]{6})$/i.exec(String(raw ?? "").trim());
  if (!match) return null;
  const value = Number.parseInt(match[1], 16);
  return `#${[value >> 16, (value >> 8) & 0xff, value & 0xff]
    .map((byte) => encodeSrgb(byte).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Finish id from a carcols metallicID ("EVehicleModelColorMetallic_3", "normal", "3"); null when unknown. */
export function parseMetallicId(raw) {
  const text = String(raw ?? "").trim().toLowerCase().replace(/^evehiclemodelcolormetallic_/, "");
  if (text === "normal" || text === "none") return 0;
  const id = Number(text);
  return Number.isInteger(id) && id >= 0 && id < GTA_PAINT_FINISHES.length ? id : null;
}

export const GTA_VEHICLE_COLORS = TABLE.map(([index, name, gameHex, finish]) => ({
  index,
  name,
  gameHex,
  hex: gameColorToHex(gameHex),
  finish,
}));

export const GTA_VEHICLE_COLOR_MAX_INDEX = TABLE[TABLE.length - 1][0];

const BY_INDEX = new Map(GTA_VEHICLE_COLORS.map((entry) => [entry.index, entry]));

export function getVehicleColor(index) {
  return BY_INDEX.get(index) || null;
}
