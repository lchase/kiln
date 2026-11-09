# Kiln board style

Rules for `kiln serve`. Shared tokens (type, spacing, radius) live in `assets/serve.css` between `tokens:start` and `tokens:end`. Color values live in `theme:<id>` blocks. Screens use the variables. Raw px spacing and color literals outside those blocks fail `test/style.test.ts` (`npm test -w @lchase/kiln`).

## Tokens

Spacing is a 4px grid:

| Token | Value | Use |
| --- | --- | --- |
| `--space-2xs` | 2px | Inline rhythm, stacked meta |
| `--space-1` | 4px | Tight gap |
| `--space-2` | 8px | Default gap, label to control |
| `--space-3` | 12px | Related groups, list rows |
| `--space-4` | 16px | Card padding, field stack |
| `--space-5` | 24px | Page gutter, drawer padding, sections |
| `--space-6` | 32px | Large separation |
| `--space-7` | 48px | Rare, tall breaks |
| `--space-8` | 64px | Page end |
| `--hairline` | 1px | Borders |

Radii stay tight. `--radius-sm` is 2px (buttons and small controls). `--radius-md` is 4px (inputs). `--radius-lg` is 6px (cards and columns). `--radius-pill` is chips only. `--radius-full` is circles.

Type, on `--font-sans` (UI) or `--font-mono` (ids, meta, code):

| Token | Size / line |
| --- | --- |
| `--text-xs` / `--leading-xs` | 12 / 16 |
| `--text-sm` / `--leading-sm` | 14 / 20 body |
| `--text-md` / `--leading-md` | 16 / 24 titles |
| `--text-lg` / `--leading-lg` | 20 / 28 page and drawer titles |
| `--text-xl` / `--leading-xl` | 28 / 36 stats |

Color tokens name roles. A theme replaces their values. It does not rename them, and it does not change spacing or radius.

| Token | Role |
| --- | --- |
| `--bg` | Page |
| `--panel` | Nav, drawer, column |
| `--card` | Card |
| `--card-hover` | Hover |
| `--line` | Hairline |
| `--line-strong` | Control border |
| `--faint` | Tertiary text |
| `--muted` | Secondary text |
| `--ink` | Primary text |
| `--primary` `--on-primary` | The one action accent (Approve, Add) and its label |
| `--focus` `--code` | Focus ring and links |
| `--code-bg` | Chip and code surface |
| `--scrim` | Drawer overlay |

The Kiln theme is a warmed neutral (Tailwind Stone surfaces, Kiln's own accent and state colors). It is the default. Other themes use that palette's own accent for `--primary`.

State colors (say the word as well as the color):

| Token | State |
| --- | --- |
| `--state-queued` | Queued, blocked |
| `--state-running` | Running |
| `--state-needs-you` | Needs you |
| `--state-needs-hand` | Needs a hand |
| `--state-done` | Done |
| `--state-failed` | Failed |
| `--state-cancelled` | Cancelled |

## Layout

- Page gutter is `--gutter` (`--space-5`). Bottom padding is `--space-8`.
- Content stops at `--content-max`. Do not stretch a form or a list across an ultrawide window.
- Drawer padding is `--drawer-pad` on the head, the body, and the footer. Labels and inputs do not touch the drawer edge.
- Card anatomy: `--card` fill, `--hairline` border, `--radius-lg`, padding `--space-4`. One surface. Actions sit in a footer row on that same surface.
- State is a labeled chip. It is not a bar, a stripe, or a fill on the card.
- A card that needs a person says `Needs a decision` in `--muted`. Sentence case.
- The pipeline tray may scroll sideways. Chip rows and form controls may not.

## Don't

- No left or top accent bar on a card, and no thicker colored border in its place.
- No glow, and no gradient or tinted wash on a card.
- No all-caps marketing eyebrows.
- Do not paint chrome with `--primary`. It is for the action button only.
- Do not add a second accent color for decoration.

## Forms

- Label above the control (`.k` or a `<label>`).
- Control width is 100% of its field. The field is 100% of the form.
- Stack fields with `--space-4`. Stack label, control, hint, and error with `--space-2`.
- Hint is `.hint` (how to fill it). Error is `.field-error` (what is wrong), tied to the control with `aria-describedby` and `aria-invalid`.
- One footer (`.form-footer`): primary action on the right, Cancel or other secondary actions to its left.
- In a drawer the body scrolls and the footer stays pinned to the bottom (`position: sticky`).
- Disable the primary action until required fields are valid. Show the inline error for the missing field.

## Pickers

- Segmented chips only up to 5 options. They wrap inside the container.
- More than 5: a searchable combobox (type to filter, arrows, Enter, Escape). The list stays in the field so it cannot overflow the drawer.
- Never a single non-wrapping row of chips.
- Repo uses this cutoff (`data-pick-limit`). Workflow uses the same cutoff (chips at four built-in names, a select past five). Source has four choices and stays chips.
- That cutoff is for form fields (repo, workflow, source). A theme is a visual choice, not a field picker. It uses the swatch grid below, even though there are more than five.

## Themes

- The id is stored at `board.theme` in `kiln.config.json`. The settings API reads and writes it. A missing or unknown id resolves to `kiln`. A new config file starts as `kiln`.
- The page sets `data-theme` on `<html>`. Each theme block is `[data-theme="<id>"]` and sets the same color custom properties. Kiln also applies through `:where(:root)`, so a page with no attribute is Kiln.
- Choosing a swatch in Settings → Appearance applies that theme immediately and saves it. The swatch is a preview of that theme's page, sidebar, card, and accent. It is not a combobox and not a chip row.
- Light themes set `color-scheme: light`. Dark themes set `color-scheme: dark`. State stays a labeled chip. `--primary` stays the action button only.
- To add a theme: add its id to `BOARD_THEME_IDS` and `BOARD_THEME_CHOICES` in `src/theme.ts`, then add a `/* theme:<id> */` block in `serve.css` with the same color properties as Kiln. Spacing and radius stay in the shared token block. The style test fails if a theme omits a color token or if a color literal lands outside the token and theme blocks.

## Palette attribution

Kiln adapts published palettes onto the tokens above. It does not vendor theme source.

- **Kiln.** Tailwind Stone surfaces (the published stone hex ramp). Accent `#6d4aff` and the state colors are Kiln's. Tailwind is MIT, copyright Tailwind Labs.
- **Nord.** Official Nord polar night, snow storm, frost, and aurora. MIT, copyright Sven Greb. https://www.nordtheme.com/docs/colors-and-palettes
- **Gruvbox Dark and Gruvbox Light.** Official Gruvbox (`morhetz/gruvbox`): dark uses the bright accents, light uses the faded accents. MIT/X11.
- **Catppuccin** Mocha, Macchiato, Frappé, and Latte. Official palette 1.8.0. Mauve is the accent. MIT, copyright Catppuccin. https://catppuccin.com/palette
- **Monospace Dark and Monospace Light.** Published UI colors from Keksi's Monospace theme (`keksiqc/monospace-theme`, MIT, copyright 2024 Keksi), as carried in the Orca port `faisalmuhammad/orca-monospace-themes`. The upstream theme is a modification of the Google IDX theme. This board uses the palette only.

## Tables and lists

- Tables are full width. Row divider is a hairline. Row padding is `--space-2`.
- Numbers are end-aligned and mono.
- Long lists scroll inside the list, not the page, when a max height is set (`--fs-max`, `--after-max`).

## Empty states

- One sentence in `.empty`. Name what is absent ("Nothing queued."). Do not use an error color for an empty list.

## Times

- Use `<time datetime>`. Show a local clock and a relative companion (`data-time="local"` and `data-time="rel"`).
- Relative time is muted. Do not show a raw ISO string as the only label.

## Accessibility

- `:focus-visible` uses `--focus-width` and `--focus`. Do not remove the outline.
- Text contrast is `--ink` on `--bg` / `--card`. State chips include the state word.
- Every control is a button, link, input, or combobox. Keyboard reaches it. The combobox supports Arrow, Enter, and Escape (Escape closes the list before the drawer).
- Hit targets for icon buttons use `--hit` (44px).

## Checklist for any new screen

- Spacing, type, radius, and color come from tokens. Colors come from the active theme. The style guard passes.
- The screen follows the Don't list: no card bars, glow, washes, or all-caps eyebrows.
- The screen uses the page gutter and stays within `--content-max`.
- Drawer content is padded on all sides. The footer is sticky. The primary action is on the right, Cancel on its left.
- Labels sit above fields. Fields are full width. Hints and errors are inline. The primary action stays disabled until the form is valid.
- Pickers are chips only up to 5 and never overflow horizontally.
- Empty, error, and (if the screen loads) waiting states exist.
- Times are local plus relative.
- Focus rings and keyboard work without a pointer.
