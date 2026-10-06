const test = require("node:test");
const assert = require("node:assert/strict");
const {
  beginImageEdit,
  attachImageEdit,
  failImageEdit,
  syncImageEdit,
} = require("../shared/image-edit.mjs");
const image = () => ({
  id: "original",
  x: 123,
  y: 456,
  status: "done",
  jobId: "old-job",
  url: "/api/images/view?filename=old.png",
  thumbnailUrl: "/api/images/view?filename=old.png&thumbnail=1",
  width: 512,
  height: 768,
  prompt: "原图",
  ratio: "9:16",
  quality: "2K",
  sourceImage: { name: "old-input.png", subfolder: "inputs", type: "input" },
});
const parameters = { prompt: "把衣服换成蓝色", ratio: "4:3", quality: "1K" };

test("Image editing keeps the original visible while queued and replaces only that node after completion", () => {
  const node = image(),
    before = structuredClone(node);
  const board = {
    nodes: [node, { id: "video" }],
    edges: [{ from: node.id, to: "video" }],
  };
  assert.equal(beginImageEdit(node, parameters), true);
  assert.equal(beginImageEdit(node, parameters), false);
  attachImageEdit(node, { id: "edit-job", status: "queued" });
  syncImageEdit(node, { id: "edit-job", status: "running" });
  for (const [key, value] of Object.entries(before))
    assert.deepEqual(node[key], value);
  assert.equal(
    syncImageEdit(node, {
      id: "old-job",
      status: "completed",
      imageUrl: "stale",
    }),
    false,
  );
  assert.equal(
    syncImageEdit(node, {
      id: "edit-job",
      status: "completed",
      provider: "api",
      model: "gpt-image-2",
      imageUrl: "/api/images/view?filename=new.png",
      thumbnailUrl: "/api/images/view?filename=new-thumb.png",
      finalWidth: 1200,
      finalHeight: 900,
    }),
    true,
  );
  assert.equal(board.nodes.length, 2);
  assert.deepEqual(board.edges, [{ from: "original", to: "video" }]);
  assert.equal(node.id, before.id);
  assert.equal(node.x, before.x);
  assert.equal(node.y, before.y);
  assert.equal(node.url, "/api/images/view?filename=new.png");
  assert.equal(node.jobId, "edit-job");
  assert.equal(node.width, 1200);
  assert.equal(node.prompt, parameters.prompt);
  assert.equal(node.ratio, "4:3");
  assert.equal(node.sourceImage, undefined);
  assert.equal(node.imageEdit, undefined);
});

test("Failed, cancelled and rejected edits preserve original pixels and permit a retry without accepting stale completions", () => {
  for (const status of [
    "failed",
    "cancelled",
    "completed",
    "submission-failure",
  ]) {
    const node = image(),
      before = structuredClone(node);
    beginImageEdit(node, parameters);
    attachImageEdit(node, { id: "failed-job", status: "queued" });
    if (status === "submission-failure") failImageEdit(node, "连接失败");
    else syncImageEdit(node, { id: "failed-job", status, error: "失败或取消" });
    for (const [key, value] of Object.entries(before))
      assert.deepEqual(node[key], value);
    assert.ok(node.imageEditError);
    assert.equal(node.imageEdit, undefined);
    assert.equal(beginImageEdit(node, parameters), true);
    attachImageEdit(node, { id: "retry-job", status: "queued" });
    assert.equal(
      syncImageEdit(node, {
        id: "failed-job",
        status: "completed",
        imageUrl: "old attempt",
      }),
      false,
    );
    assert.equal(node.url, before.url);
  }
});

test("Project restoration resumes a submitted edit and resets interrupted preparations while keeping links and original images", async () => {
  const { createServer } = await import("vite");
  const server = await createServer({
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  try {
    const { normalizeBoard } = await server.ssrLoadModule("/src/domain.js");
    const node = image();
    beginImageEdit(node, parameters);
    attachImageEdit(node, { id: "pending-job", status: "queued" });
    const restored = normalizeBoard(
      JSON.parse(
        JSON.stringify({
          nodes: [node, { id: "target", x: 1, y: 2, status: "text" }],
          edges: [
            {
              id: "e",
              from: "original",
              to: "target",
              fromSide: "right",
              toSide: "left",
            },
          ],
        }),
      ),
    );
    assert.equal(restored.nodes[0].imageEdit.jobId, "pending-job");
    assert.equal(restored.edges.length, 1);
    syncImageEdit(restored.nodes[0], {
      id: "pending-job",
      status: "completed",
      imageUrl: "/api/images/view?filename=restored.png",
      width: 400,
      height: 300,
    });
    assert.equal(
      restored.nodes[0].url,
      "/api/images/view?filename=restored.png",
    );
    const interrupted = image();
    beginImageEdit(interrupted, parameters);
    const fixed = normalizeBoard({ nodes: [interrupted] }).nodes[0];
    assert.equal(fixed.imageEdit, undefined);
    assert.equal(fixed.url, interrupted.url);
    assert.ok(fixed.imageEditError);
  } finally {
    await server.close();
  }
});
