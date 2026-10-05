import catalog from "./api-image.json" with { type: "json" };

export const apiQualityValues = [
  "low",
  "medium",
  "high",
  "auto",
  "xhigh",
  "max",
];
export function imageModel(model) {
  if (typeof model !== "string" || model.length > 100) return null;
  const id = Object.hasOwn(catalog.legacyModelAliases, model)
    ? catalog.legacyModelAliases[model]
    : model;
  const known = catalog.models.find((entry) => entry.id === id);
  if (known) return known;
  return null;
}
export function imageModels(extra = []) {
  const entries = new Map(catalog.models.map((entry) => [entry.id, entry]));
  for (const id of extra) {
    const entry = imageModel(id);
    if (entry) entries.set(entry.id, entry);
  }
  return [...entries.values()];
}
export function imageProfile(model) {
  const entry = imageModel(model);
  if (!entry) return null;
  const override = catalog.profiles[entry.profile];
  const qualities = {
    ...(override.qualities || catalog.qualities),
    ...override.extraQualities,
  };
  const ratios = Object.fromEntries(
    Object.entries(override.ratios || catalog.ratios).map(([key, ratio]) => [
      key,
      {
        ...ratio,
        ...Object.fromEntries(
          Object.entries(qualities).map(([quality, settings]) => [
            quality,
            ratio[quality] || ratio[settings.dimensionQuality],
          ]),
        ),
      },
    ]),
  );
  return {
    qualities,
    ratios,
    note: override.note,
    model: entry.id,
    provider: "api",
  };
}
export function fitImageParameters(parameters, config) {
  const next = { ratio: parameters.ratio, quality: parameters.quality };
  if (!Object.hasOwn(config.ratios, next.ratio)) {
    const [w, h] = String(next.ratio || "1:1")
      .split(":")
      .map(Number);
    const candidates = Object.keys(config.ratios);
    next.ratio = candidates.reduce((best, candidate) => {
      const [cw, ch] = candidate.split(":").map(Number);
      const [bw, bh] = best.split(":").map(Number);
      return Math.abs(cw / ch - w / h) < Math.abs(bw / bh - w / h)
        ? candidate
        : best;
    }, candidates[0]);
  }
  if (!Object.hasOwn(config.qualities, next.quality))
    next.quality = Object.hasOwn(config.qualities, "2K")
      ? "2K"
      : Object.keys(config.qualities)[0];
  return next;
}
