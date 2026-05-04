import { useEffect, useState, useCallback } from 'react'
import { track } from '../lib/analytics'

const DISMISS_KEY = 'predictflow_install_dismissed'

// Captures the browser's `beforeinstallprompt` event and exposes a promptable
// install action. Only returns true once the site meets PWA install criteria
// and the user hasn't dismissed the prompt.
export function useInstallPrompt() {
  const [deferred, setDeferred] = useState(null)
  const [installed, setInstalled] = useState(false)

  useEffect(() => {
    const dismissed = localStorage.getItem(DISMISS_KEY) === '1'

    const onBeforeInstall = (e) => {
      e.preventDefault()
      if (!dismissed) {
        setDeferred(e)
        track('pwa_install_prompt_available', {})
      }
    }
    const onInstalled = () => {
      setInstalled(true)
      setDeferred(null)
      track('pwa_installed', {})
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  const prompt = useCallback(async () => {
    if (!deferred) return 'unavailable'
    track('pwa_install_prompt_shown', {})
    deferred.prompt()
    const choice = await deferred.userChoice
    setDeferred(null)
    if (choice.outcome === 'dismissed') {
      localStorage.setItem(DISMISS_KEY, '1')
      track('pwa_install_prompt_dismissed', { source: 'native_choice' })
    } else {
      track('pwa_install_prompt_accepted', {})
    }
    return choice.outcome
  }, [deferred])

  const dismiss = useCallback(() => {
    localStorage.setItem(DISMISS_KEY, '1')
    setDeferred(null)
    track('pwa_install_prompt_dismissed', { source: 'manual' })
  }, [])

  return {
    canInstall: !!deferred,
    installed,
    prompt,
    dismiss,
  }
}
