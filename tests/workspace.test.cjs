const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const express = require("express");
const { createStorage } = require("../lib/storage");
const { createWorkbenchSettings } = require("../lib/workbench-settings");
function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-workspace-test-"));
  t.after(() => {
    assert.ok(root.startsWith(path.join(os.tmpdir(), "qwen-workspace-test-")));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
const board = (title) => ({
  jobs: [],
  videoJobs: [],
  hiddenJobIds: [],
  board: {
    nodes: [{ id: title, status: "text", x: 12, y: 28, prompt: title }],
    edges: [],
    pan: { x: 41, y: 63 },
    zoom: 0.7,
  },
});
test("Legacy canvas is migrated once; projects keep independent boards, revisions and active selection across restart", (t) => {
  const root = directory(t);
  const old = new DatabaseSync(path.join(root, "workbench.sqlite"));
  old.exec(
    "CREATE TABLE project (id INTEGER PRIMARY KEY, revision INTEGER, data TEXT)",
  );
  old
    .prepare("INSERT INTO project VALUES (1, 7, ?)")
    .run(JSON.stringify(board("旧画布")));
  old.close();
  let storage = createStorage(root);
  assert.equal(storage.project().id, "default");
  assert.equal(storage.project().revision, 7);
  assert.deepEqual(storage.project().board, board("旧画布").board);
  const newProject = storage.createProject("新项目");
  assert.equal(storage.project(newProject.id).board.nodes.length, 0);
  assert.equal(storage.saveProject(board("新的画布"), 0, newProject.id), 1);
  assert.equal(storage.saveProject(board("错误覆盖"), 0, newProject.id), null);
  assert.equal(storage.project("default").board.nodes[0].prompt, "旧画布");
  assert.equal(storage.activateProject(newProject.id), true);
  assert.equal(storage.renameProject(newProject.id, "改名"), true);
  storage.close();
  storage = createStorage(root);
  assert.equal(storage.projects().length, 2);
  assert.equal(storage.project().name, "改名");
  assert.equal(storage.project().board.nodes[0].prompt, "新的画布");
  assert.equal(storage.saveProject(board("旧窗口保存"), 7, "default"), 8);
  assert.equal(storage.project().board.nodes[0].prompt, "新的画布");
  assert.equal(storage.deleteProject(newProject.id), true);
  assert.equal(storage.project().id, "default");
  assert.throws(() => storage.deleteProject("default"), /至少保留/);
  storage.close();
});
test("Image output settings validate writable directories, survive restart and preserve in-flight targets without overwriting unrelated files", async (t) => {
  const root = directory(t),
    outputA = path.join(root, "images-a"),
    outputB = path.join(root, "images-b");
  const settings = createWorkbenchSettings({ app: express(), dataDir: root });
  await assert.rejects(
    settings.save({ imageOutputDir: "relative/path" }),
    /完整路径/,
  );
  await settings.save({ imageOutputDir: outputA });
  const first = { id: "job-a", imageOutputDir: settings.capture() };
  await settings.save({ imageOutputDir: outputB });
  const bytes = Buffer.from("original-image-bytes");
  const archived = await settings.archive(
    first,
    [{ filename: "output.png" }],
    async () => bytes,
  );
  assert.deepEqual(fs.readFileSync(archived.savedImages[0].path), bytes);
  assert.ok(archived.savedImages[0].path.startsWith(outputA));
  assert.equal(
    createWorkbenchSettings({ app: express(), dataDir: root }).capture(),
    outputB,
  );
  const duplicate = await settings.archive(
    first,
    [{ filename: "output.png" }],
    async () => bytes,
  );
  assert.equal(duplicate.imageSaveError, undefined);
  const conflicting = await settings.archive(
    first,
    [{ filename: "output.png" }],
    async () => Buffer.from("different"),
  );
  assert.match(conflicting.imageSaveError, /未覆盖/);
  assert.deepEqual(fs.readFileSync(archived.savedImages[0].path), bytes);
  assert.deepEqual(
    await settings.archive({ id: "legacy" }, [], async () => bytes),
    {},
  );
});
test("Project API imports without a revision and keeps legacy-window saves on the default project after switching", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "qwen-workspace-api-test-"),
  );
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = root;
  let app;
  try {
    app = require("../server");
  } finally {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
  }
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    app.closeStorage();
    assert.ok(
      root.startsWith(path.join(os.tmpdir(), "qwen-workspace-api-test-")),
    );
    fs.rmSync(root, { recursive: true, force: true });
  });
  const request = async (url, method = "GET", body) => {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}${url}`,
      {
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    return { status: response.status, data: await response.json() };
  };
  const imported = await request("/api/projects", "POST", {
    name: "导入的项目",
    data: board("导入节点"),
  });
  assert.equal(imported.status, 201);
  const id = imported.data.id;
  assert.equal(
    (await request(`/api/projects/${id}/activate`, "POST", {})).status,
    200,
  );
  assert.equal((await request("/api/projects")).data.activeProjectId, id);
  assert.equal(
    (await request(`/api/projects/${id}`)).data.board.nodes[0].prompt,
    "导入节点",
  );
  assert.equal(
    (await request("/api/project", "PUT", { ...board("旧窗口"), revision: 0 }))
      .status,
    200,
  );
  assert.equal(
    (await request("/api/project")).data.board.nodes[0].prompt,
    "旧窗口",
  );
  assert.equal(
    (await request(`/api/projects/${id}`)).data.board.nodes[0].prompt,
    "导入节点",
  );
  assert.equal(
    (
      await request("/api/project", "PUT", {
        ...board("修改项目"),
        projectId: id,
        revision: 0,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request("/api/project", "PUT", {
        ...board("过期窗口"),
        projectId: id,
        revision: 0,
      })
    ).status,
    409,
  );
  assert.equal(
    (await request(`/api/projects/${id}`)).data.board.nodes[0].prompt,
    "修改项目",
  );
  assert.equal(
    (await request("/api/projects", "POST", { name: "" })).status,
    400,
  );
  const invalid = board("无效缩略图");
  invalid.board.nodes[0].thumbnailUrl = "https://example.com/image.png";
  assert.equal(
    (
      await request("/api/projects", "POST", {
        name: "错误项目",
        data: invalid,
      })
    ).status,
    400,
  );
});
