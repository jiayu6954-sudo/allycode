/**
 * First-run setup wizard and interactive API key prompt.
 * Called when no API key is found in env or config.
 */
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import { saveSettings } from "./settings.js";

/**
 * Interactively prompt the user to enter their API key.
 * Only called in TTY (interactive terminal) mode.
 * Returns the entered key, or null if user skipped.
 */
export async function promptForApiKey(): Promise<string | null> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });

  process.stderr.write("\n");
  process.stderr.write(chalk.bold.yellow("  ┌─────────────────────────────────────────────┐\n"));
  process.stderr.write(chalk.bold.yellow("  │  AllyCode — 未找到 API Key                      │\n"));
  process.stderr.write(chalk.bold.yellow("  └─────────────────────────────────────────────┘\n"));
  process.stderr.write("\n");
  process.stderr.write(chalk.white("  需要 Anthropic API Key 才能使用 AllyCode。\n"));
  process.stderr.write(chalk.dim("  获取地址：https://console.anthropic.com/\n\n"));

  let key: string;
  try {
    key = await rl.question(chalk.cyan("  请输入你的 API Key（留空跳过）: "));
  } finally {
    rl.close();
  }

  key = key.trim();
  if (!key) {
    process.stderr.write(chalk.yellow("\n  已跳过。请设置环境变量后重试：\n"));
    process.stderr.write(chalk.dim("    export ANTHROPIC_API_KEY=sk-ant-...\n"));
    process.stderr.write(chalk.dim("  或运行: allycode setup\n\n"));
    return null;
  }

  // Offer to persist
  const rl2 = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
  let saveAnswer: string;
  try {
    saveAnswer = await rl2.question(chalk.dim("  保存到 ~/.allycode/settings.json？[Y/n] "));
  } finally {
    rl2.close();
  }

  if (saveAnswer.trim().toLowerCase() !== "n") {
    await saveSettings({ apiKey: key });
    process.stderr.write(chalk.green("  ✓ API Key 已保存。下次启动无需再次输入。\n\n"));
  } else {
    process.stderr.write("\n");
  }

  return key;
}

/**
 * Full interactive setup wizard (devai setup command).
 * Guides the user through API key + model selection.
 */
export async function runSetupWizard(): Promise<void> {
  const sep = "─".repeat(46);

  process.stdout.write("\n");
  process.stdout.write(chalk.bold("  AllyCode 配置向导\n"));
  process.stdout.write(chalk.dim(`  ${sep}\n\n`));

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  try {
    // Step 1: API Key
    process.stdout.write(chalk.white("  [1/2] Anthropic API Key\n"));
    process.stdout.write(chalk.dim("        获取地址：https://console.anthropic.com/\n"));
    const key = await rl.question(chalk.cyan("        请输入: "));

    // Step 2: Model
    process.stdout.write(chalk.white("\n  [2/2] 默认模型\n"));
    process.stdout.write(chalk.dim("        1) claude-sonnet-4-6  （推荐，速度快，性价比高）\n"));
    process.stdout.write(chalk.dim("        2) claude-opus-4-6    （最强能力，成本较高）\n"));
    const modelChoice = await rl.question(chalk.cyan("        请选择 [1/2，默认 1]: "));

    const model = modelChoice.trim() === "2" ? "claude-opus-4-6" : "claude-sonnet-4-6";

    if (key.trim()) {
      await saveSettings({ apiKey: key.trim(), model });
      process.stdout.write(chalk.green(`\n  ✓ 配置已保存至 ~/.allycode/settings.json\n`));
      process.stdout.write(chalk.dim(`    模型：${model}\n`));
      process.stdout.write(chalk.dim(`    API Key：${key.slice(0, 12)}...\n\n`));
      process.stdout.write(chalk.white("  现在运行 ") + chalk.cyan("allycode") + chalk.white(" 开始使用。\n\n"));
    } else {
      process.stdout.write(chalk.yellow("\n  ! API Key 为空，配置未保存。\n"));
      process.stdout.write(chalk.dim("  运行 allycode setup 重新配置，或设置环境变量：\n"));
      process.stdout.write(chalk.dim("    export ANTHROPIC_API_KEY=sk-ant-...\n\n"));
    }
  } finally {
    rl.close();
  }
}
