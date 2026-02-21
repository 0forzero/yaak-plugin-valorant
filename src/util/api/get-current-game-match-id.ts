import fetch from 'node-fetch'

export async function getCurrentGameMatchId(shard: string, region: string, puuid: string, clientVersion: string, clientPlatform: string, accessToken: string, entitlement: string) {
    const response = await fetch(`https://glz-${region}-1.${shard}.a.pvp.net/core-game/v1/players/${puuid}`, {
        headers: {
            'Authorization': 'Bearer ' + accessToken,
            'X-Riot-Entitlements-JWT': entitlement,
            'X-Riot-ClientVersion': clientVersion,
            'X-Riot-ClientPlatform': clientPlatform,
            'User-Agent': ''
        },
    })

    if(response.status === 404) throw new Error('Player is not in an active match (after the agent select screen)')
    if(!response.ok) throw new Error(`Failed to get current game match ID: ${response.status} ${response.statusText} - ${await response.text()}`)
    return (await response.json() as any)['MatchID'] as string
}