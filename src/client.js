const FormData = require('form-data')
const fs = require('fs')
const fetch = require('node-fetch')
const parseLinks = require('parse-link-header')
const Emitter = require('./emitter')

function progressBar (state) {
    if (state == null) {
        return 'page: ?'
    }
    if (state.error) {
        return state.error
    }

    if (!state.last || !state.last.page) {
        return `page: ${state.current.page}`
    }

    const current = state.current.page
    const last = state.last.page
    const SIZE = 50
    const progress = SIZE * current / last
    const bar = ('='.repeat(progress) + ' '.repeat(SIZE - progress)).replace(/= /, '> ')

    return `[${bar}] ${current}/${last}`
}

const MIME_TYPES = {
    ndjson: 'application/x-ndjson',
    csv: 'text/csv',
    tsv: 'text/tab-separated-values',
    ntriples: 'application/n-triples',
    bibtex: 'application/x-bibtex',
    atf: 'text/x-c-atf'
}

module.exports.Client = class Client extends Emitter {
    constructor (base) {
        super()

        this.base = base
        this._cookies = {}
        this._pageStates = {}
    }

    async * _fetchPages (path, format, startPage, cookie, label = path) {
        const mimeType = MIME_TYPES[format]
        if (!mimeType) {
            throw new TypeError(`Format "${format}" unknown`)
        }

        const skipHeader = format === 'csv' || format === 'tsv'

        let next = this.base + path
        if (startPage > 1) {
            next = next + '?page=' + startPage
        }
        while (next) {
            let response
            if (!cookie) {
                response = await fetch(next, {
                    headers: { Accept: mimeType, ...this._getCookieHeaders() }
                })
            } else {
                response = await fetch(next, {
                    headers: {
                        accept: mimeType,
                        cookie: 'csrfToken=' + cookie + '; PHPSESSID=7q5tc1045cj2hrb056t9gtohsc'
                    }
                })
            }

            this._setCookies(response)

            if (response.status >= 400) {
                if (response.status === 504) {
                    console.error('Timeout!')
                    continue
                }
                const error = `'${label}' returned code ${response.status}`
                this._pageStates[label] = { error }
                throw new Error(error)
            }

            const responseType = response.headers.get('content-type').split(';')[0]
            if (responseType !== mimeType) {
                const error = `'${label}' did not return '${format}' but '${responseType}'`
                this._pageStates[label] = { error }
                throw new Error(error)
            }

            const links = parseLinks(response.headers.get('Link'))
            next = links && links.next && links.next.url
            this._pageStates[label] = links

            if (skipHeader && links && links.prev) {
                const text = await response.text()
                yield text.slice(text.indexOf('\n') + 1)
                continue
            }

            yield response.text()
        }
    }

    _log (...args) {
        this.trigger('log', args.join(' ') + '\n')
    }

    _setupPageStates (entities) {
        this._pageStates = {}
        this._log(entities.join('\n'))
    }

    _logPageStates () {
        const states = Object.entries(this._pageStates)
        this._log(`\u001b[${states.length}A` + states
            .map(([name, state]) => name.padEnd(30, ' ') + ': ' + progressBar(state))
            .join('\n')
        )
    }

    _getCookieHeaders () {
        return {
            'X-CSRF-Token': this._cookies.csrfToken,
            Cookie: Object.entries(this._cookies).map(pair => pair.join('=')).join('; ')
        }
    }

    _setCookies (response) {
        const header = response.headers.raw()['set-cookie']

        if (!header) {
            return
        }

        for (const cookie of header) {
            const [key, ...value] = cookie.split(';')[0].split('=')
            this._cookies[key] = value.join('=')
        }
    }

    async login (username, password, token) {
        if (!this._cookies.csrfToken) {
            this._setCookies(await fetch(this.base + 'login'))
        }

        const loginBody = new FormData()
        loginBody.append('username', username)
        loginBody.append('password', password)

        const loginResponse = await fetch(this.base + 'login', {
            method: 'POST',
            body: loginBody,
            headers: this._getCookieHeaders()
        })
        this._setCookies(loginResponse)

        if (loginResponse.status >= 400) {
            throw new Error('Login failed')
        }

        const tokenBody = new FormData()
        tokenBody.append('code', token || 'random_code_value')

        const tokenResponse = await fetch(loginResponse.url, {
            method: 'POST',
            body: tokenBody,
            headers: this._getCookieHeaders(),
            redirect: 'manual'
        })
        this._setCookies(tokenResponse)

        if (tokenResponse.status >= 400) {
            throw new Error('2FA failed')
        }
    }

    async export (format = 'ntriples', entities = [], fileName, startPage = 1, cookie) {
        let fileIndex = 1;
        let file = fileName
            ? fs.createWriteStream(fileName)
            : process.stdout

        this._setupPageStates(entities)

        return Promise.allSettled(entities.map(async entity => {
            if (file.bytesWritten > 90000000 && fileName) {
                const fileNameSplit = fileName.split('.');
                file = fs.createWriteStream(fileNameSplit[0] + "-" + fileIndex + "." + fileNameSplit[1])
                fileIndex++
            }
            
            const pages = this._fetchPages(entity, format, startPage, cookie)

            for await (const page of pages) {
                this._logPageStates()
                file.write(page)
            }
        }))
    }

    async search (format = 'ntriples', query, fileName, startPage = 1) {
        const file = fileName
            ? fs.createWriteStream(fileName)
            : process.stdout

        const label = 'search'
        this._setupPageStates([label])

        const pages = this._fetchPages('search?' + query, format, label, startPage)

        for await (const page of pages) {
            this._logPageStates()
            file.write(page)
        }
    }
}
