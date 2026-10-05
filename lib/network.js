const http = require("node:http");
function configureNetwork(proxyUrl = "") {
  if (!http.setGlobalProxyFromEnv)
    throw new Error(
      "请使用 Node.js 24.14 或更新版本，双击 start-workbench.bat 可自动准备环境",
    );
  const environment = { ...process.env };
  if (proxyUrl) {
    environment.http_proxy = proxyUrl;
    environment.https_proxy = proxyUrl;
    environment.HTTP_PROXY = proxyUrl;
    environment.HTTPS_PROXY = proxyUrl;
  }
  environment.no_proxy = [
    environment.no_proxy || environment.NO_PROXY || "",
    "localhost",
    "127.0.0.1",
    "::1",
  ]
    .filter(Boolean)
    .join(",");
  environment.NO_PROXY = environment.no_proxy;
  http.setGlobalProxyFromEnv(environment);
}
module.exports = { configureNetwork };
