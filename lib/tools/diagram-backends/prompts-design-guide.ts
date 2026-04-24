/**
 * Design guide constants for the diagram composer.
 *
 * These blocks embed "how to build a clean systems-paper diagram"
 * knowledge directly into the generator's brief. They exist because an
 * earlier architecture attempt (reductionist planner that culled
 * elements) was the wrong lens — crowded diagrams are mostly a
 * rendering/aesthetic problem, not an element-count problem. Teaching
 * the model via principles + a concrete example + explicit geometry
 * math produces better output than wrapping generation in control-flow
 * guardrails.
 *
 * The positive example SVG was hand-tuned against real reference
 * figures from systems papers. It demonstrates all 8 principles in a
 * single ~120-line file. Do NOT edit it casually — each element
 * illustrates a specific principle, and the geometry values are
 * calibrated to the rules in GEOMETRIC_DISCIPLINE.
 *
 * Three blocks apply to both SVG and raster paths (they are semantic):
 *   - DESIGN_PRINCIPLES
 *   - COMMON_MISTAKES
 *
 * Two blocks apply only to SVG generation (they are pixel-level math
 * and SVG-source teaching, neither of which a raster model can act on):
 *   - POSITIVE_EXAMPLE_BLOCK
 *   - GEOMETRIC_DISCIPLINE
 */

// ─── 1. The 8 design principles (semantic, both paths) ──────────────────────

export const DESIGN_PRINCIPLES = `【DESIGN PRINCIPLES】 Apply all nine. These are non-negotiable:

  1. SINGLE PRIMARY AXIS — Pick one dominant spatial axis (left-to-right
     flow, top-to-bottom flow, or a time axis) and make every other
     element serve it. Never mix two competing primary axes.

  2. NO NESTED SOLID-BORDERED BOXES — Group elements using:
       • a light background tint (fill only, no stroke)
       • a dashed border (for "optional / future / sketch" categories)
       • whitespace and alignment
       • a small header label positioned just above the group
     NEVER place a solid-bordered rect inside another solid-bordered rect.
     Small backfilled pills (fill only, no stroke) INSIDE a bordered rect
     are fine — one level of visual nesting, not two.

  3. TYPOGRAPHY BY CATEGORY — Match font size, weight, and style to the
     element's CATEGORY, not to its perceived "importance". Consistent
     scales:
       • section header:    14 pt bold, Title Case ("Monitoring Pipeline")
                            NEVER ALL CAPS ("MONITORING PIPELINE") — ALL
                            CAPS is reserved for the red "!" error prefix
                            only. Section headers in caps look like
                            PowerPoint slides, not publication figures.
       • node title:        12-13 pt semibold or bold
       • sub-op label:      10 pt regular
       • caption:           9-10 pt italic
       • footnote:          9 pt regular, muted grey
     Never vary font size within the same category.

  4. SEMANTIC COLOUR + COMPACT LEGEND — Every colour must mean something.
     If you introduce a colour, explain it in a small (≤ 15% of figure
     area) legend placed in a quiet corner. Typical semantic roles:
       • navy blue            = current / in-scope / active
       • forest green         = output / result
       • dashed muted amber   = planned / future / optional
       • saturated red        = error / problem / rejection ONLY

  5. REAL CONTENT, NOT PLACEHOLDERS — Boxes must contain real labels,
     real parameters, real units. "Filter" alone is weak; "Filter —
     threshold 5°, deadband, clipping" tells the reader what the box
     actually does. Prefer specifics (100 Hz, int16, 2.4 MB/s) over
     generic descriptors ("fast", "large", "Module A").

  6. ICONS REPLACE TEXT, NEVER DECORATE — Only draw an icon if it
     replaces a short phrase more clearly than text would. Wavy line =
     signal. Monitor glyph = display. Alert bell = notification.
     Never add icons for decoration.

  7. ARROWS ARE ANCHORED, LABELS RIDE THE LINE, MULTI-BEND = ONE POLYLINE
     • Every arrow must start and end precisely on a box edge (use
       rect.x, rect.y, rect.x+width, or rect.y+height).
     • Edge labels sit ON the arrow, not floating near it. Use a small
       opaque backfill rect behind the label so the line is masked.
     • L-shape, Z-shape, or any multi-bend arrow MUST be ONE
       <polyline points="x1,y1 x2,y2 x3,y3 ..."> element with all
       vertices in a single declaration. NEVER stitch together
       multiple <line> elements to approximate an L-shape — they
       render as visually disconnected segments.

  8. RED IS RESERVED FOR PROBLEMS — Saturated red (≈#C53030) appears
     only on error / loss / rejection callouts. Muted reds (rust,
     terracotta) may be used for categorical "sketch / proposal"
     borders, but high-contrast red must stay precious.

  9. COMPACT LAYOUT — Let content density drive spacing, not the
     viewBox. Typical gaps:
       • adjacent elements in the same group:  10–30 px
       • distinct sections (e.g. "Planned" vs current work):  40–60 px
       • group backdrop padding (inside tint):  15–25 px
     NEVER exceed ~80 px of uninterrupted empty space unless the gap
     is semantically meaningful. If the user-provided viewBox is
     larger than your content needs, SHRINK THE VIEWBOX — do NOT
     stretch or spread content to fill the canvas. "Below X" means a
     20–30 px gap below X, NOT "somewhere at the bottom of the
     canvas". A figure with visible gutters of empty space looks
     unfinished regardless of how clean the content itself is.`

// ─── 2. Positive example (SVG source + annotation) ──────────────────────────
//
// The raw SVG is also exported separately so future tooling (tests,
// skill docs) can load it as a file rather than parsing the combined
// block. Keep the two in sync: if you edit one, edit the other.

export const POSITIVE_EXAMPLE_SVG = `<svg viewBox="0 0 600 440" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto">
      <path d="M0,0 L10,5 L0,10 Z" fill="#1F2937"/>
    </marker>
    <marker id="arrowBlue" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto">
      <path d="M0,0 L10,5 L0,10 Z" fill="#2C5282"/>
    </marker>
    <marker id="arrowAmber" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto">
      <path d="M0,0 L10,5 L0,10 Z" fill="#9C5C00"/>
    </marker>
    <marker id="arrowRed" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto">
      <path d="M0,0 L10,5 L0,10 Z" fill="#C53030"/>
    </marker>
  </defs>

  <rect x="0" y="0" width="600" height="440" fill="#F7FAFC"/>

  <!-- Legend: compact, top-right. Four categories. -->
  <rect x="480" y="12" width="110" height="85" rx="4" ry="4" fill="#FFFFFF" stroke="#CBD5E0" stroke-width="1"/>
  <rect x="492" y="24" width="16" height="10" rx="2" ry="2" fill="#FFFFFF" stroke="#2C5282" stroke-width="1.5"/>
  <text x="516" y="33" font-family="Inter, sans-serif" font-size="10" fill="#1F2937">current stage</text>
  <rect x="492" y="42" width="16" height="10" rx="2" ry="2" fill="#FFFFFF" stroke="#2F855A" stroke-width="1.5"/>
  <text x="516" y="51" font-family="Inter, sans-serif" font-size="10" fill="#1F2937">output</text>
  <rect x="492" y="60" width="16" height="10" rx="2" ry="2" fill="none" stroke="#9C5C00" stroke-width="1.2" stroke-dasharray="3 2"/>
  <text x="516" y="69" font-family="Inter, sans-serif" font-size="10" fill="#1F2937">planned</text>
  <text x="494" y="84" font-family="Inter, sans-serif" font-size="11" font-weight="700" fill="#C53030">!</text>
  <text x="516" y="84" font-family="Inter, sans-serif" font-size="10" fill="#1F2937">error / loss</text>

  <!-- Section header: Title Case, bold. Above the group. -->
  <text x="15" y="35" font-family="Inter, sans-serif" font-size="14" font-weight="700" fill="#1F2937">Monitoring Pipeline</text>

  <!-- Pipeline backdrop: light tint, no border — groups Parse/Filter/Aggregate. -->
  <rect x="155" y="40" width="325" height="170" rx="10" ry="10" fill="#EDF2F7" stroke="none"/>

  <!-- Input: Sensor Stream. Box widened to 130 so all four text lines fit. -->
  <rect x="15" y="55" width="130" height="140" rx="6" ry="6" fill="#FFFFFF" stroke="#4A5568" stroke-width="1.5"/>
  <path d="M22,85 q3,-5 6,0 t6,0 t6,0" fill="none" stroke="#2C5282" stroke-width="1.7" stroke-linecap="round"/>
  <text x="45" y="89" font-family="Inter, sans-serif" font-size="11" font-weight="600" fill="#1F2937">Sensor Stream</text>
  <text x="25" y="112" font-family="Inter, sans-serif" font-size="9" font-style="italic" fill="#4A5568">raw telemetry • 100 Hz</text>
  <text x="25" y="132" font-family="Inter, sans-serif" font-size="10" fill="#1F2937">12 channels • int16</text>
  <text x="25" y="152" font-family="Inter, sans-serif" font-size="9" fill="#4A5568">throughput: 2.4 MB/s</text>

  <line x1="145" y1="125" x2="160" y2="125" stroke="#1F2937" stroke-width="1.5" marker-end="url(#arrow)"/>

  <!-- Parse: title + divider + three sub-op pills (backfill only, no stroke). -->
  <rect x="160" y="55" width="95" height="140" rx="6" ry="6" fill="#FFFFFF" stroke="#2C5282" stroke-width="1.5"/>
  <text x="207" y="78" font-family="Inter, sans-serif" font-size="12" font-weight="700" fill="#1F2937" text-anchor="middle">Parse</text>
  <line x1="170" y1="85" x2="245" y2="85" stroke="#2C5282" stroke-width="0.5" opacity="0.5"/>
  <rect x="170" y="93" width="75" height="18" rx="3" ry="3" fill="#E6F0FA"/>
  <text x="175" y="105" font-family="Inter, sans-serif" font-size="10" fill="#1F2937">schema v2</text>
  <rect x="170" y="117" width="75" height="18" rx="3" ry="3" fill="#E6F0FA"/>
  <text x="175" y="129" font-family="Inter, sans-serif" font-size="10" fill="#1F2937">decode int16</text>
  <rect x="170" y="141" width="75" height="18" rx="3" ry="3" fill="#E6F0FA"/>
  <text x="175" y="153" font-family="Inter, sans-serif" font-size="10" fill="#1F2937">timestamp</text>

  <line x1="255" y1="125" x2="270" y2="125" stroke="#2C5282" stroke-width="1.5" marker-end="url(#arrowBlue)"/>

  <!-- Filter -->
  <rect x="270" y="55" width="95" height="140" rx="6" ry="6" fill="#FFFFFF" stroke="#2C5282" stroke-width="1.5"/>
  <text x="317" y="78" font-family="Inter, sans-serif" font-size="12" font-weight="700" fill="#1F2937" text-anchor="middle">Filter</text>
  <line x1="280" y1="85" x2="355" y2="85" stroke="#2C5282" stroke-width="0.5" opacity="0.5"/>
  <rect x="280" y="93" width="75" height="18" rx="3" ry="3" fill="#E6F0FA"/>
  <text x="285" y="105" font-family="Inter, sans-serif" font-size="10" fill="#1F2937">threshold 5°</text>
  <rect x="280" y="117" width="75" height="18" rx="3" ry="3" fill="#E6F0FA"/>
  <text x="285" y="129" font-family="Inter, sans-serif" font-size="10" fill="#1F2937">deadband</text>
  <rect x="280" y="141" width="75" height="18" rx="3" ry="3" fill="#E6F0FA"/>
  <text x="285" y="153" font-family="Inter, sans-serif" font-size="10" fill="#1F2937">clipping</text>

  <!-- RED error callout — saturated red reserved for problems only. -->
  <line x1="317" y1="195" x2="317" y2="213" stroke="#C53030" stroke-width="1.2" stroke-dasharray="3 2" marker-end="url(#arrowRed)"/>
  <rect x="275" y="215" width="85" height="22" rx="3" ry="3" fill="#FED7D7" stroke="#C53030" stroke-width="1"/>
  <text x="283" y="231" font-family="Inter, sans-serif" font-size="11" font-weight="700" fill="#C53030">!</text>
  <text x="295" y="231" font-family="Inter, sans-serif" font-size="10" font-weight="500" fill="#C53030">invalid: 3%</text>

  <line x1="365" y1="125" x2="380" y2="125" stroke="#2C5282" stroke-width="1.5" marker-end="url(#arrowBlue)"/>

  <!-- Aggregate -->
  <rect x="380" y="55" width="95" height="140" rx="6" ry="6" fill="#FFFFFF" stroke="#2C5282" stroke-width="1.5"/>
  <text x="427" y="78" font-family="Inter, sans-serif" font-size="12" font-weight="700" fill="#1F2937" text-anchor="middle">Aggregate</text>
  <line x1="390" y1="85" x2="465" y2="85" stroke="#2C5282" stroke-width="0.5" opacity="0.5"/>
  <rect x="390" y="93" width="75" height="18" rx="3" ry="3" fill="#E6F0FA"/>
  <text x="395" y="105" font-family="Inter, sans-serif" font-size="10" fill="#1F2937">1-min window</text>
  <rect x="390" y="117" width="75" height="18" rx="3" ry="3" fill="#E6F0FA"/>
  <text x="395" y="129" font-family="Inter, sans-serif" font-size="10" fill="#1F2937">mean/max/p99</text>
  <rect x="390" y="141" width="75" height="18" rx="3" ry="3" fill="#E6F0FA"/>
  <text x="395" y="153" font-family="Inter, sans-serif" font-size="10" fill="#1F2937">change rate</text>

  <!-- Two arrows diverge from Aggregate bottom, offset horizontally so
       they don't leave the same pixel. Amber L-shape drops BELOW the
       red error callout (y=245, callout ends at y=237) to avoid overlap. -->
  <line x1="447" y1="195" x2="447" y2="252" stroke="#1F2937" stroke-width="1.5" marker-end="url(#arrow)"/>
  <polyline points="415,195 415,245 160,245 160,252" fill="none" stroke="#9C5C00" stroke-width="1.2" stroke-dasharray="4 3" marker-end="url(#arrowAmber)"/>

  <!-- Planned extension: Title Case header above the dashed-amber box. -->
  <text x="20" y="250" font-family="Inter, sans-serif" font-size="12" font-weight="700" fill="#9C5C00">Planned</text>
  <rect x="15" y="255" width="290" height="100" rx="6" ry="6" fill="none" stroke="#9C5C00" stroke-width="1.5" stroke-dasharray="6 5"/>
  <text x="160" y="277" font-family="Inter, sans-serif" font-size="12" font-weight="600" fill="#1F2937" text-anchor="middle">Anomaly Detection</text>
  <rect x="30" y="290" width="125" height="20" rx="3" ry="3" fill="#FEF3E6"/>
  <text x="37" y="304" font-family="Inter, sans-serif" font-size="10" fill="#1F2937">Autoencoder baseline</text>
  <rect x="165" y="290" width="125" height="20" rx="3" ry="3" fill="#FEF3E6"/>
  <text x="172" y="304" font-family="Inter, sans-serif" font-size="10" fill="#1F2937">Adaptive threshold</text>
  <text x="30" y="335" font-family="Inter, sans-serif" font-size="9" font-style="italic" fill="#4A5568">Q3 rollout • replaces static threshold filter</text>

  <!-- Dashboard: different colour family (green) signals OUTPUT category. -->
  <rect x="310" y="255" width="275" height="120" rx="6" ry="6" fill="#FFFFFF" stroke="#2F855A" stroke-width="1.5"/>
  <rect x="325" y="272" width="22" height="15" rx="2" ry="2" fill="none" stroke="#2F855A" stroke-width="1.3"/>
  <line x1="331" y1="291" x2="341" y2="291" stroke="#2F855A" stroke-width="1.3"/>
  <text x="355" y="285" font-family="Inter, sans-serif" font-size="13" font-weight="700" fill="#1F2937">Dashboard</text>
  <line x1="325" y1="299" x2="570" y2="299" stroke="#2F855A" stroke-width="0.5" opacity="0.5"/>
  <text x="325" y="316" font-family="Inter, sans-serif" font-size="10" fill="#1F2937">• live charts (5-sec refresh)</text>
  <text x="325" y="335" font-family="Inter, sans-serif" font-size="10" fill="#1F2937">• threshold alerts → email / SMS</text>
  <text x="325" y="354" font-family="Inter, sans-serif" font-size="10" fill="#1F2937">• historical query via Grafana</text>
</svg>`

export const POSITIVE_EXAMPLE_BLOCK = `【POSITIVE EXAMPLE】 Study and emulate the design language of this
reference SVG. It is a yardstick for "what a publication-grade systems
diagram looks like" — NOT a template to copy literally.

${POSITIVE_EXAMPLE_SVG}

NOTES ON THE REFERENCE (each illustrates a specific principle):
  • Viewbox 600:440 ≈ 1.36:1 — single-column-friendly, not strongly
    landscape. Figures for a two-column paper template should usually
    stay near 1:1, 10:8, or 12:10. (Principle 1)
  • The three pipeline stages are grouped by a tinted backdrop
    (fill="#EDF2F7", stroke="none"), NOT by nesting another bordered
    rect. (Principle 2)
  • Each stage has title + a subtle divider line + three sub-op pills
    (fill only, no stroke). Pills INSIDE a bordered rect are fine
    because pills are backfills, not nested rects. (Principle 2)
  • Section header "Monitoring Pipeline" is Title Case, not ALL CAPS.
    The only ALL CAPS in the figure is the red "!" error prefix,
    where the caps-lock is deliberately emphatic. (Principles 3, 8)
  • Dashboard uses a DIFFERENT colour family (green, #2F855A) from
    pipeline stages (navy, #2C5282). The legend explains the
    categorical distinction. (Principle 4)
  • Each box contains real, specific content: "threshold 5°",
    "decode int16", "1-min window", "change rate", "2.4 MB/s". No
    generic "Module A / Stage 1" placeholders. (Principle 5)
  • The wavy-signal icon (~~) replaces the phrase "signal" for Sensor
    Stream; the monitor glyph replaces "display" for Dashboard.
    Nothing else is iconified. (Principle 6)
  • Every arrow terminates on a box edge. The "100 Hz" style edge
    labels (not present here, but the technique is in GEOMETRIC
    DISCIPLINE) sit ON the arrow with a small opaque backfill rect.
    (Principle 7)
  • Saturated red (#C53030) appears ONLY in the "! invalid: 3%"
    error callout. Muted amber is used for the planned category.
    (Principle 8)
  • Two arrows diverge from Aggregate's bottom edge at different x
    (447 and 415) so they do not leave the same pixel point. The
    amber L-shape polyline routes BELOW (y=245) the red error callout
    (which ends at y=237) rather than through it — no arrows cross
    unrelated boxes. (Principle 7 + GEOMETRIC DISCIPLINE)`

// ─── 3. Geometric discipline (SVG only, pixel-level math) ───────────────────

export const GEOMETRIC_DISCIPLINE = `【GEOMETRIC DISCIPLINE】 Apply these pixel-level rules for all SVG:

  TEXT CENTERING INSIDE A RECT
    • Vertical center: text.y = rect.y + rect.height/2 + font_size*0.35
    • Horizontal center: set text-anchor="middle" and
      text.x = rect.x + rect.width/2
    • Two-line text inside a rect:
        line 1 baseline y = rect.cy - 4
        line 2 baseline y = rect.cy + font_size + 2

  TEXT POSITIONED ABOVE A RECT (as a title)
    • text.y must be ≤ rect.y - 4 (glyphs extend upward from baseline)
    • NEVER use text.y = rect.y + 3 style positioning — the title will
      cross through the rect's top stroke.

  TEXT WIDTH ESTIMATION (Inter font family, approximate):
    • regular:        char_count × font_size × 0.55
    • semibold/bold:  char_count × font_size × 0.58
    • italic:         char_count × font_size × 0.52
    A rect that contains text must satisfy:
      rect.width ≥ text_width_estimate + 16   (8 px padding each side)
    If the text overflows: SHORTEN the text OR SHRINK the font —
    NEVER let glyphs bleed past the rect's right stroke.

  ARROWS — SOURCE AND DESTINATION ANCHORING
    • Arrow endpoint (x2, y2) must fall precisely on the destination
      rect's edge (use rect.x, rect.y, rect.x+width, or rect.y+height).
    • marker-end with orient="auto" and refX near the marker's tip
      places the arrow-head tip AT the line endpoint.

  ARROWS CROSSING OTHER BOXES — three priorities, first wins:
    1. ROUTE AROUND. Shift the arrow's y or x so it never overlaps an
       unrelated box. This is always preferred.
    2. USE AN L-SHAPED POLYLINE. A right-angle bend avoids the
       obstructing box cleanly. Diagonal arrows that clip through
       other boxes are forbidden.
    3. Z-ORDER. If an arrow MUST cross a box, declare the arrow's
       <line> or <polyline> BEFORE the box in SVG source, so the
       box paints over the arrow (arrow renders behind the box).
       This is the last-resort fix.

  MULTI-SEGMENT ARROWS (L-shape, Z-shape, any multi-bend)
    An arrow with one or more bends MUST be a SINGLE <polyline>
    element with ALL vertices in one declaration:
        CORRECT:
          <polyline points="100,50 100,80 250,80"
                    fill="none" stroke="#1F2937" stroke-width="1.5"
                    marker-end="url(#arrow)"/>
        WRONG (produces visually disconnected segments):
          <line x1="100" y1="50" x2="100" y2="80" .../>
          <line x1="100" y1="80" x2="250" y2="80" .../>
    Even when the endpoints line up arithmetically, SVG renders
    consecutive <line> elements as independent strokes with no
    shared corner — the result is a broken-looking path. Always
    use <polyline points="..."> for multi-bend arrows.

  MULTIPLE ARROWS FROM ONE BOX
    When a single box emits more than one outgoing arrow, offset the
    starting x (or y) by 20–30 px so the arrows diverge at the box's
    edge. Two arrows leaving the exact same pixel and then splaying
    outward looks chaotic.

  EDGE LABELS ON ARROWS
    Draw a small opaque rect (fill = page background color) BEFORE the
    text, covering the arrow line at the label's y-midpoint. Then draw
    the text on top. This masks the line behind the label so the
    label is readable without floating off the arrow.`

// ─── 4. Common mistakes (negative patterns, both paths) ─────────────────────

export const COMMON_MISTAKES = `【COMMON MISTAKES — DO NOT】

  ✗ text.y = rect.y + 3 or text.y = rect.y + font_size*0.2 inside a
    rect → glyphs cross the rect's top stroke, creating a
    strikethrough effect. Use the centering formula from GEOMETRIC
    DISCIPLINE.

  ✗ rect.width narrower than the text's estimated width → glyphs
    spill past the rect's right stroke. Either widen the rect or
    shorten / shrink the text.

  ✗ solid-bordered rect inside another solid-bordered rect → visual
    noise, the "box in box in box" pathology. Use tinted backdrops or
    dashed borders for grouping instead.

  ✗ a label floating 10–20 px away from its arrow → the reader cannot
    tell which arrow the label annotates. Place the label ON the
    arrow with a small opaque bg rect behind the text.

  ✗ diagonal arrows that clip through unrelated boxes → use
    L-shaped polylines (right-angle bends) to route around instead.

  ✗ two arrows leaving the same pixel of a box and then diverging →
    offset the starting x or y by 20–30 px so the arrows separate
    cleanly at the box edge.

  ✗ saturated red used for a non-error element (a section header in
    red, a decorative border in red) → dilutes the semantic weight
    of red. Reserve saturated red for errors, losses, rejections.

  ✗ ALL CAPS for regular section headers → dilutes emphasis. Title
    Case for normal headers; ALL CAPS only where semantic emphasis
    is intended (red error tags).

  ✗ generic placeholder text: "stage 1", "Component A", "Module" →
    makes the figure feel empty. Use real domain content ("Filter —
    threshold 5°", "100 Hz samples", "int16 decode").

  ✗ figures that are strongly landscape (ratio > 1.6:1) for a paper
    where the template is two-column → the figure will either span
    both columns (wasteful) or be shrunk into unreadability. Prefer
    near-square or gently landscape (1:1 to 12:8) for single-column
    placement.

  ✗ large uninterrupted empty regions (> 80 px in any direction) in
    the viewBox. Whether you shrink the viewBox or tighten the
    spacing, a figure with visible gutters looks unfinished. If the
    request says "Planned section below Layer 1", that's a 20–30 px
    gap below Layer 1, NOT an empty band in the lower half of the
    canvas.

  ✗ multi-bend arrow drawn as several <line> elements chained end-
    to-end → renders as visually disconnected segments. Use a single
    <polyline points="x1,y1 x2,y2 x3,y3 ..."> element instead.

  ✗ edge label placed on an arrow whose path crosses through a
    tinted group backdrop → the backdrop, drawn last, paints over
    the label. Either route the label to lie entirely outside any
    backdrop, or draw the label AFTER the backdrop in SVG source.`
