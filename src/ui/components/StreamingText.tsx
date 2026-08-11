import React from "react";
import { Text } from "ink";
import { useTheme, symbols } from "../theme.js";

interface StreamingTextProps {
  text:        string;
  isStreaming: boolean;
  color?:      string;
}

/**
 * AI response body text.
 *
 * Color hierarchy:
 *   palette.primary (#E8E4DC warm cream) — softer than terminal pure-white,
 *   no bold, no dimColor → reads comfortably at normal weight.
 */
export function StreamingText({ text, isStreaming, color }: StreamingTextProps): React.ReactElement {
  const palette = useTheme();
  return (
    <>
      <Text color={color ?? palette.primary}>{text}</Text>
      {isStreaming && <Text color={palette.secondary}>{symbols.cursor}</Text>}
    </>
  );
}
