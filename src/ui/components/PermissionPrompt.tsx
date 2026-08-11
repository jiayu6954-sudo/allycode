import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { PermissionRequest, PermissionDecision } from "../../types/permissions.js";
import { useTheme, symbols, riskColor } from "../theme.js";

interface PermissionPromptProps {
  request:  PermissionRequest;
  onDecide: (decision: PermissionDecision) => void;
}

const RISK_ICON = {
  safe:      symbols.riskSafe,
  moderate:  symbols.riskModerate,
  dangerous: symbols.riskDangerous,
} as const;

export function PermissionPrompt({ request, onDecide }: PermissionPromptProps): React.ReactElement {
  const palette = useTheme();
  const [decided, setDecided] = useState<PermissionDecision | null>(null);

  useInput((input, key) => {
    if (decided) return;
    const ch = input.toLowerCase();
    let decision: PermissionDecision | null = null;
    if (ch === "y") decision = "allow";
    else if (ch === "s") decision = "allow-session";
    else if (ch === "n" || key.escape) decision = "deny";

    if (decision) {
      setDecided(decision);
      onDecide(decision);
    }
  });

  const rc    = riskColor(request.riskLevel, palette);
  const icon  = RISK_ICON[request.riskLevel];
  // dangerous → double border for extra visual weight
  const borderStyle = request.riskLevel === "dangerous" ? "double" : "single";

  return (
    <Box
      flexDirection="column"
      borderStyle={borderStyle}
      borderColor={rc}
      paddingX={2}
      marginX={1}
      marginBottom={0}
    >
      <Box>
        <Text color={rc}>{icon} </Text>
        {request.riskLevel !== "safe" && (
          <Text color={rc} bold>{request.riskLevel}{"  "}</Text>
        )}
        <Text color={palette.primary}>{request.description}</Text>
      </Box>
      <Box>
        {decided ? (
          <Text color={decided === "deny" ? palette.secondary : palette.accent} dimColor={decided === "deny"}>
            {decided === "allow"         ? `${symbols.success} allowed once`
           : decided === "allow-session" ? `${symbols.success} allowed for session`
           :                              `${symbols.denied} denied`}
          </Text>
        ) : (
          <Text color={palette.secondary} dimColor>
            <Text color={palette.accent}>y</Text>{" allow  "}
            <Text color={palette.accent}>s</Text>{" session  "}
            <Text>n</Text>{" deny"}
          </Text>
        )}
      </Box>
    </Box>
  );
}
