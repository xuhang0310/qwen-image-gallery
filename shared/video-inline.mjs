import { videoReviewReady, validateVideoPromptNode } from "./video-review.mjs";
import { videoReferenceLabels } from "./video-references.mjs";
import { timelineText } from "./video-timeline.mjs";

export function originalVideoPrompt(node) {
  if (typeof node.originalPrompt === "string") return node.originalPrompt;
  return node.inlineVideo ? null : node.prompt || "";
}

export function optimizedVideoText(review, parameters) {
  const labels = parameters.sourceImage
    ? ["人物参考 1"]
    : videoReferenceLabels(parameters.references || []);
  const readable = (value) =>
    String(value || "").replace(
      /<Picture (\d+)>/g,
      (tag, ordinal) => labels[Number(ordinal) - 1] || tag,
    );
  const p = review.performance;
  const parts = [readable(review.scene)];
  if (p) parts.push(...[p.overview, p.startingState, p.camera].map(readable));
  parts.push(readable(timelineText(review.timeline)));
  for (const [i, beat] of (p?.beats || []).entries())
    parts.push(
      `第${i + 1}句表演：${readable(beat.face)}；音量：${readable(beat.volume)}；语速：${readable(beat.pace)}；音高：${readable(beat.pitch)}。${beat.pauseBefore ? `句前双唇闭着停顿${beat.pauseBefore}秒。` : ""}`,
    );
  if (review.music) parts.push("音乐与动作节奏配合。");
  if (review.backgroundMusic) parts.push("配合场景的背景伴奏。");
  if (review.vocalMode !== "none") {
    const label = {
      speech: "人物台词",
      singing: "人物唱歌",
      voiceover: "旁白",
    }[review.vocalMode];
    parts.push(`${label}（原文）：${review.vocalText}`);
  }
  const text = parts.filter(Boolean).join("\n\n");
  if (text.length > 4000)
    throw new Error("优化结果超过输入框的 4000 字限制，请简化描述后重试");
  return text;
}

export function validateInlineVideoCache(cache) {
  if (cache === undefined) return;
  if (
    !cache ||
    typeof cache.signature !== "string" ||
    cache.signature.length > 20000 ||
    !cache.review
  )
    throw new Error("视频后台提示词格式无效，请重新优化");
  validateVideoPromptNode({
    videoParameters: cache.parameters,
    review: cache.review,
  });
}

export function inlineVideoInputSignature(
  node,
  references = [],
  workflowPreset,
) {
  return JSON.stringify([
    node.prompt,
    node.dialogue || "",
    node.quality,
    node.ratio,
    node.seconds,
    node.framing || "contain",
    node.seed,
    workflowPreset,
    references.map((r, i) => [
      r.id,
      node.referenceRoles?.[r.id] || (i === 0 ? "character" : "scene"),
      r.url,
      r.sourceImage
        ? [
            r.sourceImage.name,
            r.sourceImage.subfolder,
            r.sourceImage.type,
            r.sourceImage.provider || "local",
          ]
        : null,
    ]),
  ]);
}

export async function inlineVideoAction(
  node,
  {
    optimize = false,
    signature,
    isPresent,
    isEngineReady,
    prepare,
    submit,
    notify,
  },
) {
  if (node.inlinePending || node.referencesUploading || !isPresent())
    return false;
  if (!node.prompt?.trim()) {
    notify("请填写画面描述");
    return false;
  }
  if (!optimize && !isEngineReady()) {
    notify("请先连接视频引擎");
    return false;
  }
  node.inlinePending = optimize ? "optimize" : "generate";
  node.inlineError = "";
  const before = signature();
  const inputPrompt = node.prompt;
  try {
    let prepared =
      !optimize &&
      node.inlineVideo?.signature === before &&
      videoReviewReady(node.inlineVideo.review, node.inlineVideo.parameters)
        ? node.inlineVideo
        : await prepare(optimize);
    if (!isPresent()) return false;
    if (before !== signature())
      throw new Error("内容或参考图已变化，请重试；当前输入未被覆盖");
    if (!videoReviewReady(prepared.review, prepared.parameters))
      throw new Error("视频提示词尚未整理完成，请重试");
    if (typeof node.originalPrompt !== "string" && !node.inlineVideo)
      node.originalPrompt = inputPrompt;
    if (optimize) node.prompt = prepared.parameters.prompt;
    node.inlineVideo = JSON.parse(
      JSON.stringify({
        parameters: prepared.parameters,
        review: prepared.review,
        signature: signature(),
      }),
    );
    if (optimize) {
      notify("提示词已优化，可以继续编辑或生成视频");
      return true;
    }
    if (!isEngineReady()) throw new Error("视频引擎连接已断开，请重新连接");
    await submit(
      JSON.parse(
        JSON.stringify({
          ...node.inlineVideo.parameters,
          review: node.inlineVideo.review,
          approved: true,
        }),
      ),
    );
    return true;
  } catch (error) {
    if (isPresent()) node.inlineError = error.message;
    notify(error.message);
    return false;
  } finally {
    node.inlinePending = false;
  }
}
