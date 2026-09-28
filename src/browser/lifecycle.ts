import type { PartyLifecycleSource } from '../core/PartyClient.js'

type EventTargetLike = {
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
}

type VisibilityTargetLike = EventTargetLike & {
  visibilityState?: string
}

export type BrowserPartyLifecycleTargets = {
  documentTarget?: VisibilityTargetLike | null
  windowTarget?: EventTargetLike | null
}

function defaultDocumentTarget(): VisibilityTargetLike | null {
  return typeof document === 'undefined' ? null : document
}

function defaultWindowTarget(): EventTargetLike | null {
  return typeof window === 'undefined' ? null : window
}

export function createBrowserPartyLifecycleSource(
  targets: BrowserPartyLifecycleTargets = {},
): PartyLifecycleSource {
  const documentTarget =
    targets.documentTarget === undefined ? defaultDocumentTarget() : targets.documentTarget
  const windowTarget =
    targets.windowTarget === undefined ? defaultWindowTarget() : targets.windowTarget

  const isForeground = () => documentTarget?.visibilityState !== 'hidden'

  return {
    isForeground,
    subscribe(listener) {
      const notifyIfForeground = () => {
        if (isForeground()) listener()
      }

      const onVisibilityChange: EventListener = () => notifyIfForeground()
      const onPageShow: EventListener = () => notifyIfForeground()
      const onOnline: EventListener = () => notifyIfForeground()

      documentTarget?.addEventListener('visibilitychange', onVisibilityChange)
      windowTarget?.addEventListener('pageshow', onPageShow)
      windowTarget?.addEventListener('online', onOnline)

      return () => {
        documentTarget?.removeEventListener('visibilitychange', onVisibilityChange)
        windowTarget?.removeEventListener('pageshow', onPageShow)
        windowTarget?.removeEventListener('online', onOnline)
      }
    },
  }
}
