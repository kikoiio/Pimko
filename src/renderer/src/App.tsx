import { useRef, useState } from 'react'
import type { ProjectRevision } from '../../domain/project'
import type { ExportResult, ImportResult, PimkoApi } from '../../shared/api'

declare global {
  interface Window {
    pimko: PimkoApi
  }
}

interface ChatMessage {
  id: string
  role: 'user' | 'agent'
  text: string
}

type Stage = 'idle' | 'drafting' | 'ready' | 'exporting'
type PreviewMode = 'draft' | 'output'

let messageSeq = 0
function nextMessageId(): string {
  messageSeq += 1
  return `m-${messageSeq}`
}

function totalDuration(revision: ProjectRevision): number {
  return revision.project.timeline.clips.reduce(
    (sum, clip) => sum + (clip.sourceEndSec - clip.sourceStartSec),
    0,
  )
}

function fmt(seconds: number): string {
  return `${seconds.toFixed(1)} 秒`
}

export function App() {
  const [stage, setStage] = useState<Stage>('idle')
  const [revision, setRevision] = useState<ProjectRevision | null>(null)
  const [sourceUrl, setSourceUrl] = useState<string | null>(null)
  const [output, setOutput] = useState<ExportResult | null>(null)
  const [previewMode, setPreviewMode] = useState<PreviewMode>('draft')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [feedback, setFeedback] = useState('')
  const [error, setError] = useState<string | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const activeClipRef = useRef(0)

  const clips = revision?.project.timeline.clips ?? []

  function pushAgent(text: string): void {
    setMessages((prev) => [...prev, { id: nextMessageId(), role: 'agent', text }])
  }

  async function handleImport(): Promise<void> {
    setError(null)
    setStage('drafting')
    try {
      const result: ImportResult | null = await window.pimko.importVideo()
      if (!result) {
        setStage('idle')
        return
      }
      setRevision(result.revision)
      setSourceUrl(result.sourceUrl)
      setOutput(null)
      setPreviewMode('draft')
      activeClipRef.current = 0
      setMessages([])
      const count = result.revision.project.timeline.clips.length
      pushAgent(`草稿好了：${count} 段，共 ${fmt(totalDuration(result.revision))}。看看哪里不顺，直接告诉我。`)
      setStage('ready')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStage('idle')
    }
  }

  async function handleRevise(): Promise<void> {
    if (!revision || !feedback.trim()) return
    const text = feedback.trim()
    setFeedback('')
    setMessages((prev) => [...prev, { id: nextMessageId(), role: 'user', text }])
    try {
      const before = totalDuration(revision)
      const next = await window.pimko.revise(revision.project.id, text)
      setRevision(next)
      setOutput(null)
      setPreviewMode('draft')
      activeClipRef.current = 0
      const delta = totalDuration(next) - before
      const deltaText = delta === 0 ? '时长不变' : `${delta > 0 ? '+' : ''}${fmt(delta)}`
      pushAgent(`改好了：${next.project.timeline.clips.length} 段，${fmt(totalDuration(next))}（${deltaText}）。`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleExport(): Promise<void> {
    if (!revision) return
    setError(null)
    setStage('exporting')
    try {
      const result = await window.pimko.exportVideo(revision.project.id)
      if (result) {
        setOutput(result)
        setPreviewMode('output')
        pushAgent(`成片已导出：${result.outputPath}`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStage('ready')
    }
  }

  function playFrom(index: number): void {
    const clip = clips[index]
    if (!clip || !videoRef.current) return
    activeClipRef.current = index
    videoRef.current.currentTime = clip.sourceStartSec
    void videoRef.current.play()
  }

  function handleTimeUpdate(): void {
    if (previewMode !== 'draft' || !videoRef.current) return
    const clip = clips[activeClipRef.current]
    if (!clip) return
    if (videoRef.current.currentTime >= clip.sourceEndSec) {
      const next = activeClipRef.current + 1
      if (next < clips.length) {
        playFrom(next)
      } else {
        videoRef.current.pause()
      }
    }
  }

  const previewSrc = previewMode === 'output' && output ? output.outputUrl : sourceUrl

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          Pimko
        </div>
        <div className="topbar-actions">
          {revision && (
            <button
              className="button primary"
              onClick={() => void handleExport()}
              disabled={stage !== 'ready'}
            >
              {stage === 'exporting' ? '正在生成成片…' : '生成成片'}
            </button>
          )}
          <button
            className="button"
            onClick={() => void handleImport()}
            disabled={stage === 'drafting' || stage === 'exporting'}
          >
            {stage === 'drafting' ? '正在建草稿…' : '导入视频'}
          </button>
        </div>
      </header>

      {error && <div className="error-bar">{error}</div>}

      {stage === 'idle' && !revision ? (
        <main className="empty">
          <div className="empty-copy">
            <h1>把口播视频交给 Pimko</h1>
            <p>导入素材，我先出一版草稿；你看片，用一句话说哪里不对，我改到你能直接发。</p>
            <button className="button primary large" onClick={() => void handleImport()}>
              选择视频
            </button>
          </div>
        </main>
      ) : (
        <main className="workspace">
          <section className="stage" aria-label="预览">
            {previewSrc ? (
              <video
                key={previewSrc}
                ref={videoRef}
                src={previewSrc}
                controls
                playsInline
                onTimeUpdate={handleTimeUpdate}
              />
            ) : (
              <div className="stage-placeholder">正在准备预览…</div>
            )}
            {output && (
              <div className="preview-tabs" role="tablist">
                <button
                  role="tab"
                  aria-selected={previewMode === 'draft'}
                  className={previewMode === 'draft' ? 'active' : ''}
                  onClick={() => setPreviewMode('draft')}
                >
                  草稿预览
                </button>
                <button
                  role="tab"
                  aria-selected={previewMode === 'output'}
                  className={previewMode === 'output' ? 'active' : ''}
                  onClick={() => setPreviewMode('output')}
                >
                  成片预览
                </button>
              </div>
            )}
          </section>

          <section className="chat" aria-label="反馈对话">
            <div className="chat-stream">
              {messages.map((message) => (
                <div key={message.id} className={`bubble ${message.role}`}>
                  {message.text}
                </div>
              ))}
            </div>
            <form
              className="chat-input"
              onSubmit={(event) => {
                event.preventDefault()
                void handleRevise()
              }}
            >
              <input
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
                placeholder="例如：开头太拖，直接进正题"
                aria-label="剪辑反馈"
                disabled={!revision || stage !== 'ready'}
              />
              <button type="submit" className="button primary" disabled={!feedback.trim() || stage !== 'ready'}>
                发送
              </button>
            </form>
          </section>
        </main>
      )}

      {revision && (
        <footer className="clipbar" aria-label="时间线片段">
          {clips.map((clip, index) => {
            const length = clip.sourceEndSec - clip.sourceStartSec
            return (
              <button
                key={`${clip.assetId}-${clip.sourceStartSec}`}
                className="clip"
                onClick={() => {
                  if (previewMode === 'draft') playFrom(index)
                }}
                disabled={previewMode === 'output'}
                title={`第 ${index + 1} 段 · ${clip.sourceStartSec.toFixed(1)}s – ${clip.sourceEndSec.toFixed(1)}s`}
              >
                <span className="clip-index">{index + 1}</span>
                <span className="clip-time">
                  {clip.sourceStartSec.toFixed(1)}–{clip.sourceEndSec.toFixed(1)}s
                </span>
                <span className="clip-length">{length.toFixed(1)}s</span>
              </button>
            )
          })}
        </footer>
      )}
    </div>
  )
}
