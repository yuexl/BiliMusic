// 主进程持久化为所有本地状态的权威来源（userData/renderer-persistent-store.json），
// localStorage 只作快速镜像。Electron 的 localStorage 可能被清理或换源导致设置/资料库丢失，
// 因此所有平台都走 IPC，而不是仅限鸿蒙。
function getPersistentApi() {
  return window.electronAPI?.persistentStorage ?? null
}

export function readStoredItem(key: string): string | null {
  const persistent = getPersistentApi()
  if (persistent) {
    const value = persistent.getItem(key)
    if (value !== null) {
      try {
        localStorage.setItem(key, value) // 回灌镜像
      } catch {
        // localStorage 不可用时忽略，主进程存储仍是权威来源
      }
      return value
    }
  }

  try {
    // 主进程尚无此 key（首次启动或老版本升级）：把 localStorage 里的旧值迁移过去
    const value = localStorage.getItem(key)
    if (value !== null) {
      persistent?.setItem(key, value)
    }
    return value
  } catch {
    return null
  }
}

export function writeStoredItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // localStorage 写入失败时，主进程副本仍是权威来源
  }
  getPersistentApi()?.setItem(key, value)
}

export function removeStoredItem(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
  getPersistentApi()?.removeItem(key)
}
