import React from "react";
import { Box, Text } from "ink";
import type { UIMessage, UIContentBlock } from "../../types/agent.js";
import { ToolCall } from "./ToolCall.js";
import { StreamingText } from "./StreamingText.js";
import { useTheme, symbols } from "../theme.js";

interface MessageListProps {
  messages:     UIMessage[];
  hiddenAbove:  number;
  showThinking: boolean;
}

/**
 * Three-tier color hierarchy:
 *
 *   Layer 1 — Content  (palette.primary, no dim):
 *     User input text, AI response body.
 *     Warm #E8E4DC — readable, not harsh pure-white.
 *
 *   Layer 2 — Chrome   (palette.secondary, no dim):
 *     Role labels, timestamps, tool names.
 *     Medium gray — clearly visible but recedes behind content.
 *
 *   Layer 3 — Structure (palette.secondary + dimColor):
 *     Scroll hint, dividers, thinking blocks.
 *     Very quiet — pure infrastructure.
 */

export const MessageList = React.memo(function MessageList({ messages, hiddenAbove, showThinking }: MessageListProps): React.ReactElement {
  const palette = useTheme();
  return (
    <Box flexDirection="column" flexGrow={1} paddingX={2}>
      {/* Layer 3 — scroll hint */}
      {hiddenAbove > 0
        ? <Text color={palette.secondary} dimColor>{"↑ "}{hiddenAbove}{" more  (PgUp)"}</Text>
        : <Text>{" "}</Text>
      }
      {messages.map((msg) => (
        <MessageItem key={msg.id} message={msg} showThinking={showThinking} />
      ))}
    </Box>
  );
});

function fmt(d: Date): string {
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function ContentBlock({ block, isStreaming, showThinking }: {
  block: UIContentBlock;
  isStreaming: boolean;
  showThinking: boolean;
}): React.ReactElement | null {
  const palette = useTheme();
  switch (block.type) {
    case "text":
      return <StreamingText text={block.text} isStreaming={isStreaming} />;
    case "thinking":
      if (!showThinking) return null;
      return <Text color={palette.secondary} dimColor italic>{block.text}</Text>;
    case "tool_use":
      return <ToolCall toolName={block.toolName} input={block.input} status={block.status} result={block.result} />;
    case "tool_result":
      return null;
    case "error":
      return <Text color={palette.error}>{symbols.error}{" "}{block.message}</Text>;
    default:
      return null;
  }
}

const MessageItem = React.memo(function MessageItem(
  { message, showThinking }: { message: UIMessage; showThinking: boolean }
): React.ReactElement {
  const palette = useTheme();

  if (message.role === "user") {
    return (
      <Box marginBottom={0}>
        <Text color={palette.secondary}>{symbols.prompt}{" "}</Text>
        <Text color={palette.primary}>
          {message.content
            .filter((b) => b.type === "text")
            .map((b) => (b as { type: "text"; text: string }).text)
            .join("")}
        </Text>
      </Box>
    );
  }

  if (message.role === "system") {
    return (
      <Box flexDirection="column">
        {message.content.map((block, i) => {
          if (block.type === "error") {
            return <Text key={i} color={palette.error}>{symbols.error}{"  "}{block.message}</Text>;
          }
          if (block.type === "text" && block.text) {
            return (
              <Box key={i} paddingLeft={1}>
                <Text color={palette.secondary} dimColor>{"▎ "}</Text>
                <Text color={palette.secondary}>{block.text}</Text>
              </Box>
            );
          }
          return null;
        })}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={palette.brand}>{symbols.sparkle}</Text>
        <Text color={palette.secondary}>{" AllyCode "}{fmt(message.timestamp)}</Text>
      </Text>
      <Box flexDirection="column" marginLeft={2} marginBottom={1}>
        {message.content.map((block, i) => (
          <ContentBlock
            key={i}
            block={block}
            isStreaming={message.isStreaming ?? false}
            showThinking={showThinking}
          />
        ))}
      </Box>
    </Box>
  );
});
