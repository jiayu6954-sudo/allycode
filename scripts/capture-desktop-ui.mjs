import fs from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow } from "electron";

const url = process.argv[2] ?? "http://127.0.0.1:5173/";
const outputDirectory = path.resolve("output", "ui-alpha11");

await fs.mkdir(outputDirectory, { recursive: true });
await fs.writeFile(path.join(outputDirectory, "started.txt"), new Date().toISOString(), "utf8");
await app.whenReady();
const window = new BrowserWindow({
  width: 1480,
  height: 940,
  show: false,
  backgroundColor: "#ffffff",
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  },
});

try {
  await window.loadURL(url);
  await wait(700);
  const overview = await inspect(window, "Agent 引擎");
  await capture(window, "01-overview.png");

  await clickButton(window, "Agent 引擎");
  await wait(300);
  const engines = await inspect(window, "DeepSeek Harness");
  await capture(window, "02-agent-engines.png");
  await clickClose(window);

  await clickButton(window, "评测实验室");
  await wait(300);
  const benchmark = await inspect(window, "OmniTrade 工业级全栈挑战");
  await capture(window, "03-benchmark-lab.png");

  const report = { url, generatedAt: new Date().toISOString(), overview, engines, benchmark };
  await fs.writeFile(
    path.join(outputDirectory, "inspection.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );
  console.log(JSON.stringify(report));
} catch (error) {
  await fs.writeFile(
    path.join(outputDirectory, "error.txt"),
    error instanceof Error ? `${error.stack ?? error.message}` : String(error),
    "utf8",
  );
  process.exitCode = 1;
} finally {
  window.destroy();
  app.quit();
}

async function inspect(browserWindow, requiredText) {
  return browserWindow.webContents.executeJavaScript(`(() => {
    const body = document.body;
    const style = getComputedStyle(body);
    const visibleComposer = [...document.querySelectorAll('textarea')].some((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom <= innerHeight;
    });
    return {
      requiredText: ${JSON.stringify(requiredText)},
      hasRequiredText: body.innerText.includes(${JSON.stringify(requiredText)}),
      bodyColor: style.color,
      bodyBackground: style.backgroundColor,
      viewport: { width: innerWidth, height: innerHeight },
      document: { width: body.scrollWidth, height: body.scrollHeight },
      horizontalOverflow: body.scrollWidth > innerWidth,
      visibleComposer,
      buttonCount: document.querySelectorAll('button').length,
      dialogCount: document.querySelectorAll('.modal-backdrop,.monitor-backdrop').length,
    };
  })()`);
}

async function clickButton(browserWindow, label) {
  const clicked = await browserWindow.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.innerText.includes(${JSON.stringify(label)}));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`找不到按钮：${label}`);
}

async function clickClose(browserWindow) {
  const clicked = await browserWindow.webContents.executeJavaScript(`(() => {
    const dialogs = [...document.querySelectorAll('.modal-backdrop,.monitor-backdrop')];
    const dialog = dialogs.at(-1);
    const button = dialog?.querySelector('button[aria-label="关闭"]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error("找不到弹窗关闭按钮");
  await wait(150);
}

async function capture(browserWindow, filename) {
  const image = await browserWindow.webContents.capturePage();
  await fs.writeFile(path.join(outputDirectory, filename), image.toPNG());
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
