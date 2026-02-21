import type {Context} from '@yaakapp/api'
import {valorantAuthDataDirKey} from './open-webview-popup'

/**
 * Logs out of the Riot auth web session by opening the logout URL in a Yaak window.
 */
export async function webviewLogout(context: Context) {
    return await new Promise<void>(async (resolve, reject) => {
        let done = false
        let closeWindow: (() => void) | undefined = undefined

        const resolveOnce = () => {
            if(done) return
            done = true
            resolve()
        }

        const rejectOnce = (error: unknown) => {
            if(done) return
            done = true
            reject(error)
        }

        const timeout = setTimeout(() => {
            if(done) return
            resolveOnce()
            closeWindow?.()
        }, 15_000)

        try {
            const handle = await context.window.openUrl({
                dataDirKey: valorantAuthDataDirKey,
                label: 'valorant-riot-logout',
                title: 'Riot Logout',
                url: 'https://auth.riotgames.com/logout',
                onNavigate: ({url}) => {
                    if(url.startsWith('https://auth.riotgames.com/logout')) {
                        clearTimeout(timeout)
                        resolveOnce()
                        closeWindow?.()
                    }
                },
                onClose: () => {
                    clearTimeout(timeout)
                    if(!done) {
                        rejectOnce(new Error('Window closed before logout completed'))
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
