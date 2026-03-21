import React from 'react'

export function HeroIdle() {
  return (
    <div className="flex flex-col items-center gap-8 max-w-lg">
      {/* Teal starburst */}
      <div className="relative w-20 h-20">
        <svg viewBox="0 0 80 80" className="w-full h-full">
          <defs>
            <radialGradient id="burst" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#2dd4bf" />
              <stop offset="100%" stopColor="#0d9488" />
            </radialGradient>
          </defs>
          <path
            d="M40 4 L46 28 L68 12 L52 34 L76 40 L52 46 L68 68 L46 52 L40 76 L34 52 L12 68 L28 46 L4 40 L28 34 L12 12 L34 28 Z"
            fill="url(#burst)"
          />
        </svg>
      </div>

      <h1
        className="text-3xl font-bold text-center t-text"
        style={{ fontFamily: "'Playfair Display', serif" }}
      >
        What would you like to do?
      </h1>
    </div>
  )
}
