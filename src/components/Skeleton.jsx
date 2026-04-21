import React from 'react'

export default function Skeleton({ className = '', rounded = 'rounded' }) {
  return (
    <div
      className={`${rounded} animate-shimmer ${className}`}
      style={{
        backgroundImage: 'linear-gradient(90deg, rgba(30,39,64,0.25) 0%, rgba(30,39,64,0.55) 50%, rgba(30,39,64,0.25) 100%)',
        backgroundSize: '600px 100%',
      }}
      aria-hidden="true"
    />
  )
}
