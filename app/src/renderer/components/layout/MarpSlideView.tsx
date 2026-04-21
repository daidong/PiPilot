import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { resolveMarkdownImageUrl } from '../../utils/markdown-image'

const remarkPlugins = [remarkGfm]

interface MarpSlideViewProps {
  slides: string[]
  /** Directory of the source .md file, used to resolve relative image
   *  refs within slide content. */
  baseDir?: string
}

// Renders a Marp deck as a vertical stack of 16:9 cards. Each card
// displays one slide's markdown — content that overflows the aspect
// ratio simply grows the card taller rather than getting clipped, so
// dense slides stay legible. The aesthetic leans restrained (paper
// background, hairline border, subtle shadow) rather than chasing a
// full presentation theme; the goal is "I can skim the deck structure
// in the drawer", not "pixel-perfect slide preview".
export function MarpSlideView({ slides, baseDir }: MarpSlideViewProps) {
  if (slides.length === 0) {
    return (
      <p className="text-xs t-text-muted">
        No slides detected. Switch to source view to inspect the markdown.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {slides.map((slide, index) => (
        <article
          key={index}
          className="relative t-bg-surface border t-border rounded-lg shadow-sm overflow-hidden"
          style={{ aspectRatio: '16 / 9', minHeight: 200 }}
          aria-label={`Slide ${index + 1} of ${slides.length}`}
        >
          <div className="absolute top-2 right-3 text-[10px] font-mono tabular-nums t-text-muted z-10">
            {index + 1} / {slides.length}
          </div>
          <div
            className="md-prose h-full overflow-auto px-6 py-5"
            style={{ color: 'var(--color-text)', fontSize: '14px', lineHeight: 1.5 }}
          >
            <ReactMarkdown
              remarkPlugins={remarkPlugins}
              components={{
                img: ({ src, alt, ...rest }) => (
                  <img
                    src={resolveMarkdownImageUrl(src as string | undefined, baseDir)}
                    alt={alt}
                    {...rest}
                  />
                )
              }}
            >
              {slide}
            </ReactMarkdown>
          </div>
        </article>
      ))}
    </div>
  )
}
