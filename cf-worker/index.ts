/**
 * Cloudflare Workers 入口
 * 实现与原 Next.js 路由完全兼容的 API：
 *   GET /api/text-to-speech
 *   GET /api/legado-import
 *   GET /  (简单说明页)
 */

import { EdgeTTSClient } from './client'
import { SSML } from './ssml'

// ──────────────────────────────────────────────
// 环境变量类型声明
// ──────────────────────────────────────────────
export interface Env {
    /** 访问令牌，不设置则不验证 */
    TOKEN?: string
    /** 同 TOKEN，两者取其一 */
    MS_RA_FORWARDER_TOKEN?: string
}

// ──────────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
}

function parseNumberParam(
    params: URLSearchParams,
    name: string,
    defaultValue: number,
    min: number,
    max: number,
): number {
    const raw = params.get(name)
    if (raw === null || raw === undefined) return defaultValue
    const num = Number(raw)
    if (Number.isNaN(num) || num < min || num > max) {
        throw new Error(`Invalid ${name} value: ${raw}`)
    }
    return num
}

function checkToken(request: Request, env: Env): Response | null {
    const requiredToken = env.MS_RA_FORWARDER_TOKEN || env.TOKEN
    if (!requiredToken) return null          // 未设置 token，直接放行
    const auth = request.headers.get('authorization')
    if (auth !== `Bearer ${requiredToken}`) {
        return new Response('Unauthorized', { status: 401 })
    }
    return null
}

// ──────────────────────────────────────────────
// 路由处理
// ──────────────────────────────────────────────

async function handleTTS(request: Request, env: Env): Promise<Response> {
    const authErr = checkToken(request, env)
    if (authErr) return authErr

    const { searchParams } = new URL(request.url)

    const text = searchParams.get('text') ?? ''
    if (!text) return json({ error: 'Text is required' }, 400)

    const voice = searchParams.get('voice') ?? ''
    if (!voice) return json({ error: 'Voice is required' }, 400)

    const pitch  = parseNumberParam(searchParams, 'pitch',  0,   -100, 100)
    const rate   = parseNumberParam(searchParams, 'rate',   0,   -100, 100)
    const volume = parseNumberParam(searchParams, 'volume', 100, -100, 100)

    const ssml = new SSML(text, voice, volume, rate, pitch)
    const result = await EdgeTTSClient.convert(ssml.toString(), {
        format: 'audio-24khz-96kbitrate-mono-mp3',
        sentenceBoundaryEnabled: false,
        wordBoundaryEnabled: false,
    })

    return new Response(result.audio, {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' },
    })
}

async function handleLegadoImport(request: Request, env: Env): Promise<Response> {
    // legado 导入接口用 query token 验证
    const requiredToken = env.MS_RA_FORWARDER_TOKEN || env.TOKEN
    const { searchParams } = new URL(request.url)

    if (requiredToken) {
        const token = searchParams.get('token')
        if (!token || token !== requiredToken) {
            return new Response('Unauthorized', { status: 401 })
        }
    }

    const voice = searchParams.get('voice') ?? ''
    if (!voice) return json({ error: 'Voice is required' }, 400)

    const parseNP = (name: string, def: number, min: number, max: number) =>
        parseNumberParam(searchParams, name, def, min, max)

    const pitch     = parseNP('pitch',  0,   -100, 100)
    const volume    = parseNP('volume', 100, -100, 100)
    const personality = searchParams.get('personality') ?? undefined

    const options: Record<string, any> = { voice, volume, pitch }
    if (personality) options.personality = personality

    let queryString = Object.entries(options)
        .map(([k, v]) => `${k}=${v}`)
        .join('&')
    queryString += `&rate={{(speakSpeed - 10) * 2}}`

    const protocol = searchParams.get('protocol') || 'https'
    const host     = request.headers.get('host')
    const baseUrl  = `${protocol}://${host}/api/text-to-speech`
    const apiUrl   = `${baseUrl}?${queryString}&text={{java.encodeURI(speakText)}}`

    const header = requiredToken
        ? { Authorization: `Bearer ${requiredToken}` }
        : {}

    return json({
        name: voice,
        contentType: 'audio/mpeg',
        id: Date.now(),
        loginCheckJs: '',
        loginUi: '',
        loginUrl: '',
        url: apiUrl,
        header: JSON.stringify(header),
    })
}

function handleIndex(): Response {
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MS RA Forwarder – Cloudflare Workers</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 4rem auto; padding: 0 1rem; }
    code { background: #f4f4f4; padding: 2px 6px; border-radius: 4px; font-size: .9em; }
    pre  { background: #f4f4f4; padding: 1rem; border-radius: 8px; overflow-x: auto; }
    a    { color: #0070f3; }
  </style>
</head>
<body>
  <h1>MS RA Forwarder</h1>
  <p>基于 <strong>Cloudflare Workers</strong> 部署的微软 Edge TTS 转发服务。</p>

  <h2>接口</h2>
  <h3>文字转语音</h3>
  <pre>GET /api/text-to-speech
    ?voice=zh-CN-XiaoxiaoNeural
    &amp;text=你好世界
    &amp;volume=0&amp;rate=0&amp;pitch=0</pre>

  <h3>导入到阅读（legado）</h3>
  <pre>GET /api/legado-import
    ?voice=zh-CN-XiaoxiaoNeural
    &amp;token=&lt;TOKEN&gt;</pre>

  <h2>限制访问</h2>
  <p>在 Cloudflare Workers 环境变量中设置 <code>TOKEN</code>，
     请求时在 Header 中加入 <code>Authorization: Bearer &lt;TOKEN&gt;</code>。</p>

  <p><a href="https://github.com/yhfdyip/ms-ra-forwarder" target="_blank">GitHub 源码</a></p>
</body>
</html>`
    return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
}

// ──────────────────────────────────────────────
// Worker 入口
// ──────────────────────────────────────────────

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url)
        const path = url.pathname

        try {
            if (path === '/api/text-to-speech') {
                return await handleTTS(request, env)
            }
            if (path === '/api/legado-import') {
                return await handleLegadoImport(request, env)
            }
            if (path === '/' || path === '') {
                return handleIndex()
            }
            return new Response('Not Found', { status: 404 })
        } catch (err) {
            console.error('Worker error:', err)
            return json({ error: (err as Error).message }, 500)
        }
    },
}
