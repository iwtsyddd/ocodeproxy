# Rules & Guidelines for Agents

This document defines core conventions, design standards, and coding rules for all AI agents and contributors working in this repository.

---

## 1. UI Language Standard

- **Strict Requirement**: All UI, TUI, CLI outputs, banners, interactive prompts, hints, menus, log messages, spinner labels, and error descriptions must **ALWAYS be in English**.
- Do not mix languages or display non-English strings in user-facing terminal interfaces.

---

## 2. Terminal UI (TUI) & Output Guidelines

Never build ad-hoc ASCII boxes or manual string paddings. Always use the project's dedicated UI libraries:

### Libraries
- **`@clack/prompts`**: Use for all interactive flows:
  - Intros and outros (`p.intro`, `p.outro`)
  - Menus and selections (`p.select`, `p.multiselect`)
  - Text input and validation (`p.text`)
  - Spinners and operation status (`p.spinner`, `p.log`)
  - Clean cancel handling (`p.isCancel`)
- **`boxen`**: Use for all static banners, status cards, and framed informational displays:
  - Always use `borderStyle: "round"` with `borderColor: "cyan"` (or semantic color).
  - Let `boxen` handle width calculations automatically; it properly computes string widths for ANSI colors and multi-column emojis (preventing broken right-hand borders).
- **`picocolors`**: Use for all ANSI color styling and formatting (faster and lighter than chalk).

### CLI & TUI Conventions
- **Interactive Check**: Always verify `process.stdin.isTTY` before launching interactive prompts. Non-interactive environments (CI, background jobs, flags like `-p`) must bypass prompts and use defaults/arguments directly.
- **Request Logging Format**:
  - `[HH:MM:SS] <METHOD> <path> <STATUS_CODE> <duration>ms`
  - Color status codes semantically:
    - 2xx: `green`
    - 3xx: `cyan`
    - 4xx: `yellow`
    - 5xx: `red`
- **Hot-swapping & Keybindings**:
  - Always pause raw-mode keypress listeners before launching interactive TUI prompts (`pauseKeybindings()`), and resume them afterward (`setupKeybindings()`).
  - Always verify target port availability with `isPortAvailable()` before attempting a hot-swap to avoid unhandled socket errors.

---

## 3. Code Style & Commenting Rules

- **Forbidden**: Never use decorative divider comments, ASCII lines, or heavy section headers such as:
  ```javascript
  // ── Request Logger ──────────────────────────────────────────────────
  // ====================================================================
  // ************************** HELPERS *********************************
  ```
- **Allowed**: Use only standard, minimal single-line comments (`// check port availability`) or JSDoc blocks when clarifying non-obvious logic.
- Keep functions modular, readable, and self-documenting.
