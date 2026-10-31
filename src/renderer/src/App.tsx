import { useEffect, useMemo, useRef, useState } from 'react'
import type { CompiledTimeline, CompiledVideoClip } from '../../domain/compiler'
import type { ProjectRevision } from '../../domain/project'
import { findFillerWords } from '../../domain/fillers'
import { compileProject } from '../../domain/legacy'
import { subtitleAtTime } from '../../domain/subtitles'
import type { ExportProgress, ExportResult, ImportResult, PimkoApi, PreviewResult, ProjectSummary } from '../../shared/api'

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

type Stage = 'idle' | 'drafting' | 'ready' | 'revising' | 'previewing' | 'exporting'
type PreviewMode = 'draft' | 'rendered' | 'output'

const BGM_PRESETS = [
  { label: '轻', gainDb: -24 },
  { label: '标准', gainDb: -18 },
  { label: '响', gainDb: -12 },
]

let messageSeq = 0
function nextMessageId(): string {
  messageSeq += 1
  return `m-${messageSeq}`
}

function compiledOf(revision: ProjectRevision): CompiledTimeline {
  return compileProject(revision.project)
}

function fmt(seconds: number): string {
  return `${seconds.toFixed(1)} 秒`
}

interface TimelineEntry {
  clipIndex: number
  outputStart: number
  outputEnd: number
}

function buildTimeline(compiled: CompiledTimeline): TimelineEntry[] {
  return compiled.videoClips.map((clip, clipIndex) => ({
    clipIndex,
    outputStart: clip.outputStartSec,
    outputEnd: clip.outputEndSec,
  }))
}

/** 草稿预览播放源视频；把当前源时间映射回输出时间，才和编译字幕对齐。 */
function outputTimeOf(clip: CompiledVideoClip, sourceTime: number): number {
  return clip.outputStartSec + (sourceTime - clip.sourceStartSec) / clip.speed
}

function qualityIssues(report: ExportResult['quality']): string[] {
  const all = [...report.checks, ...report.cuts.flatMap((cut) => cut.checks)]
  return all
    .filter((check) => check.status === 'fail' || check.status === 'warn')
    .map((check) => `${check.kind}: ${check.detail ?? check.status}`)
}

function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  console.error('[pimko]', raw)
  if (raw.includes('模型服务') || raw.includes('provider "')) return raw
  if (raw.includes('401')) return 'API Key 无效或已过期，请检查 .env 里的 key。'
  if (raw.includes('402')) return '当前模型/音频接口需要账户余额，免费额度不够用。'
  if (raw.includes('429')) return '请求太频繁，免费模型限流了；稍等一会儿再试。'
  if (raw.includes('Failed to fetch') || raw.includes('fetch failed')) return '网络请求失败，请检查网络后重试。'
  return raw
}

export function App() {
  const [stage, setStage] = useState<Stage>('idle')
  const [revision, setRevision] = useState<ProjectRevision | null>(null)
  const [sourceUrl, setSourceUrl] = useState<string | null>(null)
  const [output, setOutput] = useState<ExportResult | null>(null)
  const [storedQuality, setStoredQuality] = useState<ExportResult['quality'] | null>(null)
  const [renderedPreview, setRenderedPreview] = useState<PreviewResult | null>(null)
  const [previewMode, setPreviewMode] = useState<PreviewMode>('draft')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [feedback, setFeedback] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [liveSubtitle, setLiveSubtitle] = useState('')
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null)
  const [thumbnails, setThumbnails] = useState<Record<number, string>>({})

  const videoRef = useRef<HTMLVideoElement>(null)
  const activeClipRef = useRef(0)
  const seekingRef = useRef(false)

  const compiled = useMemo(() => (revision ? compileProject(revision.project) : undefined), [revision])
  const clips = compiled?.videoClips ?? []
  const timelineEntries = useMemo(() => (compiled ? buildTimeline(compiled) : []), [compiled])
  // 卡片标记:片段内残留的口癖与未压缩长停顿——被 LLM 处理掉后标记自然消失。
  const fillerHits = useMemo(
    () => (revision?.project.transcript ? findFillerWords(revision.project.transcript) : []),
    [revision],
  )
  const silences = revision?.project.silences ?? []
  const subtitleAppearance = compiled?.subtitleAppearance
  const subtitlesEnabled = compiled?.subtitlesEnabled ?? true
  const bgm = compiled?.bgm
  const subtitleScale = subtitleAppearance?.size === 'small' ? 0.7 : subtitleAppearance?.size === 'large' ? 1.4 : 1

  useEffect(() => {
    setRenderedPreview(null)
    setStoredQuality(null)
    if (videoRef.current) {
      videoRef.current.pause()
      videoRef.current.playbackRate = 1
    }
    if (!revision) return
    let cancelled = false
    void window.pimko.getQuality(revision.project.id, revision.id)
      .then((quality) => { if (!cancelled) setStoredQuality(quality) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [revision?.id])

  // 修订变化后重新取片段缩略图(带主进程磁盘缓存);上限 30 张防长片刷爆。
  useEffect(() => {
    if (!revision) return
    let cancelled = false
    setThumbnails({})
    void Promise.all(
      clips.slice(0, 30).map(async (_clip, index) => {
        const url = await window.pimko.getClipThumbnail(revision.project.id, index)
        return [index, url] as const
      }),
    ).then((entries) => {
      if (!cancelled) setThumbnails(Object.fromEntries(entries.filter((entry) => entry[1])) as Record<number, string>)
    })
    return () => {
      cancelled = true
    }
  }, [revision, clips])

  useEffect(() => {
    void window.pimko.listProjects().then(setProjects).catch(() => setProjects([]))
    window.pimko.onExportProgress(setExportProgress)
  }, [])

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
      setLiveSubtitle('')
      setMessages([])
      const nextCompiled = compiledOf(result.revision)
      const count = nextCompiled.videoClips.length
      pushAgent(`草稿好了：${count} 段，共 ${fmt(nextCompiled.durationSec)}。看看哪里不顺，直接告诉我。`)
      setStage('ready')
      void window.pimko.listProjects().then(setProjects).catch(() => undefined)
    } catch (err) {
      setError(friendlyError(err))
      setStage('idle')
    }
  }

  async function handleRestore(projectId: string): Promise<void> {
    setError(null)
    setStage('drafting')
    try {
      const result = await window.pimko.restoreProject(projectId)
      setRevision(result.revision)
      setSourceUrl(result.sourceUrl)
      setOutput(null)
      setPreviewMode('draft')
      activeClipRef.current = 0
      setLiveSubtitle('')
      setMessages([{
        id: nextMessageId(),
        role: 'agent',
        text: `已恢复「${result.revision.project.name}」。继续看看哪里不顺，直接告诉我。`,
      }])
      setStage('ready')
    } catch (err) {
      setError(friendlyError(err))
      setStage('idle')
    }
  }

  async function handleRevise(): Promise<void> {
    if (!revision || !feedback.trim() || stage !== 'ready') return
    setStage('revising')
    setError(null)
    const text = feedback.trim()
    setFeedback('')
    setMessages((prev) => [...prev, { id: nextMessageId(), role: 'user', text }])
    try {
      const before = compiled?.durationSec ?? 0
      const next = await window.pimko.revise(revision.project.id, text)
      const nextCompiled = compiledOf(next)
      setRevision(next)
      setOutput(null)
      setPreviewMode('draft')
      activeClipRef.current = 0
      setLiveSubtitle('')
      const delta = nextCompiled.durationSec - before
      const deltaText = delta === 0 ? '时长不变' : `${delta > 0 ? '+' : ''}${fmt(delta)}`
      const diffParts = next.diff
        ? [
            next.diff.added > 0 ? `+${next.diff.added}段` : '',
            next.diff.removed > 0 ? `-${next.diff.removed}段` : '',
            next.diff.moved > 0 ? `${next.diff.moved}段移位` : '',
            next.diff.spedUp > 0 ? `${next.diff.spedUp}段变速` : '',
          ].filter(Boolean).join('，')
        : ''
      const diffText = diffParts ? `（${diffParts}）` : ''
      const note = next.agentNote
        ? `${next.agentNote}${diffText}（${fmt(nextCompiled.durationSec)}，${deltaText}）`
        : `改好了：${nextCompiled.videoClips.length} 段${diffText}，${fmt(nextCompiled.durationSec)}（${deltaText}）。`
      pushAgent(note)
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setStage('ready')
    }
  }

  async function handleUndo(): Promise<void> {
    if (!revision) return
    setError(null)
    try {
      const next = await window.pimko.undo(revision.project.id)
      setRevision(next)
      setOutput(null)
      setPreviewMode('draft')
      activeClipRef.current = 0
      setLiveSubtitle('')
      pushAgent(next.agentNote ?? '已撤销上一步。')
    } catch (err) {
      setError(friendlyError(err))
    }
  }

  async function handleBgmVolume(gainDb: number): Promise<void> {
    if (!revision) return
    setError(null)
    try {
      const next = await window.pimko.setBgmVolume(revision.project.id, gainDb)
      setRevision(next)
      setOutput(null)
      setPreviewMode('draft')
      pushAgent(next.agentNote ?? '配乐音量已调整。')
    } catch (err) {
      setError(friendlyError(err))
    }
  }

  async function handleSetBgm(): Promise<void> {
    if (!revision) return
    setError(null)
    try {
      const next = await window.pimko.setBgm(revision.project.id)
      if (next) {
        setRevision(next)
        setOutput(null)
        setPreviewMode('draft')
        pushAgent(next.agentNote ?? '配乐已设置。')
      }
    } catch (err) {
      setError(friendlyError(err))
    }
  }

  async function handleRemoveBgm(): Promise<void> {
    if (!revision || !bgm) return
    setError(null)
    try {
      const next = await window.pimko.removeBgm(revision.project.id)
      setRevision(next)
      setOutput(null)
      setPreviewMode('draft')
      setLiveSubtitle('')
      pushAgent(next.agentNote ?? '配乐已移除。')
    } catch (err) {
      setError(friendlyError(err))
    }
  }

  function currentOutputTime(): number {
    const video = videoRef.current
    if (!video) return 0
    const duration = compiled?.durationSec ?? 0
    if (previewMode === 'draft') {
      const clip = clips[activeClipRef.current]
      if (!clip) return 0
      return Math.max(0, Math.min(duration, outputTimeOf(clip, video.currentTime)))
    }
    return Math.max(0, Math.min(duration, video.currentTime))
  }

  async function handleAddBroll(): Promise<void> {
    if (!revision) return
    setError(null)
    try {
      const next = await window.pimko.addBroll(revision.project.id, currentOutputTime())
      if (next) {
        setRevision(next)
        setOutput(null)
        setPreviewMode('draft')
        pushAgent(next.agentNote ?? 'B-roll 已插入；点击「查看实际效果」看合成结果。')
      }
    } catch (err) {
      setError(friendlyError(err))
    }
  }

  async function handlePreview(): Promise<void> {
    if (!revision || stage !== 'ready') return
    setError(null)
    setStage('previewing')
    setExportProgress(null)
    videoRef.current?.pause()
    try {
      const preview = await window.pimko.renderPreview(revision.project.id, revision.id)
      if (preview.revisionId !== revision.id) throw new Error('预览版本不一致，请重新生成。')
      setRenderedPreview(preview)
      setPreviewMode('rendered')
      setLiveSubtitle('')
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setStage('ready')
      setExportProgress(null)
    }
  }

  async function handleExport(): Promise<void> {
    if (!revision) return
    setError(null)
    setStage('exporting')
    setExportProgress(null)
    try {
      const result = await window.pimko.exportVideo(revision.project.id)
      if (result) {
        setOutput(result)
        setPreviewMode('output')
        pushAgent(`成片已导出：${result.outputPath}`)
      }
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setStage('ready')
      setExportProgress(null)
    }
  }

  function playFrom(index: number): void {
    const clip = clips[index]
    if (!clip || !videoRef.current) return
    activeClipRef.current = index
    videoRef.current.currentTime = clip.sourceStartSec
    videoRef.current.playbackRate = clip.speed
    void videoRef.current.play()
  }

  function entryForSourceTime(time: number): TimelineEntry | undefined {
    const active = timelineEntries[activeClipRef.current]
    const candidates = active ? [active, ...timelineEntries] : timelineEntries
    return candidates.find((entry) => {
      const clip = clips[entry.clipIndex]!
      return time >= clip.sourceStartSec && time < clip.sourceEndSec
    })
  }

  function handleSeeked(): void {
    seekingRef.current = false
    if (!videoRef.current || previewMode !== 'draft') return
    const entry = entryForSourceTime(videoRef.current.currentTime)
    if (entry) {
      activeClipRef.current = entry.clipIndex
      const clip = clips[entry.clipIndex]
      if (clip) videoRef.current.playbackRate = clip.speed
    }
  }

  function handleTimeUpdate(): void {
    if (!videoRef.current) return
    const time = videoRef.current.currentTime
    if (previewMode !== 'draft' || !revision) {
      setLiveSubtitle('')
      return
    }
    const entry = timelineEntries[activeClipRef.current]
    const activeClip = entry ? clips[entry.clipIndex] : undefined
    if (!activeClip || !compiled) {
      setLiveSubtitle('')
      return
    }
    setLiveSubtitle(subtitleAtTime(compiled.subtitles, outputTimeOf(activeClip, time)))
    if (seekingRef.current) return
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

  const currentPreview = renderedPreview?.revisionId === revision?.id ? renderedPreview : null
  const qualityReport = output?.quality ?? storedQuality
  const previewSrc = previewMode === 'output' && output ? output.outputUrl
    : previewMode === 'rendered' && currentPreview ? currentPreview.previewUrl : sourceUrl

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          Pimko
        </div>
        <div className="topbar-actions">
          {revision?.parentRevisionId && (
            <button className="button" onClick={() => void handleUndo()} disabled={stage !== 'ready'}>
              撤销上一步
            </button>
          )}
          {revision && (
            bgm ? (
              <>
                <div className="bgm-volume" role="group" aria-label="配乐音量">
                  {BGM_PRESETS.map((preset) => (
                    <button
                      key={preset.gainDb}
                      className={`button small${Math.abs((bgm.gainDb ?? -18) - preset.gainDb) < 1 ? ' active' : ''}`}
                      onClick={() => void handleBgmVolume(preset.gainDb)}
                      disabled={stage !== 'ready'}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <button className="button" onClick={() => void handleRemoveBgm()} disabled={stage !== 'ready'}>
                  移除配乐
                </button>
              </>
            ) : (
              <button className="button" onClick={() => void handleSetBgm()} disabled={stage !== 'ready'}>
                添加配乐
              </button>
            )
          )}
          {revision && (
            <button className="button" onClick={() => void handleAddBroll()} disabled={stage !== 'ready'}>
              插入 B-roll
            </button>
          )}
          {revision && (
            <button className="button" onClick={() => void handlePreview()} disabled={stage !== 'ready'}>
              {stage === 'previewing' ? '正在生成预览…' : '查看实际效果'}
            </button>
          )}
          {revision && (
            <button
              className="button primary"
              onClick={() => void handleExport()}
              disabled={stage !== 'ready'}
            >
              {stage === 'exporting'
                ? exportProgress
                  ? `导出中 ${exportProgress.current}/${exportProgress.total}`
                  : '正在导出…'
                : '生成成片'}
            </button>
          )}
          <button className="button" onClick={() => void window.pimko.openLogs()}>
            日志
          </button>
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
      {qualityReport && (
        <div className={`quality-bar ${qualityReport.verdict}`} role="status">
          <strong>
            成片检查：{qualityReport.verdict === 'pass' ? '通过' : qualityReport.verdict === 'warn' ? '有警告' : '未通过'}
          </strong>
          <span>
            预期 {qualityReport.expectedSec.toFixed(2)}s / 实际 {qualityReport.actualSec.toFixed(2)}s
          </span>
          {qualityIssues(qualityReport).length > 0 && (
            <span className="quality-issues">{qualityIssues(qualityReport).join('；')}</span>
          )}
        </div>
      )}
      {(stage === 'exporting' || stage === 'previewing') && exportProgress && (
        <div className="export-progress">
          {exportProgress.phase === 'cutting'
            ? `正在裁切片段 ${exportProgress.current}/${exportProgress.total}…`
            : exportProgress.phase === 'concatenating'
              ? '正在拼接片段…'
              : exportProgress.phase === 'verifying'
                ? '正在校验成片…'
                : '正在生成成片…'}
        </div>
      )}

      {stage === 'revising' && <div className="export-progress">正在按你的反馈修改…</div>}
      {stage === 'idle' && !revision ? (
        <main className="empty">
          <div className="empty-copy">
            <h1>把口播视频交给 Pimko</h1>
            <p>导入素材，我先出一版草稿；你看片，用一句话说哪里不对，我改到你能直接发。</p>
            <button className="button primary large" onClick={() => void handleImport()}>
              选择视频
            </button>
          </div>
          {projects.length > 0 && (
            <div className="recent-projects">
              <h2>最近项目</h2>
              <div className="project-list">
                {projects.map((project) => (
                  <button key={project.projectId} className="project-card" onClick={() => void handleRestore(project.projectId)}>
                    <span className="project-name">{project.name}</span>
                    <span className="project-meta">{project.clipCount} 段 · {fmt(project.durationSec)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </main>
      ) : (
        <main className="workspace">
          <section className="stage" aria-label="预览">
            {previewSrc ? (
              <div className="video-wrap">
              <video
                key={previewSrc}
                ref={videoRef}
                src={previewSrc}
                controls
                playsInline
                onLoadedMetadata={() => {
                  seekingRef.current = false
                  if (videoRef.current) videoRef.current.playbackRate = 1
                }}
                onTimeUpdate={handleTimeUpdate}
                onSeeking={() => { seekingRef.current = true }}
                onSeeked={handleSeeked}
              />
                {previewMode === 'draft' && liveSubtitle && subtitlesEnabled && (
                  <div className="subtitle-overlay" style={{
                    fontSize: `${22 * subtitleScale}px`,
                    fontWeight: subtitleAppearance?.style === 'minimal' ? 400 : 700,
                    top: subtitleAppearance?.position === 'top' ? '8%' : subtitleAppearance?.position === 'center' ? '50%' : undefined,
                    bottom: subtitleAppearance?.position === 'top' || subtitleAppearance?.position === 'center' ? 'auto' : undefined,
                    transform: subtitleAppearance?.position === 'center' ? 'translateY(-50%)' : undefined,
                  }}>{liveSubtitle}</div>
                )}
              </div>
            ) : (
              <div className="stage-placeholder">正在准备预览…</div>
            )}
            {(output || currentPreview) && (
              <div className="preview-tabs" role="tablist">
                <button
                  role="tab"
                  aria-selected={previewMode === 'draft'}
                  className={previewMode === 'draft' ? 'active' : ''}
                  onClick={() => setPreviewMode('draft')}
                >
                  草稿预览
                </button>
                {currentPreview && (
                  <button role="tab" aria-selected={previewMode === 'rendered'}
                    className={previewMode === 'rendered' ? 'active' : ''}
                    onClick={() => setPreviewMode('rendered')}>
                    效果预览
                  </button>
                )}
                {output && <button
                  role="tab"
                  aria-selected={previewMode === 'output'}
                  className={previewMode === 'output' ? 'active' : ''}
                  onClick={() => setPreviewMode('output')}
                >
                  成片预览
                </button>}
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
            const fillerCount = fillerHits.filter(
              (hit) => hit.startSec >= clip.sourceStartSec && hit.endSec <= clip.sourceEndSec,
            ).length
            const pauseSec = silences
              .filter((interval) => interval.endSec - interval.startSec >= 0.6)
              .reduce(
                (sum, interval) =>
                  sum + Math.max(0, Math.min(interval.endSec, clip.sourceEndSec) - Math.max(interval.startSec, clip.sourceStartSec)),
                0,
              )
            return (
              <button
                key={`${clip.id}-${index}`}
                className="clip"
                onClick={() => {
                  if (previewMode === 'draft') playFrom(index)
                }}
                disabled={previewMode === 'output'}
                title={`第 ${index + 1} 段 · ${clip.sourceStartSec.toFixed(1)}s – ${clip.sourceEndSec.toFixed(1)}s`}
              >
                <span className="clip-index">{index + 1}</span>
                {thumbnails[index] && (
                  <span className="clip-thumb" style={{ backgroundImage: `url(${thumbnails[index]})` }} aria-hidden />
                )}
                <span className="clip-time">
                  {clip.sourceStartSec.toFixed(1)}–{clip.sourceEndSec.toFixed(1)}s
                </span>
                <span className="clip-length">
                  {clip.speed !== 1
                    ? `${(length / clip.speed).toFixed(1)}s @ ${clip.speed}x`
                    : `${length.toFixed(1)}s`}
                </span>
                {fillerCount > 0 && <span className="clip-flag">口癖×{fillerCount}</span>}
                {pauseSec >= 0.6 && <span className="clip-flag">停顿{pauseSec.toFixed(1)}s</span>}
              </button>
            )
          })}
        </footer>
      )}
    </div>
  )
}
