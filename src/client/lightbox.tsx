/**
 * Shared lightbox: opens a generated image full-screen with prev/next
 * navigation, keyboard support, and a download pill. Used by both the panel
 * (assets/queue previews) and the tool card (result images).
 */
import { createElement as h, useEffect } from 'react'

export interface LightboxProps {
  t: (key: string, ...rest: unknown[]) => string
  images: string[]
  /** Per-image media kind, parallel to `images`; omitted defaults to image. */
  kinds?: Array<'image' | 'video' | 'audio' | 'other'>
  index: number
  onClose: () => void
  onIndex: (index: number) => void
}

/** Full-screen media overlay with prev/next navigation. */
export function Lightbox({ t, images, kinds, index, onClose, onIndex }: LightboxProps): ReturnType<typeof h> | null {
  const count = images.length
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
      else if (event.key === 'ArrowLeft') onIndex((index - 1 + count) % count)
      else if (event.key === 'ArrowRight') onIndex((index + 1) % count)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [index, count, onClose, onIndex])
  const src = images[index]
  if (src === undefined) return null
  const kind = kinds?.[index] ?? 'image'
  const media = kind === 'video'
    ? h('video', { className: 'dsc-lightbox-media', src, controls: true, autoPlay: true })
    : kind === 'audio'
      ? h('audio', { className: 'dsc-lightbox-media', src, controls: true, autoPlay: true })
      : kind === 'image'
        ? h('img', { className: 'dsc-lightbox-img', src, alt: '' })
        : h('div', { className: 'dsc-lightbox-media' }, src)
  return h('div', { className: 'dsc-lightbox', onClick: onClose },
    h('div', { className: 'dsc-lightbox-body', onClick: (event: { stopPropagation: () => void }) => event.stopPropagation() },
      h('button', {
        className: 'dsc-lightbox-close',
        'aria-label': t('close'),
        onClick: (event: { stopPropagation: () => void }) => { event.stopPropagation(); onClose() },
      }, '✕'),
      count > 1
        ? h('button', {
            className: 'dsc-lightbox-nav dsc-lightbox-nav--prev',
            'aria-label': t('lbPrev'),
            onClick: (event: { stopPropagation: () => void }) => { event.stopPropagation(); onIndex((index - 1 + count) % count) },
          }, '‹')
        : null,
      media,
      h('div', { className: 'dsc-lightbox-meta' },
        h('span', null, `${index + 1} / ${count}`),
        h('a', { className: 'dsc-lightbox-download', href: src, download: '', target: '_blank', rel: 'noreferrer' }, t('cardDownload')),
      ),
      count > 1
        ? h('button', {
            className: 'dsc-lightbox-nav dsc-lightbox-nav--next',
            'aria-label': t('lbNext'),
            onClick: (event: { stopPropagation: () => void }) => { event.stopPropagation(); onIndex((index + 1) % count) },
          }, '›')
        : null,
    ),
  )
}
