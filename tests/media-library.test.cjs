const test = require("node:test");
const assert = require("node:assert/strict");
const library = import("../shared/media-library.mjs");
const image = (id, createdAt = 1) => ({
  id,
  createdAt,
  status: "completed",
  prompt: "陶瓷杯",
  provider: "local",
  imageUrl: `/api/images/view?filename=${id}.png&type=output`,
});

test("The library retains hidden history assets, combines API/local images and completed videos, and excludes unfinished jobs", async () => {
  const { mediaLibrary } = await library;
  const local = { ...image("local", 3), hidden: true };
  const api = { ...image("api", 5), provider: "api" };
  const video = {
    id: "video",
    createdAt: 4,
    status: "completed",
    videoUrl: "/api/videos/media/video",
    dimensions: { finalWidth: 1280, finalHeight: 720 },
  };
  const assets = mediaLibrary(
    [
      local,
      api,
      local,
      { ...image("failed"), status: "failed" },
      { ...image("queued"), status: "queued" },
    ],
    [video, { ...video, id: "running", status: "running" }],
  );
  assert.deepEqual(
    assets.map((asset) => asset.assetId),
    ["image:api:0", "video:video", "image:local:0"],
  );
  assert.equal(assets[1].finalWidth, 1280);
  assert.equal(assets[1].downloadUrl, "/api/videos/media/video?download=1");
  assert.equal(assets[2].imageUrl, local.imageUrl);
});

test("Every valid image output gets its own identity and safe preview/download links", async () => {
  const { mediaLibrary } = await library;
  const assets = mediaLibrary([
    {
      ...image("batch"),
      imageUrls: [
        {
          url: "/api/images/view?filename=first.png",
          downloadUrl: "https://unexpected.invalid/file",
        },
        { url: "https://unexpected.invalid/image.png" },
        {
          url: "/api/images/view?filename=last.png",
          thumbnailUrl: "/api/images/view?filename=last.png&thumbnail=1",
        },
      ],
    },
  ]);
  assert.deepEqual(
    assets.map((asset) => asset.assetIndex),
    [0, 2],
  );
  assert.equal(
    assets[0].downloadUrl,
    "/api/images/download?filename=first.png",
  );
  assert.equal(assets[1].imageUrl, "/api/images/view?filename=last.png");
  assert.equal(
    mediaLibrary(
      [image("missing")],
      [
        {
          id: "external",
          status: "completed",
          videoUrl: "https://unexpected.invalid/video.mp4",
        },
      ],
    ).length,
    1,
  );
});

test("Canvas reuse targets the correct output, preserves legacy first-image nodes and never confuses video and image nodes", async () => {
  const { assetOnBoard } = await library;
  const nodes = [
    { id: "legacy", jobId: "batch", status: "done" },
    { id: "second", jobId: "batch", assetIndex: 1, status: "done" },
    { id: "movie", jobId: "batch", kind: "video", status: "done" },
  ];
  assert.equal(
    assetOnBoard({ id: "batch", mediaType: "image", assetIndex: 0 }, nodes).id,
    "legacy",
  );
  assert.equal(
    assetOnBoard({ id: "batch", mediaType: "image", assetIndex: 1 }, nodes).id,
    "second",
  );
  assert.equal(
    assetOnBoard({ id: "batch", mediaType: "image", assetIndex: 2 }, nodes),
    undefined,
  );
  assert.equal(
    assetOnBoard({ id: "batch", mediaType: "video" }, nodes).id,
    "movie",
  );
});
