// src/popup.ts

const saveBtn  = document.getElementById('save') as HTMLButtonElement | null
const micBtn   = document.getElementById('enable-mic') as HTMLButtonElement | null
const startBtn = document.getElementById('start-rec') as HTMLButtonElement | null
const stopBtn  = document.getElementById('stop-rec') as HTMLButtonElement | null

function setUI(recording: boolean) {
  if (!startBtn || !stopBtn) return
  startBtn.disabled = recording
  stopBtn.disabled  = !recording
}

function toast(msg: string) {
  console.log('[popup]', msg)
}

// open the full mic-setup tab
async function openMicSetupTab() {
  await chrome.tabs.create({ url: chrome.runtime.getURL('micsetup.html') })
}

// reflect mic permission state in the button label
async function refreshMicButton() {
  if (!micBtn || !('permissions' in navigator)) return
  try {
    // @ts-ignore — Chrome supports this permission name
    const status = await (navigator as any).permissions.query({ name: 'microphone' })
    const set = () => {
      micBtn.textContent =
        status.state === 'granted' ? 'Microphone Enabled' :
        status.state === 'denied'   ? 'Microphone Blocked' :
                                      'Enable Microphone'
      micBtn.disabled = status.state === 'granted'
      micBtn.title = status.state === 'granted'
        ? 'Microphone is already enabled for this extension'
        : 'Grant microphone permission so your voice is included in recordings'
    }
    set()
    status.onchange = set
  } catch {
    // keep default label if permissions API is not be available
  }
}

void (async () => {
  try {
    const st = await chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATUS' })
    setUI(!!st?.recording)
  } catch {
    setUI(false)
  }
  refreshMicButton().catch(() => {})
})()

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'RECORDING_STATE') {
    setUI(!!msg.recording)
  }
  if (msg?.type === 'RECORDING_SAVED') {
    toast(`Saved: ${msg.filename || 'recording.webm'}`)
    setUI(false)
  }
})

// mic permissions
micBtn?.addEventListener('click', async () => {
  try {
    if ('permissions' in navigator) {
      // @ts-ignore
      const p = await (navigator as any).permissions.query({ name: 'microphone' })
      if (p.state === 'granted') {
        alert('Microphone is already enabled for this extension.')
        await refreshMicButton()
        return
      }
      if (p.state === 'denied') {
        // go straight to setup tab
        await openMicSetupTab()
        return
      }
    }

    // try inline
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true })
      s.getTracks().forEach(t => t.stop())
      alert('Microphone enabled for the extension.')
      await refreshMicButton()
    } catch {
      // inline failed -> open the reliable setup tab
      await openMicSetupTab()
    }
  } catch (e) {
    console.error('[popup] mic enable flow error', e)
    alert('Could not open the microphone setup page. Please try again.')
  }
})

saveBtn?.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return
  const res = await chrome.tabs.sendMessage(tab.id, { type: 'GET_TRANSCRIPT' }).catch((e) => {
    toast('No transcript on this page'); throw e
  })
  const transcript = res?.transcript as string | undefined
  if (!transcript?.trim()) return toast('Transcript is empty')

  const blob = new Blob([transcript], { type: 'text/plain' })
  const url  = URL.createObjectURL(blob)
  const suffix = new URL(tab.url ?? 'https://meet.google.com').pathname.split('/').pop() || 'google-meet'

  chrome.downloads.download(
    { url, filename: `google-meet-transcript-${suffix}-${Date.now()}.txt`, saveAs: true },
    () => URL.revokeObjectURL(url)
  )
})

let inFlight = false

startBtn?.addEventListener('click', async () => {
  if (!startBtn || !stopBtn || inFlight) return
  inFlight = true
  startBtn.disabled = true
  try {
    // auto-prime mic if not granted
    if ('permissions' in navigator) {
      try {
        // @ts-ignore
        const status = await (navigator as any).permissions.query({ name: 'microphone' })
        if (status.state !== 'granted') {
          try {
            const s = await navigator.mediaDevices.getUserMedia({ audio: true })
            s.getTracks().forEach(t => t.stop())
          } catch { 
            // proceed with tab-only audio
            }
        }
      } catch { 
        // do nothing
      }
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id) throw new Error('No active tab')

    const resp = await chrome.runtime.sendMessage({ type: 'START_RECORDING', tabId: tab.id })
    if (!resp) throw new Error('No response from background')
    if (resp.ok === false) throw new Error(resp.error || 'Failed to start')

    setUI(true)
    toast('Recording started')
  } catch (e: any) {
    console.error('[popup] START_RECORDING error', e)
    setUI(false)
    alert(`Failed to start recording:\n${e?.message || e}`)
  } finally {
    inFlight = false
  }
})

stopBtn?.addEventListener('click', async () => {
  if (!startBtn || !stopBtn || inFlight) return
  inFlight = true
  stopBtn.disabled = true
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' })
    if (!resp) throw new Error('No response from background')
    if (resp.ok === false) throw new Error(resp.error || 'Failed to stop')

    toast('Stopping… finalizing…')
  } catch (e: any) {
    console.error('[popup] STOP_RECORDING error', e)
    alert(`Failed to stop recording:\n${e?.message || e}`)
    setUI(false)
  } finally {
    inFlight = false
  }
})
