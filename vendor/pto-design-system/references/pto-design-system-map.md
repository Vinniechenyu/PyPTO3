# PTO Design System Map

Use this as the default classification when building a new module.

## Shared component families

- `Buttons`: `soft`, `solid`
- `Toggle`
- `Toggle Group`
- `Chip Filter`
- `Labels & Badges`
- `Card`
- `Data Viz Exempt`
- `Graph Node Pattern`
- `Swimlane Event Pattern`
- `IDE Frame Pattern`

The source of truth for target appearance is `/Users/yin/pto/design-system-preview.html`.

## Matching guidance

### Buttons

- `soft`: open, import, load, select, browse, local resource entry
- `solid`: primary workflow commit such as run, generate, apply, execute

Do not split equivalent entry actions into multiple visual styles. For example:

- `Open Pass Folder`
- `Open single JSON`
- `加载本地资源`

These should map to the same entry-button style.

### Toggle and toggle group

Use for mode switches, compact/semantic switches, before/after, TB/LR, and similar mutually exclusive controls.

Do not create pill-only one-off styles when the behavior is still a toggle group.

### Labels and badges

Status labels should be based on the neutral badge shape plus semantic color. Do not create unrelated tag shapes unless they are truly data-viz specific.

### Card

Use for inspector panels, action-list panels, popup detail cards, and compact in-place info blocks.

Do not treat every large surface as a card. Large canvases, viz shells, and IDE/workbench page frames belong outside this class.

During retrofit, do not keep a legacy card's private frame just because its colors were converted to tokens. Full borders, left accent rails, inset-left shadows, pseudo-element side bars, and side gradients should be removed unless the target PTO class explicitly owns that decoration. Dense right-side details should usually become `.inspector-section` plus one optional `.inspector-soft-card`, not a stack of bordered cards.

### Data Viz Exempt

Allowed exemptions:

- color maps
- graph node semantic accents
- swimlane event colors
- stitch colors
- dependency line/dot colors
- other visualization-only encodings

Even exempt patterns should be previewed and documented when they materially affect readability.

### IDE Frame Pattern

Use `patterns/ide-frame` for PTO IDE pages, workbench pages, multi-pane analysis tools, code/preview/inspector layouts, and pages that need floating playback. The pattern owns the default PTO IDE skin: 100%-intensity multi-point gradient/aura background, 80% translucent blurred panes, pane-header fill, pane shadow, transparent top chrome, activity rail, status strip, and playback mount.

Do not map an IDE/workbench page to generic `.panel-shell` or `.card-demo` containers. Product pages fill `ide-frame` slots with business content; they should not locally redefine the gradient background, pane opacity, backdrop blur, split gutter visuals, or floating playback chrome.

## Forbidden moves

- Creating a new `.xxx-btn` visual system when shared buttons already fit
- Hard-coding neutral grays, borders, shadows, or radii inside a new module
- Token-swapping old card borders or left highlight rails instead of removing them
- Rebuilding a PTO IDE page from generic panels instead of consuming `patterns/ide-frame`
- Introducing a new type scale disconnected from existing tokens
- Shipping unapproved new component visuals directly in the module
