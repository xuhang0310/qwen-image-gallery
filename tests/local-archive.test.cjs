const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const sharp = require("sharp");
const { createStorage } = require("../lib/storage");

const listen = async (app) => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return server;
};
const stop = (server) => {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
};

test("Local images are served from the archived copy after ComfyUI loses its output; unrelated archive paths are ignored", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-archive-test-"));
  const output = path.join(root, "images");
  const png = await sharp({
    create: { width: 640, height: 480, channels: 3, background: "#c33" },
  })
    .png()
    .toBuffer();
  const image = {
    filename: "qwen-workbench-abc_00001_.png",
    subfolder: "qwen-workbench",
    type: "output",
  };
  let comfyHasOutput = true;
  const comfy = express();
  comfy.get("/history/:id", (req, res) =>
    res.json({
      [req.params.id]: {
        status: { completed: true, messages: [] },
        outputs: { 9: { images: [image] } },
      },
    }),
  );
  comfy.get("/view", (req, res) =>
    comfyHasOutput && req.query.filename === image.filename
      ? res.type("png").send(png)
      : res.status(404).send("missing"),
  );
  const comfyServer = await listen(comfy);

  // A record from an imported project must not expose arbitrary files.
  const foreign = path.join(root, "secret.png");
  fs.writeFileSync(foreign, png);
  const seed = createStorage(root);
  seed.put("job-1", {
    id: "job-1",
    provider: "local",
    status: "queued",
    prompt: "红色",
    createdAt: Date.now(),
    imageOutputDir: output,
  });
  seed.put("imported", {
    id: "imported",
    provider: "local",
    status: "completed",
    createdAt: Date.now() - 1000,
    images: [{ ...image, filename: "foreign.png" }],
    savedImages: [{ filename: "secret.png", path: foreign }],
  });
  seed.close();

  const previous = {
    DATA_DIR: process.env.DATA_DIR,
    COMFYUI_BASE_URL: process.env.COMFYUI_BASE_URL,
  };
  process.env.DATA_DIR = root;
  process.env.COMFYUI_BASE_URL = `http://127.0.0.1:${comfyServer.address().port}`;
  delete require.cache[require.resolve("../server")];
  let app;
  try {
    app = require("../server");
  } finally {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
  const server = await listen(app);
  t.after(async () => {
    await stop(server);
    await stop(comfyServer);
    app.closeStorage();
    assert.ok(root.startsWith(path.join(os.tmpdir(), "qwen-archive-test-")));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const get = (url) => fetch(`http://127.0.0.1:${server.address().port}${url}`);
  const query = (value) => new URLSearchParams(value).toString();

  const job = await (await get("/api/jobs/job-1")).json();
  assert.equal(job.status, "completed");
  assert.equal(job.savedImages.length, 1);
  assert.deepEqual(fs.readFileSync(job.savedImages[0].path), png);

  comfyHasOutput = false;
  const view = await get("/api/images/view?" + query(image));
  assert.equal(view.status, 200);
  assert.match(view.headers.get("content-type"), /image\/png/);
  assert.deepEqual(Buffer.from(await view.arrayBuffer()), png);

  const thumbnail = await get(
    "/api/images/view?" + query(image) + "&thumbnail=1",
  );
  assert.equal(thumbnail.status, 200);
  const info = await sharp(
    Buffer.from(await thumbnail.arrayBuffer()),
  ).metadata();
  assert.equal(info.format, "webp");
  assert.equal(info.width, 440);

  const download = await get("/api/images/download?" + query(image));
  assert.equal(download.status, 200);
  assert.match(
    download.headers.get("content-disposition"),
    new RegExp(encodeURIComponent(image.filename).replace(/[.]/g, "\\.")),
  );
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), png);

  const ignored = await get(
    "/api/images/view?" + query({ ...image, filename: "foreign.png" }),
  );
  assert.equal(ignored.status, 404);
  assert.equal(ignored.headers.get("content-disposition"), null);
});
