import type {
  CallTemplateFunctionArgs,
  Context,
  PluginDefinition,
} from "@yaakapp/api";
import fetch from "node-fetch";
import logSleuth, { infoKeys, LogInfo } from "./util/log-sleuth";
import { tryInOrder, tryInOrderLabeled } from "./util/try-in-order";
import { readLockfile } from "./util/read-lockfile";
import { openWebViewPopup } from "./util/auth/open-webview-popup";
import { webviewLogout } from "./util/auth/webview-logout";
import { AuthRedirectData } from "./util/auth/parse-auth-redirect";
import { authFromRiotClient } from "./util/auth/auth-from-riot-client";
import { checkWebViewData } from "./util/auth/check-webview-data";
import { getRegion } from "./util/auth/get-region";
import { getEntitlement } from "./util/auth/get-entitlement";
import { getPregameMatchId } from "./util/api/get-pregame-match-id";
import { getCurrentGameMatchId } from "./util/api/get-current-game-match-id";
import { getPartyId } from "./util/api/get-party-id";
import { onlyOne } from "./util/only-one";
import { cacheResult } from "./util/cache-result";
import { getPASToken } from "./util/auth/get-pas-token";
import { XMPPManager } from "./xmpp/XMPPManager";
import { XMPPMITMManager } from "./xmpp/XMPPMITMManager";

interface ValorantAPIVersionResponse {
  data: {
    riotClientVersion: string;
  };
}

interface ValorantOverrides {
  clientPlatform?: string;
  clientVersion?: string;
  lockfilePort?: string;
  lockfilePassword?: string;
  puuid?: string;
  entitlement?: string;
  token?: string;
  idToken?: string;
  pasToken?: string;
  region?: string;
  shard?: string;
  pregameMatchId?: string;
  currentGameMatchId?: string;
  partyId?: string;
}

const riotAuthStoreKey = "valorant.authInfo";
const legacyStoreKeys = [
  "successfulLogin",
  "expiresAt",
  "cookies",
  "token",
  "entitlement",
  "puuid",
  "region",
];

const xmppManager = new XMPPManager();
const xmppMITMManager = new XMPPMITMManager();
const defaultClientPlatformString =
  "ew0KCSJwbGF0Zm9ybVR5cGUiOiAiUEMiLA0KCSJwbGF0Zm9ybU9TIjogIldpbmRvd3MiLA0KCSJwbGF0Zm9ybU9TVmVyc2lvbiI6ICIxMC4wLjE5MDQyLjEuMjU2LjY0Yml0IiwNCgkicGxhdGZvcm1DaGlwc2V0IjogIlVua25vd24iDQp9";

let cachedCompleteLogInfo: LogInfo | undefined = undefined;
let cachedAuthInfo:
  | (AuthRedirectData & { entitlement: string; pasToken?: string })
  | undefined = undefined;
let cachedRegionInfo: { region: string; shard: string } | undefined = undefined;
let cachedClientVersion: string | undefined = undefined;

function asNonEmptyString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const stringValue = String(value);
  if (stringValue.length === 0) return undefined;
  return stringValue;
}

function getOverrideValue(
  args: CallTemplateFunctionArgs,
  key: keyof ValorantOverrides,
): string | undefined {
  return asNonEmptyString(args.values[key]);
}

async function clearSavedData(context: Context) {
  await Promise.all(
    [...legacyStoreKeys, riotAuthStoreKey].map((key) =>
      context.store.delete(key),
    ),
  );
  cachedAuthInfo = undefined;
  cachedRegionInfo = undefined;
}

async function getStoredAuthInfo(
  context: Context,
): Promise<
  (AuthRedirectData & { entitlement?: string; pasToken?: string }) | undefined
> {
  const stored =
    await context.store.get<
      Partial<AuthRedirectData & { entitlement?: string; pasToken?: string }>
    >(riotAuthStoreKey);
  if (stored === undefined) return undefined;

  const accessToken = asNonEmptyString(stored.accessToken);
  const idToken = asNonEmptyString(stored.idToken);
  const puuid = asNonEmptyString(stored.puuid);
  const expiresAt =
    typeof stored.expiresAt === "number" ? stored.expiresAt : Number.NaN;

  if (
    accessToken === undefined ||
    idToken === undefined ||
    puuid === undefined ||
    Number.isNaN(expiresAt)
  ) {
    await context.store.delete(riotAuthStoreKey);
    return undefined;
  }

  if (expiresAt <= Date.now()) {
    await context.store.delete(riotAuthStoreKey);
    return undefined;
  }

  return {
    accessToken,
    idToken,
    puuid,
    expiresAt,
    entitlement: asNonEmptyString(stored.entitlement),
    pasToken: asNonEmptyString(stored.pasToken),
  };
}

async function setStoredAuthInfo(
  context: Context,
  authInfo: AuthRedirectData & { entitlement: string; pasToken?: string },
) {
  await context.store.set(riotAuthStoreKey, authInfo);
}

async function getOrLoadLogInfo() {
  if (cachedCompleteLogInfo !== undefined) return cachedCompleteLogInfo;

  const info = await logSleuth();
  if (!info) throw new Error("Could not find log info");
  for (const key of infoKeys) {
    if (info[key] === undefined)
      throw new Error(`Could not find log info for ${key}`);
  }
  cachedCompleteLogInfo = info as LogInfo;

  return cachedCompleteLogInfo;
}

async function getOrLoadAuthInfo(context: Context) {
  if (cachedAuthInfo !== undefined && cachedAuthInfo.expiresAt > Date.now())
    return cachedAuthInfo;

  try {
    const partialAuthInfo = await tryInOrderLabeled([
      {
        label: "Use auth from Riot Client",
        func: async () => await authFromRiotClient(),
      },
      {
        label: "Use auth from stored Riot Login workspace action",
        func: async () => {
          const stored = await getStoredAuthInfo(context);
          if (stored === undefined)
            throw new Error("No stored Riot Login auth data found");
          return {
            accessToken: stored.accessToken,
            idToken: stored.idToken,
            expiresAt: stored.expiresAt,
            puuid: stored.puuid,
          };
        },
      },
      {
        label: "Use auth from persisted login window session",
        func: async () => await checkWebViewData(context),
      },
    ]);

    cachedAuthInfo = {
      ...partialAuthInfo,
      entitlement: await getEntitlement(partialAuthInfo.accessToken),
    };
    await setStoredAuthInfo(context, cachedAuthInfo);
    return cachedAuthInfo;
  } catch (e) {
    throw new Error(
      `${e}\n\nTry logging in with the "Riot Login" workspace action`,
    );
  }
}

async function getOrLoadPASToken(context: Context): Promise<string> {
  if (
    cachedAuthInfo?.pasToken !== undefined &&
    cachedAuthInfo.expiresAt > Date.now()
  )
    return cachedAuthInfo.pasToken;

  const authInfo = await getOrLoadAuthInfo(context);
  const pasToken = await getPASToken(authInfo.accessToken);
  cachedAuthInfo = {
    ...authInfo,
    pasToken,
  };
  await setStoredAuthInfo(context, cachedAuthInfo);
  return pasToken;
}

async function getOrLoadRegionInfo(context: Context) {
  if (cachedRegionInfo !== undefined) return cachedRegionInfo;

  if (cachedCompleteLogInfo !== undefined) {
    cachedRegionInfo = {
      region: cachedCompleteLogInfo.region,
      shard: cachedCompleteLogInfo.shard,
    };
    return cachedRegionInfo;
  }

  try {
    const logInfo = await getOrLoadLogInfo();
    cachedRegionInfo = {
      region: logInfo.region,
      shard: logInfo.shard,
    };
    return cachedRegionInfo;
  } catch (logError) {
    try {
      const authInfo = await getOrLoadAuthInfo(context);
      cachedRegionInfo = await getRegion(
        authInfo.accessToken,
        authInfo.idToken,
      );
      return cachedRegionInfo;
    } catch (authError) {
      throw [logError, authError];
    }
  }
}

async function getOrLoadClientVersion() {
  if (cachedClientVersion !== undefined) return cachedClientVersion;

  cachedClientVersion = await tryInOrder([
    async () => (await getOrLoadLogInfo()).clientVersion,
    async () =>
      (
        (await (
          await fetch("https://valorant-api.com/v1/version")
        ).json()) as ValorantAPIVersionResponse
      ).data.riotClientVersion,
  ]);
  return cachedClientVersion;
}

function textOverrideArg(
  name: keyof ValorantOverrides,
  label: string,
  description: string,
) {
  return {
    type: "text" as const,
    name,
    label,
    description,
    optional: true,
  };
}

const remoteTagArgs = [
  textOverrideArg(
    "token",
    "Token Override",
    "Optional Riot auth token override",
  ),
  textOverrideArg(
    "entitlement",
    "Entitlement Override",
    "Optional Riot entitlement override",
  ),
  textOverrideArg("region", "Region Override", "Optional region override"),
  textOverrideArg("shard", "Shard Override", "Optional shard override"),
  textOverrideArg("puuid", "PUUID Override", "Optional PUUID override"),
  textOverrideArg(
    "clientVersion",
    "Client Version Override",
    "Optional client version override",
  ),
  textOverrideArg(
    "clientPlatform",
    "Client Platform Override",
    "Optional client platform override",
  ),
];

async function getRemoteCallValues(
  context: Context,
  args: CallTemplateFunctionArgs,
) {
  const token =
    getOverrideValue(args, "token") ??
    (await getOrLoadAuthInfo(context)).accessToken;
  const entitlement =
    getOverrideValue(args, "entitlement") ??
    (await getOrLoadAuthInfo(context)).entitlement;
  const region =
    getOverrideValue(args, "region") ??
    (await getOrLoadRegionInfo(context)).region;
  const shard =
    getOverrideValue(args, "shard") ??
    (await getOrLoadRegionInfo(context)).shard;
  const puuid =
    getOverrideValue(args, "puuid") ?? (await getOrLoadAuthInfo(context)).puuid;
  const clientVersion =
    getOverrideValue(args, "clientVersion") ?? (await getOrLoadClientVersion());
  const clientPlatform =
    getOverrideValue(args, "clientPlatform") ?? defaultClientPlatformString;

  return {
    token,
    entitlement,
    region,
    shard,
    puuid,
    clientVersion,
    clientPlatform,
  };
}

async function actionHandler(context: Context, handler: () => Promise<void>) {
  try {
    await handler();
  } catch (e) {
    const message = `${e}`.replace(/^Error:\s*/g, "");
    await context.toast.show({
      message,
      color: "danger",
    });
    throw e;
  }
}

const riotActions = [
  {
    label: "Remove Saved Valorant Data",
    onSelect: async (context: Context) => {
      await actionHandler(context, async () => {
        await clearSavedData(context);
        await context.toast.show({
          message: "Cleared Valorant data",
          color: "success",
        });
      });
    },
  },
  {
    label: "Riot Login",
    onSelect: async (context: Context) => {
      await actionHandler(context, async () => {
        await webviewLogout(context);
        const partialAuthInfo = await openWebViewPopup(context);
        cachedAuthInfo = {
          ...partialAuthInfo,
          entitlement: await getEntitlement(partialAuthInfo.accessToken),
        };
        await setStoredAuthInfo(context, cachedAuthInfo);
        await context.toast.show({
          message: "Riot login successful",
          color: "success",
        });
      });
    },
  },
  {
    label: "Riot Logout",
    onSelect: async (context: Context) => {
      await actionHandler(context, async () => {
        await webviewLogout(context);
        cachedAuthInfo = undefined;
        await context.store.delete(riotAuthStoreKey);
        await context.toast.show({
          message: "Riot logout complete",
          color: "success",
        });
      });
    },
  },
];

export const plugin: PluginDefinition = {
  workspaceActions: riotActions.map((action) => ({
    label: action.label,
    onSelect: async (context: Context) => {
      await action.onSelect(context);
    },
  })),
  httpRequestActions: riotActions.map((action) => ({
    label: action.label,
    onSelect: async (context: Context) => {
      await action.onSelect(context);
    },
  })),
  websocketRequestActions: riotActions.map((action) => ({
    label: action.label,
    onSelect: async (context: Context) => {
      await action.onSelect(context);
    },
  })),

  templateFunctions: [
    {
      name: "client_platform",
      description: "Valorant client platform",
      args: [
        textOverrideArg(
          "clientPlatform",
          "Client Platform Override",
          "Optional client platform override",
        ),
      ],
      onRender: onlyOne(
        async (_context: Context, args: CallTemplateFunctionArgs) => {
          const override = getOverrideValue(args, "clientPlatform");
          if (override !== undefined) return override;
          return defaultClientPlatformString;
        },
      ),
    },
    {
      name: "client_version",
      description: "Valorant client version",
      args: [
        textOverrideArg(
          "clientVersion",
          "Client Version Override",
          "Optional client version override",
        ),
      ],
      onRender: onlyOne(
        async (_context: Context, args: CallTemplateFunctionArgs) => {
          const override = getOverrideValue(args, "clientVersion");
          if (override !== undefined) return override;
          return await getOrLoadClientVersion();
        },
      ),
    },
    {
      name: "lockfile_port",
      description: "Valorant lockfile port",
      args: [
        textOverrideArg(
          "lockfilePort",
          "Lockfile Port Override",
          "Optional lockfile port override",
        ),
      ],
      onRender: onlyOne(
        async (_context: Context, args: CallTemplateFunctionArgs) => {
          const override = getOverrideValue(args, "lockfilePort");
          if (override !== undefined) return override;

          try {
            return (await readLockfile()).port;
          } catch (_e) {
            throw new Error("Lockfile not found! Is Valorant running?");
          }
        },
      ),
    },
    {
      name: "lockfile_password",
      description: "Valorant lockfile password",
      args: [
        textOverrideArg(
          "lockfilePassword",
          "Lockfile Password Override",
          "Optional lockfile password override",
        ),
      ],
      onRender: onlyOne(
        async (_context: Context, args: CallTemplateFunctionArgs) => {
          const override = getOverrideValue(args, "lockfilePassword");
          if (override !== undefined) return override;

          try {
            return (await readLockfile()).password;
          } catch (_e) {
            throw new Error("Lockfile not found! Is Valorant running?");
          }
        },
      ),
    },
    {
      name: "puuid",
      description: "Valorant PUUID",
      args: [
        textOverrideArg("puuid", "PUUID Override", "Optional PUUID override"),
      ],
      onRender: onlyOne(
        async (context: Context, args: CallTemplateFunctionArgs) => {
          const override = getOverrideValue(args, "puuid");
          if (override !== undefined) return override;

          if (cachedAuthInfo !== undefined) return cachedAuthInfo.puuid;
          if (cachedCompleteLogInfo !== undefined)
            return cachedCompleteLogInfo.puuid;

          return await tryInOrderLabeled([
            {
              label: "Use puuid from log file scraping",
              func: async () => (await getOrLoadLogInfo()).puuid,
            },
            {
              label: "Use puuid from auth info",
              func: async () => (await getOrLoadAuthInfo(context)).puuid,
            },
          ]);
        },
      ),
    },
    {
      name: "valorant_region",
      description: "Valorant account region",
      args: [
        textOverrideArg(
          "region",
          "Region Override",
          "Optional region override",
        ),
      ],
      onRender: onlyOne(
        async (context: Context, args: CallTemplateFunctionArgs) => {
          const override = getOverrideValue(args, "region");
          if (override !== undefined) return override;
          if (cachedRegionInfo !== undefined) return cachedRegionInfo.region;
          return (await getOrLoadRegionInfo(context)).region;
        },
      ),
    },
    {
      name: "valorant_shard",
      description: "Valorant account shard",
      args: [
        textOverrideArg("shard", "Shard Override", "Optional shard override"),
      ],
      onRender: onlyOne(
        async (context: Context, args: CallTemplateFunctionArgs) => {
          const override = getOverrideValue(args, "shard");
          if (override !== undefined) return override;
          if (cachedRegionInfo !== undefined) return cachedRegionInfo.shard;
          return (await getOrLoadRegionInfo(context)).shard;
        },
      ),
    },
    {
      name: "valorant_token",
      description: "Valorant auth token",
      args: [
        textOverrideArg(
          "token",
          "Token Override",
          "Optional Riot auth token override",
        ),
      ],
      onRender: onlyOne(
        async (context: Context, args: CallTemplateFunctionArgs) => {
          const override = getOverrideValue(args, "token");
          if (override !== undefined) return override;
          return (await getOrLoadAuthInfo(context)).accessToken;
        },
      ),
    },
    {
      name: "valorant_entitlement",
      description: "Valorant entitlement token",
      args: [
        textOverrideArg(
          "entitlement",
          "Entitlement Override",
          "Optional Riot entitlement override",
        ),
      ],
      onRender: onlyOne(
        async (context: Context, args: CallTemplateFunctionArgs) => {
          const override = getOverrideValue(args, "entitlement");
          if (override !== undefined) return override;
          return (await getOrLoadAuthInfo(context)).entitlement;
        },
      ),
    },
    {
      name: "valorant_id_token",
      description: "Valorant ID token",
      args: [
        textOverrideArg(
          "idToken",
          "ID Token Override",
          "Optional Riot ID token override",
        ),
      ],
      onRender: onlyOne(
        async (context: Context, args: CallTemplateFunctionArgs) => {
          const override = getOverrideValue(args, "idToken");
          if (override !== undefined) return override;
          return (await getOrLoadAuthInfo(context)).idToken;
        },
      ),
    },
    {
      name: "valorant_pas_token",
      description: "Valorant PAS token",
      args: [
        textOverrideArg(
          "pasToken",
          "PAS Token Override",
          "Optional Riot PAS token override",
        ),
      ],
      onRender: onlyOne(
        async (context: Context, args: CallTemplateFunctionArgs) => {
          const override = getOverrideValue(args, "pasToken");
          if (override !== undefined) return override;
          return await getOrLoadPASToken(context);
        },
      ),
    },
    {
      name: "pregame_match_id",
      description: "Valorant pre-game match ID",
      args: [
        textOverrideArg(
          "pregameMatchId",
          "Pre-Game Match ID Override",
          "Optional pre-game match ID override",
        ),
        ...remoteTagArgs,
      ],
      onRender: cacheResult(
        1_000,
        onlyOne(async (context: Context, args: CallTemplateFunctionArgs) => {
          const override = getOverrideValue(args, "pregameMatchId");
          if (override !== undefined) return override;

          const values = await getRemoteCallValues(context, args);
          return await getPregameMatchId(
            values.shard,
            values.region,
            values.puuid,
            values.clientVersion,
            values.clientPlatform,
            values.token,
            values.entitlement,
          );
        }),
      ),
    },
    {
      name: "current_game_match_id",
      description: "Valorant current game match ID",
      args: [
        textOverrideArg(
          "currentGameMatchId",
          "Current Game Match ID Override",
          "Optional current game match ID override",
        ),
        ...remoteTagArgs,
      ],
      onRender: cacheResult(
        1_000,
        onlyOne(async (context: Context, args: CallTemplateFunctionArgs) => {
          const override = getOverrideValue(args, "currentGameMatchId");
          if (override !== undefined) return override;

          const values = await getRemoteCallValues(context, args);
          return await getCurrentGameMatchId(
            values.shard,
            values.region,
            values.puuid,
            values.clientVersion,
            values.clientPlatform,
            values.token,
            values.entitlement,
          );
        }),
      ),
    },
    {
      name: "party_id",
      description: "Valorant party ID",
      args: [
        textOverrideArg(
          "partyId",
          "Party ID Override",
          "Optional party ID override",
        ),
        ...remoteTagArgs,
      ],
      onRender: cacheResult(
        1_000,
        onlyOne(async (context: Context, args: CallTemplateFunctionArgs) => {
          const override = getOverrideValue(args, "partyId");
          if (override !== undefined) return override;

          const values = await getRemoteCallValues(context, args);
          return await getPartyId(
            values.shard,
            values.region,
            values.puuid,
            values.clientVersion,
            values.clientPlatform,
            values.token,
            values.entitlement,
          );
        }),
      ),
    },
    {
      name: "xmpp_websocket_url",
      aliases: ["riot_xmpp"],
      description: "Riot XMPP websocket URL",
      args: [],
      onRender: onlyOne(async () => {
        return await xmppManager.getWebsocketURL();
      }),
    },
    {
      name: "xmpp_mitm_websocket_url",
      aliases: ["riot_xmpp_mitm"],
      description: "Riot XMPP MITM websocket URL",
      args: [],
      onRender: onlyOne(async () => {
        return await xmppMITMManager.getWebsocketURL();
      }),
    },
  ],
};
