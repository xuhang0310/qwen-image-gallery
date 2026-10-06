export const videoReferenceRoles = { character: "人物", scene: "场景" };
export const maxVideoReferences = 9;

export function validateVideoReferences(parameters) {
  const refs = parameters.references;
  if (refs === undefined) return [];
  if (!Array.isArray(refs) || !refs.length || refs.length > maxVideoReferences)
    throw new Error("请连接 1–9 张视频参考图");
  if (parameters.sourceImage)
    throw new Error("请使用多图参考列表，不能同时提交首帧图");
  for (const ref of refs) {
    const s = ref?.sourceImage;
    if (
      !Object.hasOwn(videoReferenceRoles, ref?.role || "") ||
      !s ||
      typeof s.name !== "string" ||
      !s.name ||
      s.name.length > 255 ||
      typeof s.subfolder !== "string" ||
      s.subfolder.length > 500 ||
      !["input", "output", "temp"].includes(s.type) ||
      (s.provider !== undefined && !["api", "local"].includes(s.provider))
    )
      throw new Error("视频参考图或用途无效，请重新选择");
  }
  return refs;
}

export function videoReferenceLabels(refs = []) {
  const counts = { character: 0, scene: 0 };
  return refs.map(
    (ref) => `${videoReferenceRoles[ref.role]}参考 ${++counts[ref.role]}`,
  );
}

export function videoReferenceDirections(refs = []) {
  const counts = { character: 0, scene: 0 };
  return refs
    .map((ref, i) => {
      const n = ++counts[ref.role];
      return ref.role === "character"
        ? `<Picture ${i + 1}> is character reference ${n}: use the person's identity, face, hair and clothing in the target scene.`
        : `<Picture ${i + 1}> is scene reference ${n}: use the environment, layout, objects and lighting. Place the referenced character naturally in this environment. The timeline specifies which scene reference is active when multiple scenes are provided.`;
    })
    .join("\n");
}
