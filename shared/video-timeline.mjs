export function validateTimeline(timeline, seconds) {
  if (!Array.isArray(timeline) || !timeline.length || timeline.length > 12)
    throw new Error("请填写 1–12 个时间段");
  let end = 0;
  for (const [i, segment] of timeline.entries()) {
    if (
      !segment ||
      !Number.isFinite(segment.start) ||
      !Number.isFinite(segment.end) ||
      segment.start < 0 ||
      segment.end <= segment.start ||
      segment.end > seconds + 0.001
    )
      throw new Error(`第 ${i + 1} 段时间应递增，且在 0–${seconds}s 内`);
    if (Math.abs(segment.start - end) > 0.001)
      throw new Error(`第 ${i + 1} 段应从 ${end}s 开始，时间段不能重叠或留空`);
    if (
      typeof segment.action !== "string" ||
      !segment.action.trim() ||
      segment.action.length > 1200
    )
      throw new Error(`请填写第 ${i + 1} 段动作（不超过 1200 字）`);
    end = segment.end;
  }
  if (Math.abs(end - seconds) > 0.001)
    throw new Error(`最后一段需结束于 ${seconds}s`);
  return timeline;
}
export const timelineText = (timeline) =>
  timeline.map((s) => `${s.start}–${s.end}s: ${s.action}`).join("\n");
export function defaultTimeline(review, seconds, english = false) {
  const plan = english ? review.performanceEnglish : review.performance;
  if (plan?.beats?.length) {
    const pauses = plan.beats.reduce((n, b) => n + b.pauseBefore, 0);
    const weights = plan.beats.map((b) =>
      Math.max(1, Array.from(b.line.replace(/[\s\p{P}\p{S}]/gu, "")).length),
    );
    const total = weights.reduce((a, b) => a + b, 0);
    let cursor = 0;
    return plan.beats.map((b, i) => {
      const start = cursor;
      cursor =
        i === weights.length - 1
          ? seconds
          : Math.round(
              (cursor +
                b.pauseBefore +
                (Math.max(0, seconds - pauses) * weights[i]) / total) *
                1000,
            ) / 1000;
      return {
        start,
        end: cursor,
        action: english
          ? `${b.pauseBefore ? `Lips fully closed during a ${b.pauseBefore}s pause at this segment's start. ` : ""}As sentence ${i + 1} begins: ${b.face} Voice volume: ${b.volume}; pace: ${b.pace}; pitch: ${b.pitch}.`
          : `${b.pauseBefore ? `本段开始双唇闭着停顿 ${b.pauseBefore}s。` : ""}第 ${i + 1} 句说出口时：${b.face}声音：${b.volume}；语速：${b.pace}；音高：${b.pitch}。`,
      };
    });
  }
  const middle = Math.round((seconds / 2) * 1000) / 1000;
  return [
    {
      start: 0,
      end: middle,
      action: english ? review.sceneEnglish : review.scene,
    },
    {
      start: middle,
      end: seconds,
      action: english
        ? "Continue and complete the described movements and performance."
        : "继续并完成上述动作与表演。",
    },
  ];
}
