import type {Context} from '@yaakapp/api'
import {parseAuthRedirect} from './parse-auth-redirect'

export const riotAuthorizeURL = 'https://auth.riotgames.com/authorize?redirect_uri=https%3A%2F%2Fplayvalorant.com%2Fopt_in&client_id=play-valorant-web-prod&response_type=token%20id_token&nonce=1&scope=account%20openid'
export const valorantAuthDataDirKey = 'valorant-auth'

/**
 * Opens a popup window to sign in to Riot.
 * The promise resolves with parsed auth redirect data.
 */
export async function openWebViewPopup(context: Context) {
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

        try {
            const handle = await context.window.openUrl({
                dataDirKey: valorantAuthDataDirKey,
                label: 'valorant-riot-login',
                title: 'Riot Sign In',
                url: riotAuthorizeURL,
                onNavigate: ({url}) => {
                    if(!url.startsWith('https://playvalorant.com/') || !url.includes('access_token')) return
                    try {
                        resolveOnce(parseAuthRedirect(url))
                    } catch(e) {
                        rejectOnce(e)
                    } finally {
                        closeWindow?.()
                    }
                },
                onClose: () => {
                    if(!done) {
                        rejectOnce(new Error('Window closed'))
                    }
                }
            })
            closeWindow = handle.close
        } catch(e) {
            rejectOnce(e)
        }
    })
}
