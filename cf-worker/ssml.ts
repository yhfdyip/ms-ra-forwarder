/**
 * Cloudflare Workers 适配版 SSML 构建器
 * 不依赖 fast-xml-parser，使用模板字符串直接生成 XML
 */

export class SSML {
    private text: string
    private voiceName: string
    private volume: number
    private rate: number
    private pitch: number

    constructor(
        text: string,
        voiceName: string = 'zh-CN-XiaoxiaoNeural',
        volume: number = 100,
        rate: number = 0,
        pitch: number = 0,
    ) {
        this.text = text
        this.voiceName = voiceName
        this.volume = volume
        this.rate = rate
        this.pitch = pitch
    }

    /** 对 XML 特殊字符进行转义 */
    private escape(str: string): string {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;')
    }

    toString(): string {
        return [
            `<speak xmlns="http://www.w3.org/2001/10/synthesis"`,
            ` xmlns:mstts="http://www.w3.org/2001/mstts"`,
            ` xmlns:emo="http://www.w3.org/2009/10/emotionml"`,
            ` version="1.0" xml:lang="en-US">`,
            `<voice name="${this.escape(this.voiceName)}">`,
            `<prosody volume="${this.volume}%" rate="${this.rate}%" pitch="${this.pitch}%">`,
            this.escape(this.text),
            `</prosody>`,
            `</voice>`,
            `</speak>`,
        ].join('')
    }
}
