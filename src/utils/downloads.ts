import type { DownloadedTrack, Track } from '@/types'
import { readStoredItem, writeStoredItem } from '@/utils/persistentStorage'
import { extractAudio, downloadAudio } from '@/services/api'

const DOWNLOADS_KEY = 'bilimusic_downloads'
export const DOWNLOADS_CHANGED_EVENT = 'bilimusic:downloads-changed'
export const DOWNLOAD_STATE_EVENT = 'bilimusic:download-state'

export interface DownloadTask {
  id: string
  status: 'pending' | 'error'
  message?: string
}

// 目录里已存在的音频文件（非本软件下载）：只做运行时合并，不写入持久化记录，
// 这样删除后重新扫描自然消失，也不会污染「已下载」记录。
let scannedFiles: DownloadedTrack[] = []

function loadRecords(): DownloadedTrack[] {
  try {
    const raw = readStoredItem(DOWNLOADS_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveRecords(items: DownloadedTrack[]): void {
  try {
    writeStoredItem(DOWNLOADS_KEY, JSON.stringify(items))
  } catch {
    // 持久化失败不阻塞界面状态更新
  }
  window.dispatchEvent(new CustomEvent(DOWNLOADS_CHANGED_EVENT))
}

// 合并视图：本软件下载的记录 + 目录里已存在的音频文件（按路径去重，记录优先）
export function loadDownloads(): DownloadedTrack[] {
  const records = loadRecords()
  const seen = new Set(records.map(item => item.filePath))
  return [...records, ...scannedFiles.filter(item => !seen.has(item.filePath))]
}

export function getDownloadedTrack(id: string): DownloadedTrack | undefined {
  return loadDownloads().find(item => item.id === id)
}

export function isTrackDownloaded(id: string): boolean {
  return Boolean(getDownloadedTrack(id))
}

// ===== 下载状态（模块级，跨页面共享）=====

const tasks = new Map<string, DownloadTask>()

export function getDownloadTask(id: string): DownloadTask | undefined {
  return tasks.get(id)
}

export function listDownloadTasks(): DownloadTask[] {
  return [...tasks.values()]
}

function notifyState(): void {
  window.dispatchEvent(new CustomEvent(DOWNLOAD_STATE_EVENT))
}

function mimeToExt(mime?: string): string {
  if (!mime) return 'm4a'
  if (mime.includes('flac')) return 'flac'
  if (mime.includes('mpeg')) return 'mp3'
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('wav')) return 'wav'
  return 'm4a'
}

function safeFileName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'track'
}

/**
 * 下载一首曲目：提取音频源 → 主进程写文件 → 记入本地资料库。
 * 已下载或正在下载的曲目会被忽略，避免重复任务。
 */
export async function downloadTrack(track: Track): Promise<void> {
  if (isTrackDownloaded(track.id) || tasks.get(track.id)?.status === 'pending') return
  tasks.set(track.id, { id: track.id, status: 'pending' })
  notifyState()
  try {
    const fallback = track.aid && track.cid ? { aid: track.aid, cid: track.cid } : undefined
    const source = await extractAudio(track.bvid || track.id, fallback)
    const filename = `${safeFileName(track.id)}.${mimeToExt(source.audioMimeType)}`
    const result = await downloadAudio(source.audioUrl, filename)

    const record: DownloadedTrack = {
      ...track,
      title: source.title || track.title,
      artist: source.artist || track.artist,
      coverUrl: source.coverUrl || track.coverUrl,
      duration: source.duration || track.duration,
      filePath: result.filePath,
      size: result.size,
      downloadedAt: new Date().toISOString(),
    }
    saveRecords([record, ...loadRecords().filter(item => item.id !== record.id)])
    tasks.delete(track.id)
  } catch (err) {
    tasks.set(track.id, {
      id: track.id,
      status: 'error',
      message: err instanceof Error ? err.message : String(err),
    })
  }
  notifyState()
}

/** 删除下载记录及对应物理文件；文件清理失败时仍移除记录，避免条目卡住。 */
export async function removeDownload(id: string): Promise<void> {
  const target = loadDownloads().find(item => item.id === id)
  if (target) {
    try {
      await window.electronAPI?.deleteDownloadedFile?.(target.filePath)
    } catch {
      // 物理文件清理失败不阻塞记录移除
    }
  }
  scannedFiles = scannedFiles.filter(item => item.id !== id)
  saveRecords(loadRecords().filter(item => item.id !== id))
}

// 从文件名推断展示信息："歌手 - 歌名.mp3" 这类常见命名
function parseFileName(name: string): { title: string; artist: string } {
  const base = name.replace(/\.[^.]+$/, '').trim()
  const parts = base.split(/\s+-\s+/)
  if (parts.length >= 2) {
    return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() }
  }
  return { title: base || name, artist: '本地文件' }
}

// 用浏览器自带的解码器探测本地文件时长（外部文件没有 B 站元数据）。
// 按路径缓存，避免每次扫描重复解码。
const durationCache = new Map<string, number>()

function probeDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    const cached = durationCache.get(filePath)
    if (cached !== undefined) {
      resolve(cached)
      return
    }
    let settled = false
    const audio = new Audio()
    const finish = (value: number) => {
      if (settled) return
      settled = true
      if (value > 0) durationCache.set(filePath, value)
      audio.removeAttribute('src')
      resolve(value)
    }
    audio.preload = 'metadata'
    const accept = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) finish(audio.duration)
    }
    audio.onloadedmetadata = accept
    audio.ondurationchange = accept
    audio.onerror = () => finish(0)
    setTimeout(() => finish(0), 2500) // 元数据始终拿不到时不要挂住
    audio.src = `app://local/__download__/${encodeURIComponent(filePath)}`
  })
}

/** 扫描下载目录里已存在的音频文件，合并进下载列表（不写入持久化记录） */
export async function scanDownloadDir(): Promise<void> {
  const files = (await window.electronAPI?.scanDownloadDir?.()) ?? []
  scannedFiles = files.map((file): DownloadedTrack => {
    const { title, artist } = parseFileName(file.name)
    return {
      id: `local:${file.path}`,
      title,
      artist,
      coverUrl: '',
      duration: durationCache.get(file.path) ?? 0,
      videoUrl: '',
      bvid: '',
      playCount: 0,
      isLiked: false,
      filePath: file.path,
      size: file.size,
      downloadedAt: '',
    }
  })
  window.dispatchEvent(new CustomEvent(DOWNLOADS_CHANGED_EVENT))

  // 分批补时长，避免同时发起大量本地媒体请求
  for (let i = 0; i < scannedFiles.length; i += 4) {
    const batch = scannedFiles.slice(i, i + 4).filter(item => item.duration <= 0)
    if (!batch.length) continue
    const durations = await Promise.all(batch.map(item => probeDuration(item.filePath)))
    batch.forEach((item, idx) => { item.duration = durations[idx] })
    window.dispatchEvent(new CustomEvent(DOWNLOADS_CHANGED_EVENT))
  }
}
