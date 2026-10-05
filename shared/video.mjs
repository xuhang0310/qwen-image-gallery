export const videoQualities = {
  "480P": { width: 854, height: 480, renderWidth: 864, renderHeight: 480 },
  "720P": { width: 1280, height: 720, renderWidth: 1280, renderHeight: 736 },
};
export const videoRatios = {
  "9:16": "竖版",
  "16:9": "横版",
  "1:1": "方形",
};
export function videoDimensions(quality, ratio = "16:9") {
  if (!Object.hasOwn(videoQualities, quality)) return undefined;
  const preset = videoQualities[quality];
  if (!preset || !Object.hasOwn(videoRatios, ratio)) return undefined;
  if (ratio === "16:9") return { ...preset };
  if (ratio === "9:16")
    return {
      width: preset.height,
      height: preset.width,
      renderWidth: preset.renderHeight,
      renderHeight: preset.renderWidth,
    };
  return {
    width: preset.height,
    height: preset.height,
    renderWidth: preset.renderHeight,
    renderHeight: preset.renderHeight,
  };
}
export const videoDurations = [4, 6, 8, 10];
export const videoFrames = (seconds) =>
  Math.ceil((seconds * 24 - 5) / 17) * 17 + 5;
export const safeVideoUrl = (url) =>
  typeof url === "string" &&
  /^\/api\/videos\/media\/[a-f0-9-]+(?:\?download=1)?$/.test(url);
