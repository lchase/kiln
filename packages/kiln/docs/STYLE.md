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

Radii stay tight. `--radius-sm` is 2px (buttons and small controls). `--radius-md` is 4px (inputs, tags, chips, filter chips, and count badges). `--radius-lg` is 6px (cards and columns). `--radius-full` is circles. There is no pill radius.

Icon size is `--icon` (16px, on the 4px grid). Stroke is `--icon-stroke` (2, Lucide's unitless stroke in a 24 viewBox). Both live in the shared token block.

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

## Chips

- A tag (workflow name), a status, a filter chip (Repo, Workflow, All), and a count badge are rectangles. Radius is `--radius-md`. Horizontal padding is `--space-2`.
- Filter chips keep the control height (`--control-h`). Tags and badges use `--badge`.
- Do not use a pill radius. Do not round one chip and leave the next square.

## Steps

- A job shows the workflow's step list. The card does not show the current step as plain text.
- Done steps are `--muted` with a check. The current step is `--primary` and weight 500. Upcoming steps are `--faint`. A failed step uses `--state-failed`.
- Names are separated by `›`.
- Each step is named once. The approver agent step (`approver`) is "Approver". The human gate (`approve`) is
  "Your decision".
- A loop (or map) container is not a step. Its body steps appear in the list and the container does not. In
  `feature`, the `revise` loop is not shown; Build, Verify, and the reviews are.
- A pipeline card is narrow. It uses a segmented bar (one segment per step) plus the current step name. Done segments are `--muted`. The current segment is `--primary`. Upcoming segments are `--line`.
- Inbox, repo, and history rows use the same stepper. Wide rows show the names. The job page uses its own progress
  row (see Job page), not this stepper.

## Job page

`/jobs/<id>` is one page that reads top to bottom. There are no tabs.

1. Header: back link, title, state chip, then one meta line (repo, workflow, started, `attempt N of M`, cost, short
   job id, branch and pull request when present). Stop job, Remove job, Run next, Hold, and Release sit here.
2. Progress (`aria-label="Progress"`): one segment per step. The four reviews (security, UX, UI, code) are one
   segment named Reviews. A done segment has a check and its duration. Upcoming segments print no status word.
3. One middle card, picked by state: "Now" while the job runs (the step, last activity, the newest note, the
   running command), "Your decision" while it waits on you (the approver's and each review's verdict, then Approve,
   Reject, and Revise with a note), or "What went wrong" when it failed or needs a hand (the failure and Retry). A
   done job has none.
4. One section per started step, newest first. The running step is open and shows its activity. A finished step is
   one line (round, duration, command count, a link to what it produced) and a native "Show activity" disclosure.
   A step's name and state appear once outside the progress row. A started step's name, here and in the progress
   row, links to its step view.
5. The diff and the event history are disclosures at the end of the main column (`#changes`, `#timeline`).
6. Side column (`aria-label="Job facts"`): changes so far (file, `+added -removed`, "Open the diff"), what happens
   next, links to the spec, the raw log, and the event history, and a short list of other facts. Under the narrow
   breakpoint it moves below the main column. Long commands and paths wrap; nothing scrolls sideways.

Old `?tab=live|changes|timeline` links land on `#live`, `#changes`, or `#timeline`. Changes and timeline open their
disclosure.

The running step's activity log:

- Scrolls inside its own box, `max-height: var(--log-max-height)`, `overflow-y: auto`. It never scrolls the page.
- Is an `<ol>` with `tabindex="0"` and an accessible name ("Build activity, scrolls").
- Follows the newest line while the operator has not scrolled it. The status line says "Following the latest line".
- Scrolling up stops following ("Paused. Jump to latest to follow."). Only "Jump to latest" turns it back on.
- "Expand" (`aria-pressed`) removes the max height so the log opens at full height.
- No smooth scrolling, so `prefers-reduced-motion: reduce` stays still.

### Step view

`/jobs/<id>/steps/<step>` is the job page with one step selected.

- The job header stays: back link, the title as a link back to `/jobs/<id>`, the state chip, and the meta line.
  The job actions stay on the job page.
- Below it, two columns. The step list (`.step-nav`, `aria-label="Steps"`) is on the left. The selected step
  (`.step-view`) fills the right.
- The step list has every step of the workflow's plan, in order, with the progress row's marks: a check when done,
  a dot while running, an empty ring otherwise. A done step shows its duration; a failed or skipped step says so in
  words. The four reviews sit under a "Reviews" label, which is not a link. `revise` and `fix-N` are not listed.
- A started step (the same rule as the job page's sections) is an `<a href>`. A step that has not started is
  plain text with no `href`, so it cannot be opened. The selected step has `aria-current="page"`.
- Under the list: "Changes so far, N files" and "Event history", both links into the job page.
- The step: its name, then one line (round, then running, done in, failed after, or skipped), and "agent, model" on
  the right. Two small cards count the commands it ran and the files it edited.
- Activity, Result, and Raw log are links, not ARIA tabs. The active view has `aria-current="page"`. There is no
  Prompt view.
- Activity is the job page's activity log markup and rules (see above), filtered to this step. `data-pin` keeps it
  on this step: it does not reload when the run moves to the next step.
- Result shows what the step produced. Verdicts, decisions, and exit codes are words, never color alone. A step with
  nothing to show says "This step has no result to show."
- Under the narrow breakpoint the grid is one column and the step list comes first, above the step.

## Liveness

- `lastActivityAt` is the timestamp stall detection already uses: the later of the run's journal activity, the launch log mtime, and the mtime of the newest file under the run's `sessions/` directory.
- A running job with activity inside 2 minutes (`QUIET_AFTER_MS`) shows a slow pulsing dot in `--state-running`. The word `Working` is in the page for a screen reader and is not a second label.
- No activity for longer than 2 minutes, while still inside `stallTimeoutMs`, shows a static dot and `quiet Nm` (whole minutes).
- Past `stallTimeoutMs`, the label is `stalled` and the dot does not pulse. The driver still kills and retries that run. `stallTimeoutMs` of 0 or below does not mark a job stalled.
- Queued, needs you, needs a hand, and done do not pulse and do not show quiet or stalled.
- `prefers-reduced-motion: reduce` leaves the dot static.
- No glow, no shimmer bar, and no left accent bar. The dot is the only motion.

## Links

- Links do not underline, including on hover.
- A link is `--code`. Hover moves it to `--ink`. Focus uses the shared `:focus-visible` ring.
- A title link is `--ink` and moves to `--code` on hover.
- Spec, log, and findings are `.text-btn`: one Lucide icon and a label, height `--control-h`, radius `--radius-md`. They are not underlined prose.

## Sidebar

- Brand (logo, Kiln, version) stays at the top.
- The nav fills the middle (`.nav-scroll`) and scrolls when it is taller than the viewport. Add job stays with the nav.
- The footer (`.side-foot`) stays pinned to the bottom of the sidebar. It holds the run status, today's spend, and notify. It is not a second action row.
- Run status is the live dot, Running or Paused, and Pause or Resume. Pause posts `/api/pause`. Resume posts `/api/resume`. In-flight runs finish. No new runs start while paused. The button keeps the word and swaps the pause and play icons (`aria-pressed` shows play).
- Spend uses `formatSpend` (`today <day>  $0.00 / $cap` or `no cap`). A cap hit adds the note `cap hit`.

## Icons

Official Lucide, inlined (`src/icons.ts`). Do not add a React icon package. Do not vendor a doubled-stroke set: at 16px those paths read as mud.

- One icon on each nav row: Pipeline `columns-3`, Inbox `inbox`, Needs a hand `hand-helping`, Repos `folder-git-2`, History `history`, Stats `chart-column`, Today `calendar`, Triggers `zap`, Settings `settings`.
- Repo sublinks (`api`, `web`) stay text.
- Footer: `pause` / `play`, and `bell` / `bell-off` for notify.
- Add job stays a labeled button. Do not icon-spam cards, chips, or meta rows. The exceptions are the step check and the spec, log, and findings buttons.
- Draw with `.icon`: `var(--icon)`, `var(--icon-stroke)`, `currentColor`, `fill: none`. No fill except a Lucide mark that is meant to be filled. These marks are not.
- Active nav: `--ink` icon and label, on the existing selected background (`--card-hover`). Inactive: `--muted`. Hover may use `--ink`. Do not paint nav icons, the footer, or other chrome with `--primary`.
- Icon-only hit targets use `--hit` (44px). A nav row can stay compact when the whole row is the target. Pause and notify include a label, so they stay on `--control-h`.

## Notify

The footer control says what it will do. State is the visible label, not a tooltip.

| State | Label | Click |
| --- | --- | --- |
| Not asked (`Notification.permission` is `default`) | Notify me | Asks the browser |
| On (granted, and Kiln sending is on) | Notifications on | Turns Kiln's sending off. The browser permission stays. |
| Off (granted, sending off) | Notify me | Turns sending back on. No second prompt. |
| Blocked (`denied`) | Notifications blocked | Does not ask again. A sentence under the control says to allow notifications for this site in the browser. |
| API missing | Notifications unavailable | The control is disabled. It is not a working button. |

On uses `bell`. The other states use `bell-off`. The local preference is `kiln-notify` in `localStorage` (`on` or `off`). Missing means on once the browser has granted permission.

Kiln notifies only when the needs-you count grows, and only while sending is on. The notification title is `Kiln`. The body is `1 job needs you` or `N jobs need you`. No other channel. No secrets in the body.

## Don't

- No left or top accent bar on a card, and no thicker colored border in its place.
- No glow, and no gradient or tinted wash on a card.
- No pill shapes on tags, status, filter chips, or count badges.
- No all-caps marketing eyebrows.
- Do not paint chrome, nav icons, or the sidebar footer with `--primary`. It is for the action button (Approve, Add job) and the current step.
- Do not add a second accent color for decoration.

## Pending actions

- Approve, Reject, Revise, and Retry post a form, and the answer takes a moment. On click the button keeps its
  place, shows a small spinning ring before its label, and the label changes to the action in progress
  (`Approving…`, `Rejecting…`, `Sending back…`, `Retrying…`). It carries `aria-busy="true"`.
- Every other button in that row is disabled and the note field is read-only until the page changes. A second click
  does not post again.
- The ring is the only motion. `prefers-reduced-motion: reduce` leaves it still. The label change carries the
  state without it.
- The page does not reload itself while an action is on its way.

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
- **Lucide.** Nav, footer, file, and step icons are the official Lucide 1.70.0 paths (`columns-3`, `inbox`, `hand-helping`, `folder-git-2`, `history`, `chart-column`, `calendar`, `zap`, `settings`, `pause`, `play`, `bell`, `bell-off`, `check`, `file-text`, `scroll-text`, `list-checks`), inlined. ISC, copyright Lucide Icons and Contributors. https://lucide.dev https://github.com/lucide-icons/lucide

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
- Hit targets for icon buttons use `--hit` (44px). Nav rows can stay compact when the whole row is the target.

## Checklist for any new screen

- Spacing, type, radius, and color come from tokens. Colors come from the active theme. The style guard passes.
- The screen follows the Don't list: no card bars, glow, washes, pills, or all-caps eyebrows.
- Tags, status, filter chips, and count badges share `--radius-md` and `--space-2` padding.
- A running card shows the step bar and liveness. The job page shows the progress row and the open step's log.
- Links have no underline. Focus rings stay. Spec, log, and findings are `.text-btn`.
- The screen uses the page gutter and stays within `--content-max`.
- Drawer content is padded on all sides. The footer is sticky. The primary action is on the right, Cancel on its left.
- Labels sit above fields. Fields are full width. Hints and errors are inline. The primary action stays disabled until the form is valid.
- Pickers are chips only up to 5 and never overflow horizontally.
- Empty, error, and (if the screen loads) waiting states exist.
- Times are local plus relative.
- Focus rings and keyboard work without a pointer.
