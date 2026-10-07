const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

function createStorage(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(path.join(directory, "workbench.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, created INTEGER NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS project (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, data TEXT NOT NULL);",
  );
  db.exec(`CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, revision INTEGER NOT NULL,
    data TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL
  ); CREATE TABLE IF NOT EXISTS project_state (id INTEGER PRIMARY KEY CHECK(id=1), active_id TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS image_archive (key TEXT PRIMARY KEY, path TEXT NOT NULL);`);
  const empty = () => ({
    jobs: [],
    videoJobs: [],
    board: { nodes: [], edges: [], pan: { x: 0, y: 0 }, zoom: 1 },
    hiddenJobIds: [],
  });
  if (!db.prepare("SELECT id FROM projects LIMIT 1").get()) {
    const legacy = db.prepare("SELECT * FROM project WHERE id=1").get();
    const now = Date.now();
    db.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)").run(
      "default",
      "默认项目",
      legacy?.revision || 0,
      legacy?.data || JSON.stringify(empty()),
      now,
      now,
    );
  }
  const activeId = () => {
    const saved = db
      .prepare("SELECT active_id FROM project_state WHERE id=1")
      .get()?.active_id;
    return (
      (saved &&
        db.prepare("SELECT id FROM projects WHERE id=?").get(saved)?.id) ||
      db.prepare("SELECT id FROM projects ORDER BY created LIMIT 1").get().id
    );
  };
  const activate = (id) => {
    if (!db.prepare("SELECT id FROM projects WHERE id=?").get(id)) return false;
    db.prepare(
      "INSERT INTO project_state VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET active_id=excluded.active_id",
    ).run(id);
    return true;
  };
  const summary = (row) => {
    const data = JSON.parse(row.data);
    const nodes = data.board?.nodes || [];
    return {
      id: row.id,
      name: row.name,
      revision: row.revision,
      createdAt: row.created,
      updatedAt: row.updated,
      nodeCount: nodes.length,
      imageCount: nodes.filter((n) => n.status === "done" && n.kind !== "video")
        .length,
      videoCount: nodes.filter((n) => n.kind === "video").length,
      coverUrl:
        nodes.find(
          (n) =>
            n.kind !== "video" &&
            n.status === "done" &&
            /^\/api\/images\/view\?/.test(n.url || ""),
        )?.thumbnailUrl ||
        nodes.find(
          (n) =>
            n.kind !== "video" &&
            n.status === "done" &&
            /^\/api\/images\/view\?/.test(n.url || ""),
        )?.url ||
        null,
    };
  };
  const get = db.prepare("SELECT data FROM jobs WHERE id=?");
  const put = db.prepare(
    "INSERT INTO jobs VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
  );
  const list = db.prepare("SELECT data FROM jobs ORDER BY created DESC");
  const putArchive = db.prepare(
    "INSERT INTO image_archive VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET path=excluded.path",
  );
  const getArchive = db.prepare("SELECT path FROM image_archive WHERE key=?");
  return {
    get: (id) => {
      const row = get.get(id);
      return row ? JSON.parse(row.data) : null;
    },
    put: (id, job) =>
      put.run(id, job.createdAt || Date.now(), JSON.stringify(job)),
    list: () => list.all().map((row) => JSON.parse(row.data)),
    // Maps a ComfyUI output (type/subfolder/filename) to its archived copy on disk.
    putArchive: (key, file) => putArchive.run(key, file),
    archivePath: (key) => getArchive.get(key)?.path || null,
    activeProjectId: activeId,
    activateProject: activate,
    projects: () =>
      db
        .prepare("SELECT * FROM projects ORDER BY updated DESC")
        .all()
        .map(summary),
    createProject: (name, data = empty()) => {
      const id = crypto.randomUUID(),
        now = Date.now();
      db.prepare("INSERT INTO projects VALUES (?, ?, 0, ?, ?, ?)").run(
        id,
        name,
        JSON.stringify(data),
        now,
        now,
      );
      return summary(db.prepare("SELECT * FROM projects WHERE id=?").get(id));
    },
    renameProject: (id, name) =>
      !!db
        .prepare("UPDATE projects SET name=?, updated=? WHERE id=?")
        .run(name, Date.now(), id).changes,
    deleteProject: (id) => {
      if (db.prepare("SELECT COUNT(*) AS count FROM projects").get().count <= 1)
        throw new Error("请至少保留一个项目");
      return !!db.prepare("DELETE FROM projects WHERE id=?").run(id).changes;
    },
    project: (id = activeId()) => {
      const row = db.prepare("SELECT * FROM projects WHERE id=?").get(id);
      return row ? { ...JSON.parse(row.data), ...summary(row) } : null;
    },
    saveProject: (data, revision, id = activeId()) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = db
          .prepare("SELECT revision FROM projects WHERE id=?")
          .get(id)?.revision;
        if (revision !== current) {
          db.exec("ROLLBACK");
          return null;
        }
        db.prepare(
          "UPDATE projects SET revision=?, data=?, updated=? WHERE id=?",
        ).run(current + 1, JSON.stringify(data), Date.now(), id);
        db.exec("COMMIT");
        return current + 1;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => db.close(),
  };
}
module.exports = { createStorage };
