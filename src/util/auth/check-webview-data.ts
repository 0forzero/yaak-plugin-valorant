import type {Context} from '@yaakapp/api'
import {parseAuthRedirect} from './parse-auth-redirect'
import {riotAuthorizeURL, valorantAuthDataDirKey} from './open-webview-popup'

/**
 * Checks if the persisted Riot login session still has valid auth data.
 */
export async function checkWebViewData(context: Context) {
    return await new Promise<ReturnType<typeof parseAuthRedirect>>(async (resolve, reject) => {
        let done = false
        let closeWindow: (() => void) | undefined = undefined

        const resolveOnce = (value: ReturnType<typeof parseAuthRedirect>) => {
            if(done) return
            done = true
            resolve(value)
        }

        const rejectOnce = (error: unknown) => {
            if(done) return
            done = true
            reject(error)
        }

        const timeout = setTimeout(() => {
            if(done) return
            rejectOnce(new Error('Timed out while checking Riot login data'))
            closeWindow?.()
        }, 15_000)

        try {
            const handle = await context.window.openUrl({
                dataDirKey: valorantAuthDataDirKey,
                label: 'valorant-riot-check-login',
                title: 'Checking Riot Login',
                url: riotAuthorizeURL,
                onNavigate: ({url}) => {
                    if(url.startsWith('https://playvalorant.com/') && url.includes('access_token')) {
                        clearTimeout(timeout)
                        try {
                            resolveOnce(parseAuthRedirect(url))
                        } catch(e) {
                            rejectOnce(e)
                        } finally {
                            closeWindow?.()
                        }
                    } else if(url.startsWith('https://authenticate.riotgames.com/')) {
                        clearTimeout(timeout)
                        rejectOnce(new Error('No login data found or login data expired'))
                        closeWindow?.()
                    }
                },
                onClose: () => {
                    clearTimeout(timeout)
                    if(!done) {
                        rejectOnce(new Error('Window closed'))
                    }
                }
            })
            closeWindow = handle.close
        } catch(e) {
            clearTimeout(timeout)
            rejectOnce(e)
        }
    })
}
