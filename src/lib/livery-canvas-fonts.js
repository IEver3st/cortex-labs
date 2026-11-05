import barlow800Italic from "@fontsource/barlow-condensed/files/barlow-condensed-latin-800-italic.woff2?url";
import barlow700Italic from "@fontsource/barlow-condensed/files/barlow-condensed-latin-700-italic.woff2?url";
import space700 from "@fontsource/space-grotesk/files/space-grotesk-latin-700-normal.woff2?url";
import space500 from "@fontsource/space-grotesk/files/space-grotesk-latin-500-normal.woff2?url";
import syne800 from "@fontsource/syne/files/syne-latin-800-normal.woff2?url";
import jetbrains600 from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-600-normal.woff2?url";
import shareTech400 from "@fontsource/share-tech-mono/files/share-tech-mono-latin-400-normal.woff2?url";

const URLS = {
  "barlow-800i": barlow800Italic,
  "barlow-700i": barlow700Italic,
  "space-700": space700,
  "space-500": space500,
  "syne-800": syne800,
  "jetbrains-600": jetbrains600,
  "share-tech-400": shareTech400,
};

export function bundledFontUrl(id) {
  const url = URLS[id];
  return url ? new URL(url, globalThis.location?.href || "http://localhost/").href : "";
}
