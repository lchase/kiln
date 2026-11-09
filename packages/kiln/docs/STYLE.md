# Kiln board style

Rules for `kiln serve`. Tokens live in `assets/serve.css` between `tokens:start` and `tokens:end`. Screens use those variables. Raw px spacing and color literals outside that block fail `test/style.test.ts` (`npm test -w @lchase/kiln`).

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

Radii: `--radius-sm` 4px (fields, buttons), `--radius-md` 8px (small controls), `--radius-lg` 12px (cards, columns), `--radius-pill` chips, `--radius-full` circles.

Type, on `--font-sans` (UI) or `--font-mono` (ids, meta, code):

| Token | Size / line |
| --- | --- |
| `--text-xs` / `--leading-xs` | 12 / 16 |
| `--text-sm` / `--leading-sm` | 14 / 20 body |
| `--text-md` / `--leading-md` | 16 / 24 titles |
| `--text-lg` / `--leading-lg` | 20 / 28 page and drawer titles |
| `--text-xl` / `--leading-xl` | 28 / 36 stats |

Dark theme:

| Token | Role |
| --- | --- |
| `--bg` `--panel` `--card` `--card-hover` | Page, drawer, card, hover |
| `--line` `--line-strong` | Hairline and control borders |
| `--ink` `--muted` `--faint` | Text, secondary, tertiary |
| `--primary` `--on-primary` | Primary action and its label |
| `--focus` | Focus ring |
| `--code` `--code-bg` | Links and code |

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
- Card anatomy: `--card` or `--panel` fill, `--hairline` border, `--radius-lg`, padding `--space-4`.
- The pipeline tray may scroll sideways. Chip rows and form controls may not.

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

- Spacing, type, radius, and color come from tokens. The style guard passes.
- The screen uses the page gutter and stays within `--content-max`.
- Drawer content is padded on all sides. The footer is sticky. The primary action is on the right, Cancel on its left.
- Labels sit above fields. Fields are full width. Hints and errors are inline. The primary action stays disabled until the form is valid.
- Pickers are chips only up to 5 and never overflow horizontally.
- Empty, error, and (if the screen loads) waiting states exist.
- Times are local plus relative.
- Focus rings and keyboard work without a pointer.
