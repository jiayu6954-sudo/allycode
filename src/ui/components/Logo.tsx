import React from "react";
import { Box, Text } from "ink";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { useTheme } from "../theme.js";

const currentFile = fileURLToPath(import.meta.url);
let searchDirectory = path.dirname(currentFile);
let version = "unknown";
for (let index = 0; index < 5; index++) {
  const candidate = path.join(searchDirectory, "package.json");
  if (fs.existsSync(candidate)) {
    try {
      version = (JSON.parse(fs.readFileSync(candidate, "utf-8")) as { version: string }).version;
    } catch {
      // Keep the fallback version.
    }
    break;
  }
  searchDirectory = path.dirname(searchDirectory);
}

const MARK = [
  "  ╭──╮ ",
  " ╱ AC ╲",
  "╰──────╯",
];

export function Logo(): React.ReactElement {
  const palette = useTheme();
  return (
    <Box flexDirection="row" alignItems="center">
      <Box flexDirection="column" marginRight={2}>
        {MARK.map((line) => <Text key={line} color={palette.accent}>{line}</Text>)}
      </Box>
      <Box flexDirection="column" justifyContent="center">
        <Text color={palette.primary} bold>AllyCode</Text>
        <Text color={palette.secondary} dimColor>Your code, your context, your ally.</Text>
        <Text color={palette.secondary} dimColor>{`v${version}`}</Text>
      </Box>
    </Box>
  );
}
