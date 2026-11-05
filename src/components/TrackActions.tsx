import { useEffect, useState } from 'react'
import { ListStart, Plus, Check, Download, Loader2, AlertCircle } from 'lucide-react'
import { usePlayer } from '@/contexts/PlayerContext'
import AddToPlaylistButton from '@/components/AddToPlaylistButton'
import {
  downloadTrack,
  getDownloadTask,
  isTrackDownloaded,
  DOWNLOADS_CHANGED_EVENT,
  DOWNLOAD_STATE_EVENT,
} from '@/utils/downloads'
import type { Track } from '@/types'

function useDownloadState(id: string) {
  const [state, setState] = useState(() => ({
    downloaded: isTrackDownloaded(id),
    task: getDownloadTask(id),
  }))

  useEffect(() => {
    const sync = () => setState({ downloaded: isTrackDownloaded(id), task: getDownloadTask(id) })
    sync()
    window.addEventListener(DOWNLOADS_CHANGED_EVENT, sync)
    window.addEventListener(DOWNLOAD_STATE_EVENT, sync)
    return () => {
      window.removeEventListener(DOWNLOADS_CHANGED_EVENT, sync)
      window.removeEventListener(DOWNLOAD_STATE_EVENT, sync)
    }
  }, [id])

  return state
}

/**
 * 歌曲行内操作：下一首播放 / 加入播放列表 / 加入歌单 / 下载到本地
 *
 * 点击歌曲本身 = 立即播放（playNow）；这些按钮才执行队列追加/插入等逻辑。
 * 外层 stopPropagation，避免触发所在行/卡片的点击播放。
 */
export default function TrackActions({ track, size = 16 }: { track: Track; size?: number }) {
  const player = usePlayer()
  const queued = player.queue.some(t => t.id === track.id)
  const { downloaded, task } = useDownloadState(track.id)
  const pending = task?.status === 'pending'
  const failed = task?.status === 'error'

  return (
    <div
      style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}
      onClick={(e) => e.stopPropagation()}
    >
      <ActionButton
        title="下一首播放"
        onClick={() => player.playNext(track)}
        icon={<ListStart size={size} />}
      />
      <ActionButton
        title={queued ? '已在播放列表' : '加入播放列表'}
        onClick={() => player.addToQueue(track)}
        icon={queued ? <Check size={size} /> : <Plus size={size} />}
        color={queued ? 'var(--color-muted)' : undefined}
      />
      <AddToPlaylistButton track={track} size={size} />
      <ActionButton
        title={
          pending ? '正在下载…'
            : downloaded ? '已下载到本地'
              : failed ? `下载失败：${task?.message || '未知错误'}（点击重试）`
                : '下载到本地'
        }
        onClick={() => { if (!pending && !downloaded) void downloadTrack(track) }}
        icon={
          pending ? <Loader2 size={size} className="spin" />
            : downloaded ? <Check size={size} />
              : failed ? <AlertCircle size={size} />
                : <Download size={size} />
        }
        color={downloaded ? 'var(--color-muted)' : failed ? '#ff6961' : undefined}
      />
    </div>
  )
}

function ActionButton({ title, onClick, icon, color }: {
  title: string
  onClick: () => void
  icon: React.ReactNode
  color?: string
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="track-action-button"
      style={{ color: color || undefined }}
    >
      {icon}
    </button>
  )
}
