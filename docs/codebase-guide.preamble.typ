// Start each chapter (level-1 heading) on a fresh page.
#show heading.where(level: 1): it => {
  pagebreak(weak: true)
  block(above: 1.2em, below: 0.8em, it)
}
// A little air above sub-headings.
#show heading.where(level: 2): it => block(above: 1.1em, below: 0.6em, it)
#show heading.where(level: 3): it => block(above: 0.9em, below: 0.5em, it)

// Code: slightly smaller, with a soft background and padding.
#show raw.where(block: true): it => block(
  fill: luma(245),
  inset: 8pt,
  radius: 3pt,
  width: 100%,
  text(size: 0.82em, it),
)
#show raw.where(block: false): it => box(
  fill: luma(243), inset: (x: 2pt), outset: (y: 2pt), radius: 2pt, text(size: 0.9em, it),
)

// Block quotes (the Background asides) get a left rule and a tint.
#show quote.where(block: true): it => block(
  fill: luma(248), inset: 10pt, radius: 2pt, width: 100%,
  stroke: (left: 2pt + luma(180)), it,
)
