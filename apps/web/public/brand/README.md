# Brand assets

Static brand art for DiscordDrive. Keep every file in this folder so paths stay
bundled with the app and are served straight off disk by the web server.

## Files

| File     | Use                                                                                                     | Size / ratio |
| -------- | ------------------------------------------------------------------------------------------------------- | ------------ |
| `icon.png` | Favicon, Apple touch icon, avatar fallback, PWA maskable icon (referenced from `index.html` and `manifest.webmanifest`). | 500 × 500, square |
| `logo.png` | Full logo lockup shown in the sidebar and mobile nav bars.                                             | 512 × 512 (or 4:1 horizontal, any) |

To replace artwork, keep the same filenames and drop the new file in — no code
changes are needed.

## Screenshot placeholders

Screens futuristic shells use `ScreenshotPlaceholder`, a dashed neon frame that
renders a caption such as `[SCREENSHOT: File manager — file rows with progress]`.
Place finished artwork in `apps/web/public/screenshots/<slug>.png` and point the
placeholder at it, or overlay the frame with a real frame.

Expected captures (names are matched to the `[SCREENSHOT:` captions in code):

| Caption keyword        | Suggested file                       | Aspect |
| ---------------------- | ------------------------------------ | ------ |
| `File manager`         | `screenshots/file-manager.png`       | 16:9   |
| `Upload in progress`   | `screenshots/upload-progress.png`    | 16:9   |
| `Discord ... Webhooks` | `screenshots/webhook-setup.png`      | 16:9   |
| `Admin — approvals`    | `screenshots/admin-approvals.png`    | 16:9   |