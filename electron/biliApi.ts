import { ipcMain, net, app, session } from 'electron'
import path from 'path'
import fs from 'fs/promises'
import fsSync from 'fs'

const BILI_API = 'https://api.bilibili.com'
const BILI_PASSPORT = 'https://passport.bilibili.com'
const BILI_REFERER = 'https://www.bilibili.com'

// ===== IPC Handlers =====

// 下载目录由主进程持久化到 userData，避免仅依赖渲染层 localStorage（重启/换源可能丢失）。
// 设置页与打开目录、下载写入都以此处为权威来源。
function downloadDirConfigFile(): string {
  return path.join(app.getPath('userData'), 'download-dir.json')
}

export function getDownloadDir(): string {
  try {
    const raw = JSON.parse(fsSync.readFileSync(downloadDirConfigFile(), 'utf8')) as { downloadDir?: unknown }
    if (typeof raw.downloadDir === 'string' && path.isAbsolute(raw.downloadDir)) return raw.downloadDir
  } catch {
    // 首次运行或配置损坏，回退到默认目录
  }
  return path.join(app.getPath('userData'), 'downloads')
}

// 传空值表示恢复默认；返回最终生效的目录
export function setDownloadDir(dir: string): string {
  const normalized = String(dir || '').trim()
  if (!normalized || !path.isAbsolute(normalized)) {
    try {
      fsSync.rmSync(downloadDirConfigFile(), { force: true })
    } catch {
      // ignore
    }
  } else {
    fsSync.mkdirSync(normalized, { recursive: true })
    fsSync.writeFileSync(downloadDirConfigFile(), JSON.stringify({ downloadDir: normalized }, null, 2))
  }
  return getDownloadDir()
}

// 统一解析实际下载目录：显式传入的绝对路径优先，否则用主进程持久化的配置。
// 下载写入与「打开目录」共用此函数，保证两者始终指向同一目录。
export function resolveDownloadDir(preferred?: string): string {
  if (preferred && path.isAbsolute(preferred)) return preferred
  return getDownloadDir()
}

export function registerBiliApiHandlers() {
  // 搜索视频
  ipcMain.handle('bili:search', async (_event, keyword: string, page = 1, pageSize = 20) => {
    return fetchBiliApi(`/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(keyword)}&page=${page}&pagesize=${pageSize}`)
  })

  // 视频详情
  ipcMain.handle('bili:videoDetail', async (_event, bvid: string) => {
    return fetchBiliApi(`/x/web-interface/view?bvid=${bvid}`)
  })

  // 音频流地址
  ipcMain.handle('bili:playUrl', async (_event, bvid: string, cid: number) => {
    return fetchBiliApi(`/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=0&fnver=0&fnval=16&fourk=1`)
  })

  // 用户信息（登录状态）
  ipcMain.handle('bili:nav', async () => {
    return fetchBiliApi('/x/web-interface/nav')
  })

  // 热门视频
  ipcMain.handle('bili:popular', async (_event, ps = 10, pn = 1) => {
    return fetchBiliApi(`/x/web-interface/popular?ps=${ps}&pn=${pn}`)
  })

  // 推荐视频
  ipcMain.handle('bili:recommend', async (_event, ps = 10) => {
    return fetchBiliApi(`/x/web-interface/index/top/rcmd?ps=${ps}`)
  })

  // 音乐排行榜
  ipcMain.handle('bili:musicRanking', async () => {
    return fetchBiliApi('/x/web-interface/ranking/region?rid=3&day=3')
  })

  // 收藏夹列表
  ipcMain.handle('bili:favorites', async (_event, mid: number) => {
    return fetchBiliApi(`/x/v3/fav/folder/created/list-all?up_mid=${mid}`)
  })

  // 下载音频文件到本地
  ipcMain.handle('bili:downloadAudio', async (_event, audioUrl: string, filename: string, downloadDir?: string) => {
    const dir = resolveDownloadDir(downloadDir)
    await fs.mkdir(dir, { recursive: true })
    const filePath = path.join(dir, path.basename(filename) || 'audio.m4a')

    const response = await net.fetch(audioUrl, {
      headers: { Referer: BILI_REFERER },
    })

    if (!response.ok) throw new Error(`Download failed: ${response.status}`)

    const buffer = Buffer.from(await response.arrayBuffer())
    await fs.writeFile(filePath, buffer)

    return { filePath, size: buffer.length }
  })

  // 提取完整音频源（一键流程）
  ipcMain.handle('bili:extractAudio', async (_event, bvid: string) => {
    const detail = await fetchBiliApi(`/x/web-interface/view?bvid=${bvid}`)
    const playData = await fetchBiliApi(`/x/player/playurl?bvid=${bvid}&cid=${detail.cid}&qn=0&fnver=0&fnval=16&fourk=1`)

    const audioStreams = playData.dash?.audio || []
    if (!audioStreams.length) throw new Error('No audio stream available')

    const bestAudio = [...audioStreams].sort((a, b) => b.bandwidth - a.bandwidth)[0]

    return {
      bvid: detail.bvid,
      aid: detail.aid,
      cid: detail.cid,
      title: detail.title,
      artist: detail.owner?.name,
      coverUrl: detail.pic,
      duration: detail.duration,
      audioUrl: bestAudio.baseUrl,
      audioQuality: bestAudio.quality,
      audioMimeType: bestAudio.mimeType,
      bandwidth: bestAudio.bandwidth,
    }
  })

  // ===== 扫码登录 =====

  // 生成二维码
  ipcMain.handle('bili:qrGenerate', async () => {
    const url = `${BILI_PASSPORT}/x/passport-login/web/qrcode/generate`
    const response = await net.fetch(url, {
      headers: { Referer: `${BILI_PASSPORT}/login` },
    })
    const data = await response.json()

    if (data.code !== 0) {
      throw { code: data.code, message: data.message }
    }

    return {
      url: data.data.url,
      qrcodeKey: data.data.qrcode_key,
    }
  })

  // 轮询二维码状态
  ipcMain.handle('bili:qrPoll', async (_event, qrcodeKey: string) => {
    const url = `${BILI_PASSPORT}/x/passport-login/web/qrcode/poll?qrcode_key=${qrcodeKey}`
    const response = await net.fetch(url, {
      headers: { Referer: `${BILI_PASSPORT}/login` },
      redirect: 'manual',
    })

    const httpStatus = response.status
    const setCookieHeaders = response.headers.getSetCookie?.() || []
    const isRedirect = httpStatus === 302 || httpStatus === 301

    if (isRedirect && setCookieHeaders.length > 0) {
      for (const cookieStr of setCookieHeaders) {
        try {
          await session.defaultSession.cookies.set({
            url: BILI_API,
            name: parseCookieName(cookieStr),
            value: parseCookieValue(cookieStr),
            domain: '.bilibili.com',
            path: '/',
            secure: true,
            httpOnly: true,
          })
        } catch {
        }
      }
      return {
        code: 0,
        status: 0,
        message: '登录成功',
        url: response.headers.get('Location') || '',
      }
    }

    const text = await response.text()
    let data: any
    try {
      data = JSON.parse(text)
    } catch {
      return { code: -1, status: -1, message: 'unknown', url: '' }
    }

    // B站 poll 响应：外层 code 表示 API 调用结果，
    // 内层 data.code 才是扫码状态（86101=未扫码, 86090=已扫码, 0=成功）
    return {
      code: data.data?.code ?? data.code,
      status: data.data?.code ?? data.code,
      message: data.data?.message || data.message,
      url: data.data?.url || '',
    }
  })

  // 获取当前 Cookie 中的登录状态
  ipcMain.handle('bili:getCookies', async () => {
    const cookies = await session.defaultSession.cookies.get({ domain: '.bilibili.com' })
    const sessdata = cookies.find(c => c.name === 'SESSDATA')
    const biliJct = cookies.find(c => c.name === 'bili_jct')
    const dedeUserId = cookies.find(c => c.name === 'DedeUserID')

    return {
      isLoggedIn: !!(sessdata && biliJct && dedeUserId),
      sessdata: sessdata?.value || '',
      biliJct: biliJct?.value || '',
      dedeUserId: dedeUserId?.value || '',
    }
  })

  // 退出登录（清除 Cookie）
  ipcMain.handle('bili:logout', async () => {
    await session.defaultSession.cookies.remove(BILI_API, 'SESSDATA')
    await session.defaultSession.cookies.remove(BILI_API, 'bili_jct')
    await session.defaultSession.cookies.remove(BILI_API, 'DedeUserID')
    await session.defaultSession.cookies.remove(BILI_API, 'DedeUserID__ckMd5')
    return { success: true }
  })
}

// ===== BiliBili API Fetch Helper =====

async function fetchBiliApi(urlPath: string): Promise<any> {
  const url = `${BILI_API}${urlPath}`
  // 从 session 中获取 Cookie，确保 API 请求携带登录态
  const cookies = await session.defaultSession.cookies.get({ url: BILI_API })
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ')

  const headers: Record<string, string> = {
    Referer: BILI_REFERER,
    Origin: 'https://www.bilibili.com',
  }
  if (cookieHeader) {
    headers['Cookie'] = cookieHeader
  }

  const response = await net.fetch(url, { headers })
  const data = await response.json()

  if (data.code !== 0) {
    throw { code: data.code, message: data.message, path: urlPath }
  }

  return data.data
}

// ===== Cookie 解析辅助 =====

function parseCookieName(setCookie: string): string {
  const pair = setCookie.split(';')[0]
  return pair.split('=')[0].trim()
}

function parseCookieValue(setCookie: string): string {
  const pair = setCookie.split(';')[0]
  return pair.split('=').slice(1).join('=').trim()
}