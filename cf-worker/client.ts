/**
 * Cloudflare Workers 适配版 Edge TTS 客户端
 * 使用原生 WebSocket API（不依赖 Node.js ws 库）
 */

export const CHROMIUM_FULL_VERSION = '144.0.3719.82'
export const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const WINDOWS_FILE_TIME_EPOCH = 11644473600n

// ──────────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────────

function arrayBufferToString(arrayBuffer: ArrayBuffer): string {
    const uint8Array = new Uint8Array(arrayBuffer)
    let result = ''
    for (let i = 0; i < uint8Array.length; i++) {
        result += String.fromCharCode(uint8Array[i])
    }
    return result
}

function concatArrayBuffers(buf1: ArrayBuffer, buf2: ArrayBuffer): ArrayBuffer {
    const tmp = new Uint8Array(buf1.byteLength + buf2.byteLength)
    tmp.set(new Uint8Array(buf1), 0)
    tmp.set(new Uint8Array(buf2), buf1.byteLength)
    return tmp.buffer
}

// ──────────────────────────────────────────────
// 消息头
// ──────────────────────────────────────────────

class MessageHeader {
    requestId: string
    contentType?: string
    path: string
    streamId?: string

    constructor(requestId: string, path: string, contentType?: string, streamId?: string) {
        this.requestId = requestId
        this.contentType = contentType
        this.path = path
        this.streamId = streamId
    }

    static parse(data: string): MessageHeader {
        const requestIdMatch = /X-RequestId:(?<id>[a-z0-9]*)/.exec(data)
        if (!requestIdMatch) throw new Error('RequestId not found:
' + data)
        const contentTypeMatch = /Content-Type:(?<type>.*)/.exec(data)
        const pathMatch = /Path:(?<path>.*)\s/.exec(data)
        if (!pathMatch) throw new Error('Path not found:
' + data)
        const streamIdMatch = /X-StreamId:(?<id>.*)/.exec(data)
        return new MessageHeader(
            requestIdMatch.groups!.id,
            pathMatch.groups!.path,
            contentTypeMatch?.groups?.type,
            streamIdMatch?.groups?.id,
        )
    }

    toString(): string {
        let h = `X-RequestId:${this.requestId}\r
`
        h += `Content-Type:${this.contentType}; charset=UTF-8\r
`
        if (this.streamId) h += `X-StreamId:${this.streamId}\r
`
        h += `Path:${this.path}\r
`
        return h
    }
}

// ──────────────────────────────────────────────
// 配置消息
// ──────────────────────────────────────────────

interface ClientOptions {
    format: string
    sentenceBoundaryEnabled?: boolean
    wordBoundaryEnabled?: boolean
}

function createConfigMessage(options: ClientOptions) {
    return {
        context: {
            synthesis: {
                audio: {
                    metadataoptions: {
                        sentenceBoundaryEnabled: options.sentenceBoundaryEnabled ? 'true' : 'false',
                        wordBoundaryEnabled: options.wordBoundaryEnabled ? 'true' : 'false',
                    },
                    outputFormat: options.format,
                },
            },
        },
    }
}

// ──────────────────────────────────────────────
// 签名 / 请求 ID
// ──────────────────────────────────────────────

function generateRequestId(): string {
    return crypto.randomUUID().replace(/-/g, '')
}

/**
 * 使用 SubtleCrypto（CF Workers 原生支持）生成 HMAC-SHA256 签名
 */
async function generateSecMsGecToken(): Promise<string> {
    const ticks =
        BigInt(Math.floor(Date.now() / 1000)) + WINDOWS_FILE_TIME_EPOCH
    // 向上取整到 5 分钟（3_000_000_000 百纳秒 = 5min * 60s * 1e7）
    const roundedTicks = (ticks / 3_000_000_000n) * 3_000_000_000n
    const strToSign = `${roundedTicks}${TRUSTED_CLIENT_TOKEN}`

    const encoder = new TextEncoder()
    const keyData = encoder.encode(strToSign)
    const key = await crypto.subtle.importKey(
        'raw',
        keyData,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    )
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(strToSign))
    return Array.from(new Uint8Array(sig))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase()
}

// ──────────────────────────────────────────────
// 主客户端
// ──────────────────────────────────────────────

export interface ConvertResult {
    audio: ArrayBuffer
    metadata: any[]
}

export class EdgeTTSClient {
    private constructor() {}

    /** 获取可用语音列表 */
    static async voices(): Promise<any> {
        const url =
            `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`
        const res = await fetch(url)
        if (!res.ok) throw new Error(`获取语音列表失败: ${res.status}`)
        return res.json()
    }

    /** 将 SSML 转换为音频 */
    static async convert(ssml: string, options: ClientOptions): Promise<ConvertResult> {
        const token = await generateSecMsGecToken()
        const requestId = generateRequestId()

        const wsUrl =
            `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` +
            `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
            `&Sec-MS-GEC=${token}` +
            `&Sec-MS-GEC-Version=1-${CHROMIUM_FULL_VERSION}`

        return new Promise<ConvertResult>((resolve, reject) => {
            // Cloudflare Workers 原生 WebSocket
            const ws = new WebSocket(wsUrl)

            let audioBuffer: ArrayBuffer = new ArrayBuffer(0)
            const metadata: any[] = []
            let downloading = false

            // 超时（60 秒）
            const timer = setTimeout(() => {
                try { ws.close() } catch {}
                reject(new Error('请求超时'))
            }, 60_000)

            ws.addEventListener('open', () => {
                // 1. 发送配置
                const configMsg =
                    `X-Timestamp:${new Date().toISOString()}\r
` +
                    'Content-Type:application/json; charset=utf-8\r
' +
                    'Path:speech.config\r
\r
' +
                    JSON.stringify(createConfigMessage(options))
                ws.send(configMsg)

                // 2. 发送 SSML
                const ssmlMsg =
                    `X-Timestamp:${new Date().toISOString()}\r
` +
                    `X-RequestId:${requestId}\r
` +
                    'Content-Type:application/ssml+xml\r
' +
                    'Path:ssml\r
\r
' +
                    ssml
                ws.send(ssmlMsg)
            })

            ws.addEventListener('message', (event: MessageEvent) => {
                const data = event.data

                if (typeof data === 'string') {
                    // 文本消息：元数据或结束信号
                    if (data.includes('Path:turn.start')) {
                        downloading = true
                    } else if (data.includes('Path:turn.end')) {
                        clearTimeout(timer)
                        ws.close()
                        resolve({ audio: audioBuffer, metadata })
                    } else if (data.includes('Path:audio.metadata')) {
                        try {
                            const bodyStart = data.indexOf('\r
\r
')
                            if (bodyStart !== -1) {
                                const body = data.slice(bodyStart + 4)
                                const parsed = JSON.parse(body)
                                if (parsed?.Metadata) {
                                    metadata.push(...parsed.Metadata)
                                }
                            }
                        } catch {}
                    }
                } else {
                    // 二进制消息：音频数据
                    // CF Workers 中 data 为 ArrayBuffer
                    const raw: ArrayBuffer = data instanceof ArrayBuffer
                        ? data
                        : (data as any)

                    // 前两字节是头部长度（big-endian uint16）
                    const view = new DataView(raw)
                    const headerLen = view.getUint16(0)
                    const headerBytes = raw.slice(2, 2 + headerLen)
                    const headerStr = arrayBufferToString(headerBytes)

                    if (headerStr.includes('Path:audio') && downloading) {
                        const audioChunk = raw.slice(2 + headerLen)
                        audioBuffer = concatArrayBuffers(audioBuffer, audioChunk)
                    }
                }
            })

            ws.addEventListener('error', (err: Event) => {
                clearTimeout(timer)
                reject(new Error('WebSocket 错误: ' + (err as any).message))
            })

            ws.addEventListener('close', (event: CloseEvent) => {
                clearTimeout(timer)
                if (audioBuffer.byteLength === 0) {
                    reject(new Error(`WebSocket 意外关闭 (${event.code}): ${event.reason}`))
                }
            })
        })
    }
}
