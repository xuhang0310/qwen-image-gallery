import { videoDimensions, videoDurations } from "./video.mjs";
import { validatePerformance } from "./video-performance.mjs";
import { validateTimeline } from "./video-timeline.mjs";
import { validateVideoReferences } from "./video-references.mjs";
export const vocalModes = {
  none: "无台词",
  speech: "人物说话",
  singing: "人物唱歌",
  voiceover: "画外音",
};

export function validateVideoReview(review, { allowIncomplete = false } = {}) {
  if (
    !review ||
    review.version !== 1 ||
    typeof review.scene !== "string" ||
    review.scene.length > 4000 ||
    (!allowIncomplete && !review.scene.trim()) ||
    !Object.hasOwn(vocalModes, review.vocalMode) ||
    typeof review.vocalText !== "string" ||
    review.vocalText.length > 200 ||
    typeof review.music !== "boolean" ||
    typeof review.backgroundMusic !== "boolean"
  )
    throw new Error("提示词卡片内容无效，请重新整理");
  if (
    !allowIncomplete &&
    review.vocalMode !== "none" &&
    !review.vocalText.trim()
  )
    throw new Error("请填写台词或歌词，或选择无台词");
  if (!allowIncomplete && /<\/?d>|\[CN\]/.test(review.scene + review.vocalText))
    throw new Error("请直接填写画面与台词，不要添加模型标记");
  if (
    review.speechSpeed !== undefined &&
    !["slow", "fast"].includes(review.speechSpeed)
  )
    throw new Error("台词语速无效");
  if (review.performance && !allowIncomplete)
    validatePerformance(review.performance, review.vocalText, review.vocalMode);
  if (
    review.performance &&
    allowIncomplete &&
    JSON.stringify(review.performance).length > 14000
  )
    throw new Error("表演方案过长");
  if (
    allowIncomplete &&
    review.performanceEnglish &&
    JSON.stringify(review.performanceEnglish).length > 14000
  )
    throw new Error("表演英文说明过长");
  return review;
}

// The reviewed prompt is tied to the visible brief and the frozen source/parameters.
export function videoReviewSignature(review, parameters) {
  const source = parameters.sourceImage;
  return JSON.stringify([
    review.version,
    review.scene,
    review.vocalMode,
    review.vocalText,
    review.music,
    review.backgroundMusic,
    parameters.prompt,
    parameters.quality,
    parameters.ratio || "16:9",
    parameters.seconds,
    parameters.framing,
    parameters.seed,
    source
      ? [source.name, source.subfolder, source.type, source.provider || "local"]
      : null,
    review.workflowPreset,
    ...(review.performance || review.speechSpeed
      ? [review.performance, review.speechSpeed]
      : []),
    ...(review.timeline ? [review.timeline] : []),
    ...(parameters.references
      ? [
          parameters.references.map(({ role, sourceImage: s }) => [
            role,
            s.name,
            s.subfolder,
            s.type,
            s.provider || "local",
          ]),
        ]
      : []),
  ]);
}

export function videoReviewReady(review, parameters) {
  try {
    validateVideoReview(review);
    validateVideoReferences(parameters);
    if (review.timeline) validateTimeline(review.timeline, parameters.seconds);
    return (
      typeof review.enginePrompt === "string" &&
      review.enginePrompt.length > 0 &&
      review.enginePrompt.length <= 16000 &&
      review.compiledSignature === videoReviewSignature(review, parameters)
    );
  } catch {
    return false;
  }
}

export function validateVideoPromptNode(node) {
  const p = node.videoParameters;
  if (p) validateVideoReferences(p);
  if (
    !p ||
    typeof p.prompt !== "string" ||
    !p.prompt.trim() ||
    p.prompt.length > 4000 ||
    !videoDimensions(p.quality, p.ratio) ||
    !videoDurations.includes(p.seconds) ||
    !["contain", "cover", "front"].includes(p.framing) ||
    (p.seed !== undefined &&
      (!Number.isSafeInteger(p.seed) || p.seed < 0 || p.seed > 2147483647))
  )
    throw new Error("视频提示词节点参数无效");
  if (node.review) {
    validateVideoReview(node.review, { allowIncomplete: true });
    for (const key of ["timeline", "timelineEnglish"])
      if (
        node.review[key] &&
        (!Array.isArray(node.review[key]) ||
          node.review[key].length > 12 ||
          JSON.stringify(node.review[key]).length > 14000)
      )
        throw new Error("时间分段内容无效");
    for (const [key, limit] of [
      ["enginePrompt", 16000],
      ["compiledSignature", 16000],
      ["sceneEnglish", 8000],
    ])
      if (
        node.review[key] !== undefined &&
        (typeof node.review[key] !== "string" ||
          node.review[key].length > limit)
      )
        throw new Error("视频提示词预览内容无效");
  }
}
