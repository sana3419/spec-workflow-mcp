# /design-review — Visual & Interaction Audit

Engine: Claude (execute directly — requires multimodal capability for screenshot analysis)

## Trigger
- User says "check the UI", "design review", "看看界面"

## Execution

This skill is executed by Claude directly (external engines lack multimodal image analysis).

1. Collect review targets:
   - Frontend tasks marked completed in tasks.md
   - Component list from Implementation Logs/

2. Take screenshots (if possible):
   ```bash
   npx playwright screenshot http://localhost:3000 /tmp/screenshot.png
   ```
   Then use Read tool to analyze the screenshot. If screenshot tools unavailable, review source code directly.

3. Check dimensions:
   - **Consistency**: colors, font sizes, spacing (4px/8px grid), border-radius, shadows
   - **Layout**: responsive breakpoints, content overflow, empty/loading/error states
   - **Interaction**: touch targets (min 44x44px), hover/active/disabled feedback, form validation
   - **AI artifacts**: placeholder text (Lorem ipsum), inconsistent icon styles, excessive gradients, CJK spacing issues

4. Write report to `.spec-workflow/reports/claude-design-review-<YYYYMMDD-HHMMSS>.md`:
   ```
   ## Issues
   - [spacing] Card padding inconsistent: top 16px bottom 12px → unify to 16px
   - [color] Button hover #333 conflicts with theme #2563eb

   ## Passed
   - Font hierarchy clear
   - Responsive layout working
   ```

5. Fix issues and re-review until clean.
