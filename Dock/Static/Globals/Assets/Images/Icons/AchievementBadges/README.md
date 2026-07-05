# Achievement Badge Images

Each streak badge defined in `Common/Constants/StreakBadges.json` points at one image
in this folder via its `imagePath` field. The 25 badge images are present as **WebP**
(1024×1024, transparent, lossy q95, ≈130–790 KB each — chosen so each stays under 1 MB
while keeping truecolour quality with no palette banding). The UI also has a 🏅 fallback
glyph, so a missing/failed image degrades gracefully.

## Replacing or updating a badge

1. Drop a new source image (square, transparent background) and convert it to WebP at
   the same name, e.g. `FirstLogin.webp`. The encode used was:
   `Image.open(src).convert("RGBA").resize((1024,1024)).save(dst, "WEBP", quality=95, method=6)`.
2. To change a badge's name, threshold, or image filename, edit
   `Common/Constants/StreakBadges.json` and re-run `npm run setup` (the badge list is mirrored
   into every service by codegen, and `Main/` is copied to `Dock/Static/`).

## Notes for this batch

- The untouched, full-resolution **original PNGs are preserved** in
  `C:/Users/Sourav/Downloads/BadgeOriginals/`.
- Two source filenames were spelling-corrected to match the badge names in the table:
  - `RealityRevolutionistBadge.png` → **RealityRevisionist.webp** (badge "Reality Revisionist", streak 300)
  - `CognitiveDietyBadge.png` → **CognitiveDeity.webp** (badge "Cognitive Deity", streak 730)
  - `Walking EncyclopediaBadge.png` (space) → **WalkingEncyclopedia.webp**
