/**
 * Board color themes. Each id matches a `theme:<id>` block in `assets/serve.css`.
 * Missing or unknown values resolve to `kiln`.
 */
export const BOARD_THEME_IDS = [
  "kiln",
  "nord",
  "gruvbox-dark",
  "gruvbox-light",
  "catppuccin-mocha",
  "catppuccin-macchiato",
  "catppuccin-frappe",
  "catppuccin-latte",
  "monospace-dark",
  "monospace-light",
] as const;

export type BoardThemeId = (typeof BOARD_THEME_IDS)[number];

export const DEFAULT_BOARD_THEME: BoardThemeId = "kiln";

export const BOARD_THEME_CHOICES: readonly { id: BoardThemeId; label: string }[] = [
  { id: "kiln", label: "Kiln" },
  { id: "nord", label: "Nord" },
  { id: "gruvbox-dark", label: "Gruvbox Dark" },
  { id: "gruvbox-light", label: "Gruvbox Light" },
  { id: "catppuccin-mocha", label: "Catppuccin Mocha" },
  { id: "catppuccin-macchiato", label: "Catppuccin Macchiato" },
  { id: "catppuccin-frappe", label: "Catppuccin Frappé" },
  { id: "catppuccin-latte", label: "Catppuccin Latte" },
  { id: "monospace-dark", label: "Monospace Dark" },
  { id: "monospace-light", label: "Monospace Light" },
];

export function resolveBoardTheme(value: unknown): BoardThemeId {
  if (typeof value === "string" && (BOARD_THEME_IDS as readonly string[]).includes(value)) {
    return value as BoardThemeId;
  }
  return DEFAULT_BOARD_THEME;
}
