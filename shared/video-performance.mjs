export function validatePerformance(plan, vocalText, mode) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan))
    throw new Error("表演方案格式无效");
  if (JSON.stringify(plan).length > 6000)
    throw new Error("表演方案过长，请缩短动作说明");
  for (const [key, limit] of [
    ["overview", 1000],
    ["startingState", 1000],
    ["camera", 1000],
  ])
    if (
      typeof plan[key] !== "string" ||
      !plan[key].trim() ||
      plan[key].length > limit
    )
      throw new Error("请填写表演总纲、起始状态与镜头");
  if (!Array.isArray(plan.beats) || plan.beats.length > 8)
    throw new Error("逐句表演最多八句");
  for (const beat of plan.beats) {
    for (const key of ["line", "face", "volume", "pace", "pitch"])
      if (
        typeof beat[key] !== "string" ||
        !beat[key].trim() ||
        beat[key].length > (key === "line" ? 200 : 600)
      )
        throw new Error("每句表演需包含台词、脸部动作、音量、语速与音高");
    if (
      typeof beat.pauseBefore !== "number" ||
      !Number.isFinite(beat.pauseBefore) ||
      beat.pauseBefore < 0 ||
      beat.pauseBefore > 2
    )
      throw new Error("句前闭嘴停顿应为 0–2 秒");
  }
  const compact = (value) => value.replace(/\s/g, "");
  if (
    mode === "none"
      ? plan.beats.length !== 0
      : !plan.beats.length ||
        compact(plan.beats.map((b) => b.line).join("")) !== compact(vocalText)
  )
    throw new Error("逐句台词必须完整保留台词原文和标点");
  return plan;
}

export function performanceSignature(review) {
  return JSON.stringify([
    review.scene,
    review.vocalMode,
    review.vocalText,
    review.performance,
    review.timeline,
  ]);
}

export function performanceWarnings(review, seconds, speed = "slow") {
  if (review.vocalMode === "none" || !review.vocalText) return [];
  const count = Array.from(
    review.vocalText.replace(/[\s\p{P}\p{S}]/gu, ""),
  ).length;
  const pauses =
    review.performance?.beats?.reduce((total, b) => total + b.pauseBefore, 0) ||
    0;
  const budget = Math.floor(
    Math.max(0, seconds - pauses) * (speed === "fast" ? 4.6 : 3.5),
  );
  return count > budget
    ? [
        `台词约 ${count} 字，扣除闭嘴停顿后，${seconds} 秒${speed === "fast" ? "快" : "慢"}台词建议约 ${budget} 字。可延长时长或手动精简台词。`,
      ]
    : [];
}

export function englishPerformanceText(plan) {
  return [
    plan.overview,
    plan.startingState,
    plan.camera,
    ...plan.beats.flatMap((b) => [b.face, b.volume, b.pace, b.pitch]),
  ].join("\n");
}
