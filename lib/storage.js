const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function createStorage(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(path.join(directory, "workbench.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, created INTEGER NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS project (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, data TEXT NOT NULL);",
  );
  const get = db.prepare("SELECT data FROM jobs WHERE id=?");
  const put = db.prepare(
    "INSERT INTO jobs VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
  );
  const list = db.prepare("SELECT data FROM jobs ORDER BY created DESC");
  return {
    get: (id) => {
      const row = get.get(id);
      return row ? JSON.parse(row.data) : null;
    },
    put: (id, job) =>
      put.run(id, job.createdAt || Date.now(), JSON.stringify(job)),
    list: () => list.all().map((row) => JSON.parse(row.data)),
    project: () => {
      const row = db.prepare("SELECT * FROM project WHERE id=1").get();
      return row
        ? { revision: row.revision, ...JSON.parse(row.data) }
        : {
            revision: 0,
            jobs: [],
            board: { nodes: [], edges: [], pan: { x: 0, y: 0 }, zoom: 1 },
            hiddenJobIds: [],
          };
    },
    saveProject: (data, revision) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const current =
          db.prepare("SELECT revision FROM project WHERE id=1").get()
            ?.revision || 0;
        if (revision !== current) {
          db.exec("ROLLBACK");
          return null;
        }
        db.prepare(
          "INSERT INTO project VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, data=excluded.data",
        ).run(current + 1, JSON.stringify(data));
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
