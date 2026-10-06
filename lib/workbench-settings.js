const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

function createWorkbenchSettings({ app, dataDir }) {
  const file = path.join(dataDir, "workbench-settings.json");
  const defaultDirectory = path.join(dataDir, "generated-images");
  let settings = { imageOutputDir: defaultDirectory };
  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const saving = new Map();
  const publicSettings = () => ({
    ...settings,
    defaultDirectory,
    folderPicker: process.platform === "win32",
  });
  async function save(values) {
    const directory = values.imageOutputDir;
    if (
      typeof directory !== "string" ||
      !directory.trim() ||
      directory.length > 1000 ||
      /[\r\n\0]/.test(directory) ||
      !path.isAbsolute(directory.trim())
    )
      throw new Error("请输入图片保存文件夹的完整路径");
    const resolved = path.resolve(directory.trim());
    await fs.promises.mkdir(resolved, { recursive: true });
    const probe = path.join(
      resolved,
      ".qwen-write-check-" + crypto.randomUUID(),
    );
    await fs.promises.writeFile(probe, "", { flag: "wx" });
    await fs.promises.unlink(probe);
    const next = { imageOutputDir: resolved };
    await fs.promises.writeFile(file + ".tmp", JSON.stringify(next, null, 2));
    await fs.promises.rename(file + ".tmp", file);
    settings = next;
    return publicSettings();
  }
  async function archive(job, images, readImage) {
    if (!job.imageOutputDir || job.savedImages?.length || job.imageSaveError)
      return {};
    if (saving.has(job.id)) return saving.get(job.id);
    const work = (async () => {
      const savedImages = [];
      try {
        await fs.promises.mkdir(job.imageOutputDir, { recursive: true });
        for (let index = 0; index < images.length; index++) {
          const image = images[index];
          const buffer = await readImage(image);
          const extension =
            /\.(png|jpe?g|webp)$/i
              .exec(image.filename || "")?.[1]
              ?.toLowerCase() || "png";
          const filename = `${String(job.id).replace(/[^a-zA-Z0-9_-]/g, "_")}-${index + 1}.${extension}`;
          const target = path.join(job.imageOutputDir, filename);
          await fs.promises
            .writeFile(target, buffer, { flag: "wx" })
            .catch(async (error) => {
              if (error.code !== "EEXIST") throw error;
              const existing = await fs.promises.readFile(target);
              if (!existing.equals(buffer))
                throw new Error("保存位置已有同名文件，未覆盖");
            });
          savedImages.push({ filename, path: target });
        }
        return { savedImages };
      } catch (error) {
        return {
          savedImages,
          imageSaveError:
            "图片已生成，但保存到指定文件夹失败：" + error.message,
        };
      }
    })();
    saving.set(job.id, work);
    try {
      return await work;
    } finally {
      saving.delete(job.id);
    }
  }
  app.get("/api/settings", (_req, res) => res.json(publicSettings()));
  app.put("/api/settings", async (req, res) => {
    try {
      res.json(await save(req.body));
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
  app.post("/api/settings/choose-directory", async (_req, res) => {
    if (process.platform !== "win32")
      return res.status(400).json({ error: "请直接输入保存路径" });
    try {
      const script =
        "Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = '选择生成图片的保存文件夹'; if ($dialog.ShowDialog() -eq 'OK') { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::Write($dialog.SelectedPath) }; $dialog.Dispose()";
      const { stdout } = await promisify(execFile)(
        "powershell.exe",
        ["-NoProfile", "-STA", "-Command", script],
        { windowsHide: true, timeout: 180000, maxBuffer: 8192 },
      );
      res.json({ directory: stdout.trim() || null });
    } catch (error) {
      res
        .status(400)
        .json({ error: "选择文件夹失败，请直接输入路径：" + error.message });
    }
  });
  return {
    publicSettings,
    capture: () => settings.imageOutputDir,
    archive,
    save,
  };
}
module.exports = { createWorkbenchSettings };
