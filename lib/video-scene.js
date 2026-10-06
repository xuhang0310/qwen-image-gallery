const path = require("node:path");
const { spawn } = require("node:child_process");
const hasChinese = (text) => /[\u3400-\u9fff]/.test(text);
let queued = Promise.resolve();
function translateScene(text) {
  if (!hasChinese(text)) return Promise.resolve(text);
  // The subtitle-trained translator mistakes this common visual cue for song lyrics.
  if (
    /^(?:美女|女生|女子|女性|成年女子|人物|女孩|男人|男生|男子|男士|男孩)?(?:面对镜头|在镜头前)?(?:撒娇|娇嗔)[。！!?，,\s]*$/.test(
      text.trim(),
    )
  ) {
    const subject = /男人|男生|男子|男士|男孩/.test(text)
      ? "The man"
      : /人物/.test(text)
        ? "The character"
        : "The woman";
    return Promise.resolve(
      `${subject} faces the camera with a coy, affectionate and slightly pleading expression, gently pouting.`,
    );
  }
  const run = () =>
    new Promise((resolve, reject) => {
      const model =
        process.env.VIDEO_TRANSLATOR_MODEL ||
        path.join(__dirname, "../.data/video-translation");
      const child = spawn(
        process.env.VIDEO_TRANSLATOR_PYTHON || "python",
        [path.join(__dirname, "../scripts/translate-video-scene.py"), model],
        {
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, PYTHONUTF8: "1" },
        },
      );
      let output = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("场景转换超时，请稍后重试"));
      }, 60000);
      child.stdout.on("data", (data) => {
        output += data.toString();
        if (output.length > 100000) child.kill();
      });
      child.stderr.resume();
      child.stdin.on("error", () => {});
      child.on("error", () => {
        clearTimeout(timer);
        reject(new Error("本地场景翻译未就绪，请检查 Python 和翻译模型"));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        try {
          const result = JSON.parse(output).text;
          if (
            code !== 0 ||
            typeof result !== "string" ||
            !result.trim() ||
            hasChinese(result)
          )
            throw new Error();
          resolve(result.trim());
        } catch {
          reject(
            new Error(
              "本地场景转换失败，任务未提交；请检查翻译模型或使用英文画面描述",
            ),
          );
        }
      });
      child.stdin.end(JSON.stringify({ text }));
    });
  const task = queued.then(run, run);
  queued = task.catch(() => {});
  return task;
}
module.exports = { translateScene, hasChinese };
