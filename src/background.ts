// src/background.ts

let offscreenPort: chrome.runtime.Port | null = null
let offscreenReady = false
let lastKnownRecording = false

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
function bglog(...a: any[]) { console.log('[background]', ...a) }
function setBadge(recording: boolean) {
  chrome.action.setBadgeText({ text: recording ? 'REC' : '' }).catch?.(() => {})
}

async function hasOffscreenContext(): Promise<boolean> {
  try {
    const getContexts = (chrome.runtime as any).getContexts as
      | ((q: { contextTypes: ('OFFSCREEN_DOCUMENT' | string)[] }) => Promise<any[]>)
      | undefined
    if (getContexts) {
      const ctx = await getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).catch(() => [])
      return Array.isArray(ctx) && ctx.length > 0
    }
  } catch {}
  try { return !!(await (chrome.offscreen as any).hasDocument?.()) } catch { return false }
}

async function ensureOffscreen(): Promise<void> {
  const have = await hasOffscreenContext()
  if (!have) {
    bglog('Creating offscreen document…')
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('offscreen.html'),
      reasons: ['BLOBS', 'AUDIO_PLAYBACK', 'USER_MEDIA'],
      justification: 'Record tab audio+video in offscreen using MediaRecorder'
    })
  }

  for (let i = 0; i < 10 && !(offscreenPort && offscreenReady); i++) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_PING' })
      if (res?.ok) { bglog('Offscreen responded to PING'); break }
    } catch {}
    await wait(100)
  }

  if (!(offscreenPort && offscreenReady)) {
    try { await chrome.runtime.sendMessage({ type: 'OFFSCREEN_CONNECT' }) } catch {}
  }

  for (let i = 0; i < 50; i++) {
    if (offscreenPort && offscreenReady) return
    await wait(100)
  }
  throw new Error('Offscreen did not become ready')
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'offscreen') return
  bglog('Offscreen connected')
  offscreenPort = port
  offscreenReady = false

  port.onMessage.addListener((msg: any) => {
    if (msg?.type === 'OFFSCREEN_READY') {
      offscreenReady = true
      bglog('Offscreen is READY (Port)')
    }

    if (msg?.type === 'RECORDING_STATE') {
      lastKnownRecording = !!msg.recording
      setBadge(lastKnownRecording)
      chrome.runtime.sendMessage({ type: 'RECORDING_STATE', recording: lastKnownRecording }).catch(() => {})
    }

    if (msg?.type === 'OFFSCREEN_SAVE') {
      const filename =
        (typeof msg.filename === 'string' && msg.filename.trim())
          ? msg.filename
          : `google-meet-recording-${Date.now()}.webm`

      if (msg.blobUrl) {
        bglog('Saving OFFSCREEN_SAVE via blobUrl', filename)
        chrome.downloads.download({ url: msg.blobUrl, filename, saveAs: true }, () => {
          if (chrome.runtime.lastError) {
            bglog('downloads.download error:', chrome.runtime.lastError.message)
          } else {
            chrome.runtime.sendMessage({ type: 'RECORDING_SAVED', filename }).catch(() => {})
          }
          setTimeout(() => {
            try { offscreenPort?.postMessage({ type: 'REVOKE_BLOB_URL', blobUrl: msg.blobUrl }) } catch {}
          }, 10_000)
        })
        return
      }
    }
  })

  port.onDisconnect.addListener(() => {
    bglog('Offscreen disconnected')
    offscreenPort = null
    offscreenReady = false
    setBadge(false)
  })
})

function postToOffscreen(msg: any): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!offscreenPort) return reject(new Error('Offscreen port not connected'))
    const id = Math.random().toString(36).slice(2)
    msg.__id = id

    const listener = (m: any) => {
      if (m && m.__respFor === id) {
        offscreenPort!.onMessage.removeListener(listener)
        resolve(m.payload)
      }
    }

    offscreenPort.onMessage.addListener(listener)
    offscreenPort.postMessage(msg)

    setTimeout(() => {
      try { offscreenPort!.onMessage.removeListener(listener) } catch {}
      reject(new Error('Offscreen response timeout'))
    }, 15000)
  })
}

// background side streamId helper
function getStreamIdForTab(tabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id?: string) => {
        const err = chrome.runtime.lastError
        if (err) return reject(new Error(err.message))
        if (!id) return reject(new Error('Empty streamId'))
        resolve(id)
      })
    } catch (e) {
      reject(e as any)
    }
  })
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === 'START_RECORDING') {
      const tabId: number | undefined = msg.tabId
      if (typeof tabId !== 'number') { sendResponse({ ok: false, error: 'Missing tabId' }); return }
      bglog('Popup requested START_RECORDING for tabId', tabId)

      try {
        await ensureOffscreen()
        bglog('ensureOffscreen() completed')
      } catch (e: any) {
        sendResponse({ ok: false, error: `Offscreen not ready: ${e?.message || e}` })
        return
      }

      try {
        const streamId = await getStreamIdForTab(tabId)
        const r = await postToOffscreen({ type: 'OFFSCREEN_START', streamId })
        bglog('postToOffscreen(OFFSCREEN_START) response', r)

        if (r?.ok) {
          lastKnownRecording = true
          setBadge(true)
          chrome.runtime.sendMessage({ type: 'RECORDING_STATE', recording: true }).catch(() => {})
          sendResponse({ ok: true })
        } else {
          sendResponse({ ok: false, error: r?.error || 'Failed to start' })
        }
      } catch (e: any) {
        bglog('OFFSCREEN_START failed', e)
        sendResponse({ ok: false, error: `OFFSCREEN_START failed: ${e?.message || e}` })
      }
      return
    }

    if (msg?.type === 'STOP_RECORDING') {
      try {
        await ensureOffscreen()
        if (offscreenPort) {
          const r = await postToOffscreen({ type: 'OFFSCREEN_STOP' })
          bglog('postToOffscreen(OFFSCREEN_STOP) response', r)
        }
        sendResponse({ ok: true })
      } catch (e: any) {
        sendResponse({ ok: false, error: `STOP failed: ${e?.message || e}` })
      }
      return
    }

    if (msg?.type === 'GET_RECORDING_STATUS') {
      sendResponse({ recording: lastKnownRecording })
      return
    }
  })().catch((err) => {
    console.error('[background] top-level error', err)
    sendResponse({ ok: false, error: String(err) })
  })

  return true
})

chrome.runtime.onSuspend?.addListener(async () => {
  try { if (offscreenPort) await postToOffscreen({ type: 'OFFSCREEN_STOP' }) } catch {}
  setBadge(false)
})
