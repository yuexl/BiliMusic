import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Download, FolderOpen, HardDrive, Loader2, Music, Play, RefreshCw, Trash2, WifiOff } from 'lucide-react'
import { usePlayer } from '@/contexts/PlayerContext'
import {
  loadDownloads,
  removeDownload,
  listDownloadTasks,
  scanDownloadDir,
  DOWNLOADS_CHANGED_EVENT,
  DOWNLOAD_STATE_EVENT,
} from '@/utils/downloads'
import {
  ActionButton,
  EmptyLibrary,
  MusicHero,
  MusicPageShell,
  MusicSection,
  TrackList,
  TrackListRow,
} from '@/components/AppleMusicPage'
import type { DownloadedTrack } from '@/types'

function formatSize(bytes: number): string {
  if (!bytes) return '0 KB'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export default function Downloads() {
  const player = usePlayer()
  const [tracks, setTracks] = useState<DownloadedTrack[]>(() => loadDownloads())
  const [tasks, setTasks] = useState(() => listDownloadTasks())
  const [openError, setOpenError] = useState('')

  useEffect(() => {
    const refresh = () => {
      setTracks(loadDownloads())
      setTasks(listDownloadTasks())
    }
    window.addEventListener(DOWNLOADS_CHANGED_EVENT, refresh)
    window.addEventListener(DOWNLOAD_STATE_EVENT, refresh)
    // 扫描目录里已存在的音频文件（非本软件下载的），合并进列表
    void scanDownloadDir()
    return () => {
      window.removeEventListener(DOWNLOADS_CHANGED_EVENT, refresh)
      window.removeEventListener(DOWNLOAD_STATE_EVENT, refresh)
    }
  }, [])

  const openDownloadDir = async () => {
    setOpenError('')
    const result = await window.electronAPI?.openDownloadDir?.()
    if (result && !result.ok) setOpenError(result.message || '无法打开下载目录')
  }

  const handlePlayAll = useCallback(() => {
    if (tracks.length > 0) player.playAll(tracks)
  }, [tracks, player])

  const totalSize = tracks.reduce((sum, item) => sum + (item.size || 0), 0)
  const downloading = tasks.filter(t => t.status === 'pending')
  const failed = tasks.filter(t => t.status === 'error')
  const subtitle = openError
    || (failed.length ? `下载失败：${failed[0]?.message || '未知错误'}（可在歌曲行重试）` : '')
    || (downloading.length ? `正在下载 ${downloading.length} 首…` : '')
    || (tracks.length ? `已下载 ${tracks.length} 首，离线也能继续听。` : '离线音乐会整齐地收在这里，像 Apple Music 资料库一样干净。')

  return (
    <MusicPageShell>
      <MusicHero
        eyebrow="Downloads"
        title="本地下载"
        subtitle={subtitle}
        tone="blue"
        action={(
          <div className="download-hero-actions">
            {tracks.length > 0 && (
              <ActionButton onClick={handlePlayAll}>
                <Play size={17} fill="currentColor" />
                播放全部
              </ActionButton>
            )}
            <ActionButton tone="subtle" onClick={openDownloadDir}>
              <FolderOpen size={16} />
              打开目录
            </ActionButton>
            <ActionButton tone="subtle" onClick={() => void scanDownloadDir()}>
              <RefreshCw size={16} />
              刷新
            </ActionButton>
          </div>
        )}
      />

      <div className="download-dashboard">
        <DownloadMetric icon={<Download size={19} />} label="已下载" value={`${tracks.length} 首`} />
        <DownloadMetric icon={<HardDrive size={19} />} label="占用空间" value={formatSize(totalSize)} />
        <DownloadMetric icon={<WifiOff size={19} />} label="离线可听" value={tracks.length ? '已就绪' : '未开始'} />
      </div>

      {downloading.length > 0 && (
        <div className="download-pending">
          <Loader2 size={16} className="spin" />
          正在下载 {downloading.length} 首，完成后会自动出现在这里。
        </div>
      )}

      <MusicSection title="下载列表" icon={<Music size={22} />}>
        {tracks.length === 0 ? (
          <div className="download-empty-shell">
            <EmptyLibrary
              icon={<Download size={40} />}
              title="还没有本地音乐"
              subtitle="在任意歌曲列表点击下载按钮，歌曲会出现在这里。"
            />
          </div>
        ) : (
          <TrackList>
            {tracks.map((track, index) => (
              <TrackListRow
                key={track.id}
                track={track}
                index={index + 1}
                isCurrent={player.currentTrack?.id === track.id}
                isPlaying={player.isPlaying}
                onPlay={() => player.playNow(track)}
                extra={(
                  <div className="am-extra-actions">
                    <span className="download-size">{formatSize(track.size)}</span>
                    <button
                      className="am-icon-danger"
                      onClick={(e) => { e.stopPropagation(); void removeDownload(track.id) }}
                      title="删除下载"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                )}
              />
            ))}
          </TrackList>
        )}
      </MusicSection>
    </MusicPageShell>
  )
}

function DownloadMetric({
  icon,
  label,
  value,
}: {
  icon: ReactNode
  label: string
  value: string
}) {
  return (
    <article className="download-metric">
      <span>{icon}</span>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
      </div>
    </article>
  )
}
